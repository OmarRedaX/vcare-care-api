/* eslint-disable @typescript-eslint/unbound-method */
import "reflect-metadata";
import type { Request, Response } from "express";
import { AdminDoctorsController } from "../../../../src/app/admin-doctors/controller/admin-doctors.controller";
import { IdentityUnavailable } from "../../../../src/app/admin-doctors/errors";
import type { AdminDoctorsService } from "../../../../src/app/admin-doctors/service/admin-doctors.service";
import { IdentitySyncStatus } from "../../../../src/app/doctors/enums";
import type { AppError } from "../../../../src/lib/error/AppError";
import type { AuthContext } from "../../../../src/lib/types/types";

const admin = { userId: 303, role: "admin", status: "active", emailVerified: true } as AuthContext;
const at = new Date("2026-10-09T10:00:00.000Z");
const suspensionView = (status: IdentitySyncStatus) => ({ doctorUserId: 202, suspendedAt: at, identitySyncStatus: status, flaggedConsultationIds: [11] });

function harness() {
    const service = { suspend: jest.fn(), reinstate: jest.fn() };
    const controller = new AdminDoctorsController(service as unknown as AdminDoctorsService);
    const json = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json } as unknown as Response;
    const req = (body: unknown, doctorUserId = "202", auth: AuthContext | null = admin) => ({ params: { doctorUserId }, body, auth: auth ?? undefined }) as unknown as Request;
    return { service, controller, res, json, req };
}

describe("AdminDoctorsController.suspend", () => {
    it("should send 200 with the SuspensionResult when Identity confirmed", async () => {
        const { service, controller, res, json, req } = harness();
        service.suspend.mockResolvedValue({ view: suspensionView(IdentitySyncStatus.Synced), confirmed: true });
        await controller.suspend(req({ reason: "synthetic reason" }), res);
        expect(service.suspend).toHaveBeenCalledWith(admin, 202, "synthetic reason");
        expect(res.status).toHaveBeenCalledWith(200);
        expect(json).toHaveBeenCalledWith({ success: true, data: { doctorUserId: 202, suspendedAt: "2026-10-09T10:00:00.000Z", identitySyncStatus: "synced", flaggedConsultationIds: [11] } });
    });

    it.each([IdentitySyncStatus.Pending, IdentitySyncStatus.Failed])("should throw IdentityUnavailable with the suspension marker and data when the sync is %s", async (status) => {
        const { service, controller, res, json, req } = harness();
        service.suspend.mockResolvedValue({ view: suspensionView(status), confirmed: false });
        const error = await controller.suspend(req({ reason: "synthetic reason" }), res).then(() => undefined, (failure: AppError) => failure);
        expect(error).toMatchObject({ code: "IdentityUnavailable", status: 503, extra: { suspension: "applied-locally, session-revocation-pending",
            data: { doctorUserId: 202, suspendedAt: "2026-10-09T10:00:00.000Z", identitySyncStatus: status, flaggedConsultationIds: [11] } } });
        expect(json).not.toHaveBeenCalled();
    });

    it("should not mutate the shared IdentityUnavailable constant", async () => {
        const { service, controller, res, req } = harness();
        service.suspend.mockResolvedValue({ view: suspensionView(IdentitySyncStatus.Pending), confirmed: false });
        await controller.suspend(req({ reason: "synthetic reason" }), res).catch(() => undefined);
        expect(IdentityUnavailable.extra).toBeUndefined();
    });

    it.each([[{ reason: "ab" }], [{ reason: "valid reason", extra: 1 }], [{}]])("should reject an invalid body %j before calling the service", async (body) => {
        const { service, controller, res, req } = harness();
        await expect(controller.suspend(req(body), res)).rejects.toMatchObject({ code: "ValidationFailed" });
        expect(service.suspend).not.toHaveBeenCalled();
    });

    it.each(["0", "abc", "-4"])("should reject the path id %j before calling the service", async (id) => {
        const { service, controller, res, req } = harness();
        await expect(controller.suspend(req({ reason: "valid reason" }, id), res)).rejects.toMatchObject({ code: "ValidationFailed" });
        expect(service.suspend).not.toHaveBeenCalled();
    });

    it("should throw Unauthorized without a verified principal", async () => {
        const { service, controller, res, req } = harness();
        await expect(controller.suspend(req({ reason: "valid reason" }, "202", null), res)).rejects.toMatchObject({ code: "Unauthorized" });
        expect(service.suspend).not.toHaveBeenCalled();
    });
});

describe("AdminDoctorsController.reinstate", () => {
    const view = (status: IdentitySyncStatus) => ({ doctorUserId: 202, reinstatedAt: at, identitySyncStatus: status });

    it("should send 200 with the ReinstatementResult when confirmed", async () => {
        const { service, controller, res, json, req } = harness();
        service.reinstate.mockResolvedValue({ view: view(IdentitySyncStatus.Synced), status: 200 });
        await controller.reinstate(req({ reason: "synthetic reason" }), res);
        expect(service.reinstate).toHaveBeenCalledWith(admin, 202, "synthetic reason");
        expect(res.status).toHaveBeenCalledWith(200);
        expect(json).toHaveBeenCalledWith({ success: true, data: { doctorUserId: 202, reinstatedAt: "2026-10-09T10:00:00.000Z", identitySyncStatus: "synced" } });
    });

    it.each(["pending", "failed"] as const)("should send 202 with the identitySync %s sibling next to data", async (identitySync) => {
        const { service, controller, res, json, req } = harness();
        service.reinstate.mockResolvedValue({ view: view(identitySync as IdentitySyncStatus), status: 202, identitySync });
        await controller.reinstate(req({ reason: "synthetic reason" }), res);
        expect(res.status).toHaveBeenCalledWith(202);
        expect(json).toHaveBeenCalledWith({ identitySync, success: true, data: { doctorUserId: 202, reinstatedAt: "2026-10-09T10:00:00.000Z", identitySyncStatus: identitySync } });
    });

    it("should reject an invalid body before calling the service", async () => {
        const { service, controller, res, req } = harness();
        await expect(controller.reinstate(req({ reason: "x" }), res)).rejects.toMatchObject({ code: "ValidationFailed" });
        expect(service.reinstate).not.toHaveBeenCalled();
    });
});
