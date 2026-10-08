import { Router } from "express";
import { userGuard } from "../../lib/auth/user-guard";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { sealRouter } from "../../lib/http/route-pattern";
import { noStore } from "../../lib/http/no-store";
import { idempotency } from "../../lib/idempotency/idempotency";
import { rateLimit } from "../../lib/rate-limit/rate-limit";
import { byUser } from "../../lib/rate-limit/subjects";
import { authorize } from "../../lib/rbac/authorize";
import type { VerificationController } from "./controller/verification.controller";
import { buildVerificationPolicies } from "./policies";

export function buildVerificationRouter(): Router {
    const router = Router();
    const ctrl = container.resolve<VerificationController>(TOKENS.VerificationController);
    const p = buildVerificationPolicies();
    const adminLimit = () => rateLimit({ name: "verification-admin", limit: 120, windowMs: 60_000, subject: byUser });
    const readLimit = () => rateLimit({ name: "verification-doctor-read", limit: 120, windowMs: 60_000, subject: byUser });
    const writeLimit = () => rateLimit({ name: "verification-doctor-write", limit: 20, windowMs: 60_000, subject: byUser });
    const intentLimit = () => rateLimit({ name: "verification-intent", limit: 20, windowMs: 3_600_000, subject: byUser });
    // No idempotency on routes that return signed URLs or POST policies: Redis must never store them, and each issue needs its own audit row.
    const key = () => idempotency({ required: false });
    router.use(noStore());
    router.post("/doctors/me/documents/uploads", userGuard(), authorize(p.createIntent), intentLimit(), ctrl.createIntent);
    router.post("/doctors/me/documents/uploads/:uploadId/complete", userGuard(), authorize(p.complete), writeLimit(), key(), ctrl.complete);
    router.post("/doctors/me/documents/:documentId/download-url", userGuard(), authorize(p.myDownload), readLimit(), ctrl.myDownload);
    router.delete("/doctors/me/documents/:documentId", userGuard(), authorize(p.myDelete), writeLimit(), key(), ctrl.myDelete);
    router.get("/admin/applications", userGuard(), authorize(p.queue), adminLimit(), ctrl.queue);
    router.get("/admin/applications/:id", userGuard(), authorize(p.detail), adminLimit(), ctrl.detail);
    router.post("/admin/applications/:id/documents/:documentId/download-url", userGuard(), authorize(p.adminDownload), adminLimit(), ctrl.adminDownload);
    router.patch("/admin/applications/:id/approve", userGuard(), authorize(p.approve), adminLimit(), key(), ctrl.approve);
    router.patch("/admin/applications/:id/reject", userGuard(), authorize(p.reject), adminLimit(), key(), ctrl.reject);
    router.patch("/admin/applications/:id/reopen", userGuard(), authorize(p.reopen), adminLimit(), key(), ctrl.reopen);
    return sealRouter(router);
}
