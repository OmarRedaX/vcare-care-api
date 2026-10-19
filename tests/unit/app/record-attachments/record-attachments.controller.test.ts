import "reflect-metadata";
import type { Request, Response } from "express";
import { RecordAttachmentsController } from "../../../../src/app/record-attachments/controller/record-attachments.controller";
import type { AppError } from "../../../../src/lib/error/AppError";
import type { AuthContext } from "../../../../src/lib/types/types";
import { ATTACH_DESC, attachmentEntity, author, OBJECT_KEY } from "./record-attachments.fixtures";

function setup() {
    const commands = { createIntent: jest.fn(), complete: jest.fn(), downloadUrl: jest.fn(), remove: jest.fn() };
    const controller = new RecordAttachmentsController(commands as never);
    const json = jest.fn();
    const end = jest.fn();
    const status = jest.fn().mockReturnThis();
    const res = { status, json, end } as unknown as Response;
    const req = (auth: AuthContext | undefined, parts: { params?: Record<string, string>; body?: unknown } = {}): Request =>
        ({ auth, params: parts.params ?? {}, body: parts.body ?? {} }) as unknown as Request;
    return { controller, commands, res, json, end, status, req };
}

const rejection = async (run: () => Promise<unknown>): Promise<AppError> => {
    try { await run(); } catch (error) { return error as AppError; }
    throw new Error("expected a rejection");
};

describe("RecordAttachmentsController.createIntent", () => {
    it("should answer 201 with the intent returned by the service and pass the validated description on", async () => {
        const { controller, commands, res, json, status, req } = setup();
        const intent = { uploadId: 5, url: "https://storage.test/u", fields: { key: "k" }, expiresAt: "2030-01-01T10:15:00.000Z", maxBytes: 10_485_760 };
        commands.createIntent.mockResolvedValue(intent);
        await controller.createIntent(req(author, { params: { id: "9" }, body: { description: ATTACH_DESC } }), res);
        expect(commands.createIntent).toHaveBeenCalledWith(author, 9, { attachmentDescription: ATTACH_DESC });
        expect(status).toHaveBeenCalledWith(201);
        expect(json).toHaveBeenCalledWith({ success: true, data: intent });
    });

    it("should treat an absent body as an empty one", async () => {
        const { controller, commands, res, req } = setup();
        commands.createIntent.mockResolvedValue({});
        await controller.createIntent({ ...req(author, { params: { id: "9" } }), body: undefined } as Request, res);
        expect(commands.createIntent).toHaveBeenCalledWith(author, 9, { attachmentDescription: null });
    });

    it("should answer ValidationFailed with the field name only and not call the service when the body is invalid", async () => {
        const { controller, commands, res, req } = setup();
        const err = await rejection(() => controller.createIntent(req(author, { params: { id: "9" }, body: { description: `${ATTACH_DESC}\u0000` } }), res));
        expect(err.code).toBe("ValidationFailed");
        expect(err.details.map((detail) => detail.field)).toEqual(["description"]);
        expect(JSON.stringify(err.details)).not.toContain(ATTACH_DESC);
        expect(commands.createIntent).not.toHaveBeenCalled();
    });

    it.each(["abc", "0", "-1", "1.5"])("should answer NotFound for the record id %j before validating the body or calling the service", async (id) => {
        const { controller, commands, res, req } = setup();
        expect((await rejection(() => controller.createIntent(req(author, { params: { id }, body: { unknown: 1 } }), res))).code).toBe("NotFound");
        expect(commands.createIntent).not.toHaveBeenCalled();
    });

    it("should answer Unauthorized when no principal is set", async () => {
        const { controller, commands, res, req } = setup();
        expect((await rejection(() => controller.createIntent(req(undefined, { params: { id: "9" } }), res))).code).toBe("Unauthorized");
        expect(commands.createIntent).not.toHaveBeenCalled();
    });
});

describe("RecordAttachmentsController.complete", () => {
    it("should answer 201 with the metadata DTO for a new attachment and 200 for a replay", async () => {
        const { controller, commands, res, json, status, req } = setup();
        commands.complete.mockResolvedValueOnce({ attachment: attachmentEntity(), replay: false }).mockResolvedValueOnce({ attachment: attachmentEntity(), replay: true });
        await controller.complete(req(author, { params: { id: "9", uploadId: "5" } }), res);
        await controller.complete(req(author, { params: { id: "9", uploadId: "5" } }), res);
        expect(commands.complete).toHaveBeenCalledWith(author, 9, 5);
        expect(status.mock.calls.map(([code]) => code as number)).toEqual([201, 200]);
        const data = (json.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
        expect(Object.keys(data)).toEqual(["id", "recordId", "fileType", "sizeBytes", "description", "createdAt"]);
        expect(JSON.stringify(json.mock.calls)).not.toContain(OBJECT_KEY);
    });

    it.each([["abc", "5"], ["9", "abc"], ["0", "5"], ["9", "-2"], ["9", "1.5"]])("should answer NotFound for the path ids (%j, %j) without calling the service", async (id, uploadId) => {
        const { controller, commands, res, req } = setup();
        expect((await rejection(() => controller.complete(req(author, { params: { id, uploadId } }), res))).code).toBe("NotFound");
        expect(commands.complete).not.toHaveBeenCalled();
    });

    it("should answer ValidationFailed when the request carries a body and not call the service", async () => {
        const { controller, commands, res, req } = setup();
        const err = await rejection(() => controller.complete(req(author, { params: { id: "9", uploadId: "5" }, body: { fileType: "application/pdf" } }), res));
        expect(err.code).toBe("ValidationFailed");
        expect(err.details).toEqual([{ field: "fileType", issue: "is not allowed" }]);
        expect(commands.complete).not.toHaveBeenCalled();
    });

    it("should propagate a service error unchanged", async () => {
        const { controller, commands, res, req } = setup();
        const boom = new Error("storage down");
        commands.complete.mockRejectedValue(boom);
        await expect(controller.complete(req(author, { params: { id: "9", uploadId: "5" } }), res)).rejects.toBe(boom);
    });
});

describe("RecordAttachmentsController.downloadUrl", () => {
    it("should answer 200 with the url and expiry the service returned and nothing else", async () => {
        const { controller, commands, res, json, status, req } = setup();
        const issued = { url: "https://storage.test/d", expiresAt: "2030-01-01T10:01:00.000Z" };
        commands.downloadUrl.mockResolvedValue(issued);
        await controller.downloadUrl(req(author, { params: { id: "9", attachmentId: "41" } }), res);
        expect(commands.downloadUrl).toHaveBeenCalledWith(author, 9, 41);
        expect(status).toHaveBeenCalledWith(200);
        expect(json).toHaveBeenCalledWith({ success: true, data: issued });
    });

    it.each([["abc", "41"], ["9", "abc"], ["9", "uploads"], ["9", "0"]])("should answer NotFound for the path ids (%j, %j)", async (id, attachmentId) => {
        const { controller, commands, res, req } = setup();
        expect((await rejection(() => controller.downloadUrl(req(author, { params: { id, attachmentId } }), res))).code).toBe("NotFound");
        expect(commands.downloadUrl).not.toHaveBeenCalled();
    });

    it("should answer ValidationFailed when the request carries a body", async () => {
        const { controller, commands, res, req } = setup();
        expect((await rejection(() => controller.downloadUrl(req(author, { params: { id: "9", attachmentId: "41" }, body: { x: 1 } }), res))).code).toBe("ValidationFailed");
        expect(commands.downloadUrl).not.toHaveBeenCalled();
    });
});

describe("RecordAttachmentsController.remove", () => {
    it("should answer 204 with no body after the service removed the attachment", async () => {
        const { controller, commands, res, json, end, status, req } = setup();
        commands.remove.mockResolvedValue(undefined);
        await controller.remove(req(author, { params: { id: "9", attachmentId: "41" } }), res);
        expect(commands.remove).toHaveBeenCalledWith(author, 9, 41);
        expect(status).toHaveBeenCalledWith(204);
        expect(end).toHaveBeenCalledTimes(1);
        expect(json).not.toHaveBeenCalled();
    });

    it("should answer NotFound for DELETE .../attachments/uploads (the literal reaches the route as attachmentId) without calling the service", async () => {
        const { controller, commands, res, req } = setup();
        expect((await rejection(() => controller.remove(req(author, { params: { id: "9", attachmentId: "uploads" } }), res))).code).toBe("NotFound");
        expect(commands.remove).not.toHaveBeenCalled();
    });

    it.each([["abc", "41"], ["9", "abc"], ["0", "41"], ["9", "-1"]])("should answer NotFound for the path ids (%j, %j)", async (id, attachmentId) => {
        const { controller, commands, res, req } = setup();
        expect((await rejection(() => controller.remove(req(author, { params: { id, attachmentId } }), res))).code).toBe("NotFound");
        expect(commands.remove).not.toHaveBeenCalled();
    });

    it("should answer ValidationFailed when the request carries a body", async () => {
        const { controller, commands, res, req } = setup();
        expect((await rejection(() => controller.remove(req(author, { params: { id: "9", attachmentId: "41" }, body: { reason: "x" } }), res))).code).toBe("ValidationFailed");
        expect(commands.remove).not.toHaveBeenCalled();
    });

    it("should propagate RecordLocked from the service unchanged", async () => {
        const { controller, commands, res, req } = setup();
        const locked = new Error("RecordLocked");
        commands.remove.mockRejectedValue(locked);
        await expect(controller.remove(req(author, { params: { id: "9", attachmentId: "41" } }), res)).rejects.toBe(locked);
    });
});
