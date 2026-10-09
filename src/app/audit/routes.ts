import { Router } from "express";
import { userGuard } from "../../lib/auth/user-guard";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { noStore } from "../../lib/http/no-store";
import { sealRouter } from "../../lib/http/route-pattern";
import { rateLimit } from "../../lib/rate-limit/rate-limit";
import { byUser } from "../../lib/rate-limit/subjects";
import { authorize } from "../../lib/rbac/authorize";
import { AUDIT_READ_LIMIT, AUDIT_READ_RATE_NAME, AUDIT_READ_WINDOW_MS } from "./constants";
import type { AuditController } from "./controller/audit.controller";
import { AUDIT_POLICIES } from "./policies";

export function buildAuditRouter(): Router {
    const router = Router();
    const controller = container.resolve<AuditController>(TOKENS.AuditController);
    // Per admin, after `authorize` (the subject needs the verified principal); an unauthenticated caller never reaches the database.
    const readLimit = () => rateLimit({ name: AUDIT_READ_RATE_NAME, limit: AUDIT_READ_LIMIT, windowMs: AUDIT_READ_WINDOW_MS, subject: byUser });
    router.use("/audit-logs", noStore());
    router.get("/audit-logs", userGuard(), authorize(AUDIT_POLICIES.list), readLimit(), controller.list);
    return sealRouter(router);
}
