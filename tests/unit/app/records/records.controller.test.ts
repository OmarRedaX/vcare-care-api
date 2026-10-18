import "reflect-metadata";
import type { Request, Response } from "express";
import { RecordsController } from "../../../../src/app/records/controller/records.controller";
import type { AppError } from "../../../../src/lib/error/AppError";
import type { AuthContext } from "../../../../src/lib/types/types";
import { admin, amendmentEntity, CHIEF, doctor, patient, PLAN, REASON, recordEntity } from "./records.fixtures";

function setup() {
    const commands = { create: jest.fn(), update: jest.fn() };
    const queries = { get: jest.fn(), timeline: jest.fn() };
    const controller = new RecordsController(commands as never, queries as never);
    const json = jest.fn();
    const status = jest.fn().mockReturnThis();
    const res = { status, json } as unknown as Response;
    const req = (auth: AuthContext | undefined, parts: { params?: Record<string, string>; body?: unknown; query?: Record<string, unknown> } = {}): Request =>
        ({ auth, params: parts.params ?? {}, body: parts.body ?? {}, query: parts.query ?? {} }) as unknown as Request;
    return { controller, commands, queries, res, json, status, req };
}

const rejection = async (run: () => Promise<unknown>): Promise<AppError> => {
    try { await run(); } catch (error) { return error as AppError; }
    throw new Error("expected a rejection");
};

describe("RecordsController", () => {
    it("should answer 201 with the rendered record and an empty amendment list on create, passing the validated input to the service", async () => {
        const { controller, commands, res, json, status, req } = setup();
        commands.create.mockResolvedValue(recordEntity());
        await controller.create(req(doctor, { params: { id: "7" }, body: { chiefComplaint: CHIEF } }), res);
        expect(commands.create).toHaveBeenCalledWith(doctor, 7, { chiefComplaint: CHIEF });
        expect(status).toHaveBeenCalledWith(201);
        expect(json.mock.calls[0]?.[0]).toMatchObject({ success: true, data: { id: 9, chiefComplaint: CHIEF, amendments: [], attachments: [], isLocked: false } });
    });

    it.each([["abc"], ["0"], ["-1"], ["1.5"]])("should answer NotFound for the path id %j before touching the body or the service", async (id) => {
        const { controller, commands, queries, res, req } = setup();
        for (const run of [
            () => controller.create(req(doctor, { params: { id }, body: { chiefComplaint: CHIEF } }), res),
            () => controller.update(req(doctor, { params: { id }, body: { treatmentPlan: PLAN } }), res),
            () => controller.get(req(patient, { params: { id } }), res),
            () => controller.timeline(req(patient, { params: { patientUserId: id } }), res),
        ]) expect((await rejection(run)).code).toBe("NotFound");
        expect(commands.create).not.toHaveBeenCalled();
        expect(commands.update).not.toHaveBeenCalled();
        expect(queries.get).not.toHaveBeenCalled();
        expect(queries.timeline).not.toHaveBeenCalled();
    });

    it("should answer ValidationFailed with the offending field and not call the service when the create body is invalid", async () => {
        const { controller, commands, res, req } = setup();
        const err = await rejection(() => controller.create(req(doctor, { params: { id: "7" }, body: { chiefComplaint: "ab" } }), res));
        expect([err.code, err.details.map((detail) => detail.field)]).toEqual(["ValidationFailed", ["chiefComplaint"]]);
        expect(commands.create).not.toHaveBeenCalled();
    });

    it.each([[{}], [{ reason: REASON }]])("should reject the patch body %j with EmptyRecordUpdate before any service call", async (body) => {
        const { controller, commands, res, req } = setup();
        const err = await rejection(() => controller.update(req(doctor, { params: { id: "9" }, body }), res));
        expect([err.code, err.status, err.details]).toEqual(["ValidationFailed", 400, [{ field: "body", issue: "must contain at least one record field" }]]);
        expect(commands.update).not.toHaveBeenCalled();
    });

    it("should answer 200 with the current record for an in-place update and for the pre-lock no-op", async () => {
        const { controller, commands, res, json, status, req } = setup();
        for (const kind of ["updated", "unchanged"] as const) {
            commands.update.mockResolvedValue({ kind, record: recordEntity() });
            await controller.update(req(doctor, { params: { id: "9" }, body: { treatmentPlan: PLAN, reason: REASON } }), res);
        }
        expect(commands.update).toHaveBeenCalledWith(doctor, 9, { changes: { treatmentPlan: PLAN }, reason: REASON });
        expect(status.mock.calls).toEqual([[200], [200]]);
        expect(json.mock.calls.map(([body]) => body.data.amendments)).toEqual([[], []]);
    });

    it("should answer 201 with the amendment, not the record, after the lock", async () => {
        const { controller, commands, res, json, status, req } = setup();
        commands.update.mockResolvedValue({ kind: "amended", amendment: amendmentEntity() });
        await controller.update(req(doctor, { params: { id: "9" }, body: { treatmentPlan: PLAN, reason: REASON } }), res);
        expect(status).toHaveBeenCalledWith(201);
        const data = json.mock.calls[0]?.[0].data;
        expect(data).toMatchObject({ id: 31, recordId: 9, reason: REASON });
        expect(data).not.toHaveProperty("amendments");
    });

    it("should reject any query member on the read of one record before the service is called", async () => {
        const { controller, queries, res, req } = setup();
        const err = await rejection(() => controller.get(req(patient, { params: { id: "9" }, query: { expand: "1" } }), res));
        expect(err.code).toBe("ValidationFailed");
        expect(queries.get).not.toHaveBeenCalled();
    });

    it("should render the read of one record with its amendments for the viewer", async () => {
        const { controller, queries, res, json, status, req } = setup();
        queries.get.mockResolvedValue({ record: recordEntity({ isLocked: true }), amendments: [amendmentEntity()] });
        await controller.get(req(patient, { params: { id: "9" } }), res);
        expect(queries.get).toHaveBeenCalledWith(patient, 9);
        expect(status).toHaveBeenCalledWith(200);
        expect(json.mock.calls[0]?.[0].data.amendments).toHaveLength(1);
    });

    it("should pass the validated cursor and limit to the timeline, answer 200 with the page meta and nothing else in meta", async () => {
        const { controller, queries, res, json, req } = setup();
        queries.timeline.mockResolvedValue({ patient: null, items: [{ record: recordEntity(), amendments: [] }], meta: { nextCursor: null, hasMore: false, count: 1 } });
        await controller.timeline(req(doctor, { params: { patientUserId: "101" }, query: { limit: "5", cursor: "abc" } }), res);
        expect(queries.timeline).toHaveBeenCalledWith(doctor, 101, { cursor: "abc", limit: 5 });
        expect(json.mock.calls[0]?.[0]).toMatchObject({ success: true, data: { patient: null, records: [{ id: 9 }] }, meta: { nextCursor: null, hasMore: false, count: 1 } });
    });

    it("should reject a bad timeline limit before the service is called", async () => {
        const { controller, queries, res, req } = setup();
        const err = await rejection(() => controller.timeline(req(doctor, { params: { patientUserId: "101" }, query: { limit: "101" } }), res));
        expect(err.details.map((detail) => detail.field)).toEqual(["limit"]);
        expect(queries.timeline).not.toHaveBeenCalled();
    });

    it("should answer Unauthorized when no verified principal is attached", async () => {
        const { controller, res, req } = setup();
        expect((await rejection(() => controller.get(req(undefined, { params: { id: "9" } }), res))).code).toBe("Unauthorized");
    });

    it("should hand the admin principal to the response DTO, which refuses it, if a policy bug ever let one through", async () => {
        const { controller, queries, res, req } = setup();
        queries.get.mockResolvedValue({ record: recordEntity(), amendments: [] });
        await expect(controller.get(req(admin, { params: { id: "9" } }), res)).rejects.toThrow("medical_record_viewer_not_permitted");
    });
});
