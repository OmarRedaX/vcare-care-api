import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { requireAuth } from "../../../lib/auth/require-auth";
import { TOKENS } from "../../../lib/di/tokens";
import { NotFound } from "../../../lib/error/errors";
import { sendNoContent, sendSuccess } from "../../../lib/http/response";
import { assertEmptyBody, validateBody } from "../../../lib/validation/validate";
import { parsePositiveId } from "../../../pkg/utils/id";
import { RecordAttachmentIntentDto } from "../dto/record-attachments.request.dto";
import { RecordAttachmentResponseDto } from "../dto/record-attachments.response.dto";
import type { RecordAttachmentsService } from "../service/record-attachments.service";

/**
 * validate -> service -> render. No route here takes an `Idempotency-Key`. The controller passes the validated description on and never
 * reads it; a non-numeric path id is `404` (the ownership resolver already answered for `{id}`, this narrows the type and answers for
 * `{uploadId}` and `{attachmentId}`). No response except the intent carries a URL, an object key or a POST field.
 */
@injectable()
export class RecordAttachmentsController {
    constructor(@inject(TOKENS.RecordAttachmentsService) private readonly commands: RecordAttachmentsService) {}

    createIntent = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        const recordId = pathId(req.params.id);
        const dto = await validateBody(RecordAttachmentIntentDto, req.body ?? {});
        const intent = await this.commands.createIntent(auth, recordId, dto.toInput());
        sendSuccess(res, intent, { status: 201 });
    };

    complete = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        const recordId = pathId(req.params.id);
        const uploadId = pathId(req.params.uploadId);
        assertEmptyBody(req.body);
        const completed = await this.commands.complete(auth, recordId, uploadId);
        sendSuccess(res, RecordAttachmentResponseDto.from(completed.attachment, { userId: auth.userId, role: auth.role }), { status: completed.replay ? 200 : 201 });
    };

    downloadUrl = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        const recordId = pathId(req.params.id);
        const attachmentId = pathId(req.params.attachmentId);
        assertEmptyBody(req.body);
        sendSuccess(res, await this.commands.downloadUrl(auth, recordId, attachmentId));
    };

    remove = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        const recordId = pathId(req.params.id);
        const attachmentId = pathId(req.params.attachmentId);
        assertEmptyBody(req.body);
        await this.commands.remove(auth, recordId, attachmentId);
        sendNoContent(res);
    };
}

function pathId(value: unknown): number {
    const id = parsePositiveId(value);
    if (id === undefined) throw NotFound;
    return id;
}
