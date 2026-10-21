import { Router } from "express";
import { userGuard } from "../../lib/auth/user-guard";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { sealRouter } from "../../lib/http/route-pattern";
import { authorize } from "../../lib/rbac/authorize";
import type { DoctorsService } from "../doctors/service/doctors.service";
import type { PatientRelationshipChecker } from "../patients/types";
import type { RecordLinksService } from "../records/service/record-links.service";
import type { RecordAttachmentsController } from "./controller/record-attachments.controller";
import { buildRecordAttachmentsPolicies } from "./policies";
import { intentLimit, readLimit, writeLimit } from "./rate-limits";

/**
 * Mounted AFTER the records router. No path collides: every path has more segments than `/records/:id`; `.../attachments/uploads` (POST) is
 * a different path from `.../attachments/:attachmentId/download-url`; a `DELETE .../attachments/uploads` reaches the delete route with
 * `attachmentId = "uploads"`, which the controller answers `404`. No route takes an `Idempotency-Key`: a response may hold a POST policy or a
 * URL, which must never be stored for replay in Redis. `Cache-Control: no-store` comes from `NO_STORE_PREFIXES` (`/api/records`).
 */
export function buildRecordAttachmentsRouter(): Router {
    const router = Router();
    const c = container.resolve<RecordAttachmentsController>(TOKENS.RecordAttachmentsController);
    const p = buildRecordAttachmentsPolicies(container.resolve<DoctorsService>(TOKENS.DoctorsService), container.resolve<RecordLinksService>(TOKENS.RecordLinksService),
        container.resolve<PatientRelationshipChecker>(TOKENS.PatientRelationship));

    router.post("/records/:id/attachments/uploads", userGuard(), authorize(p.createIntent), intentLimit(), c.createIntent);
    router.post("/records/:id/attachments/uploads/:uploadId/complete", userGuard(), authorize(p.complete), writeLimit(), c.complete);
    router.post("/records/:id/attachments/:attachmentId/download-url", userGuard(), authorize(p.downloadUrl), readLimit(), c.downloadUrl);
    router.delete("/records/:id/attachments/:attachmentId", userGuard(), authorize(p.remove), writeLimit(), c.remove);
    return sealRouter(router);
}
