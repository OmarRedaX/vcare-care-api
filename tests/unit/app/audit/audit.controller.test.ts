import "reflect-metadata";
import express from "express";
import request from "supertest";
import { AuditController } from "../../../../src/app/audit/controller/audit.controller";
import { AuditLog } from "../../../../src/app/audit/entity/audit-log.entity";
import type { AuditService } from "../../../../src/app/audit/service/audit.service";
import { errorHandler } from "../../../../src/lib/error/errorHandler";
import { ValidationFailed } from "../../../../src/lib/error/errors";
import { requestId } from "../../../../src/lib/request-id/request-id";

const entry = new AuditLog({
    id: 9, actorUserId: 303, actorRole: "admin", action: "doctor.approved", entityType: "doctor_profile", entityId: 21, requestId: null,
    metadata: { fromStatus: "submitted" }, createdAt: new Date("2026-04-15T11:59:59.123Z"),
});

function harness() {
    const service = { list: jest.fn() };
    const controller = new AuditController(service as unknown as AuditService);
    const app = express();
    app.use(requestId());
    app.get("/api/audit-logs", controller.list);
    app.use(errorHandler);
    return { service, app };
}

describe("AuditController.list", () => {
    it("should validate the query, call the service once with it, and send the page with meta", async () => {
        const { service, app } = harness();
        service.list.mockResolvedValue({ items: [entry], meta: { nextCursor: "c.m", hasMore: true, count: 1 } });
        const res = await request(app).get("/api/audit-logs?actorUserId=303&limit=1&from=2026-04-01T00:00:00Z");
        expect(res.status).toBe(200);
        expect(service.list).toHaveBeenCalledTimes(1);
        expect(service.list.mock.calls[0]?.[0]).toMatchObject({ actorUserId: 303, limit: 1, from: "2026-04-01T00:00:00Z" });
        expect(res.body).toEqual({
            success: true,
            data: [{ id: 9, actorUserId: 303, actorRole: "admin", action: "doctor.approved", entityType: "doctor_profile", entityId: 21, requestId: null, metadata: { fromStatus: "submitted" }, createdAt: "2026-04-15T11:59:59.123Z" }],
            meta: { nextCursor: "c.m", hasMore: true, count: 1 },
        });
    });

    it.each(["foo=1", "limit=0", "entityId=abc", "from=2026-04-01"])("should answer 400 and not call the service for %s", async (query) => {
        const { service, app } = harness();
        const res = await request(app).get(`/api/audit-logs?${query}`);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("ValidationFailed");
        expect(service.list).not.toHaveBeenCalled();
    });

    it("should answer 400 with the service's cross-field details", async () => {
        const { service, app } = harness();
        service.list.mockRejectedValue(ValidationFailed.withDetails([{ field: "entityType", issue: "is required when entityId is given" }]));
        const res = await request(app).get("/api/audit-logs?entityId=5");
        expect(res.status).toBe(400);
        expect(res.body.error.details).toEqual([{ field: "entityType", issue: "is required when entityId is given" }]);
        expect(res.body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("should answer 500 InternalError with the envelope and no stack or internals when the repository fails", async () => {
        const { service, app } = harness();
        service.list.mockRejectedValue(new Error("select * from audit_logs where actor_user_id = 8675309 - connection terminated"));
        const res = await request(app).get("/api/audit-logs?actorUserId=8675309");
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe("InternalError");
        expect(res.body.success).toBe(false);
        const text = JSON.stringify(res.body);
        expect(text).not.toContain("audit_logs");
        expect(text).not.toContain("8675309");
        expect(text).not.toContain("stack");
        expect(text).not.toContain("connection terminated");
    });

    it("should answer 500 and not echo a statement_timeout cancellation", async () => {
        const { service, app } = harness();
        service.list.mockRejectedValue(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }));
        const res = await request(app).get("/api/audit-logs");
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe("InternalError");
        expect(JSON.stringify(res.body)).not.toContain("statement timeout");
    });
});
