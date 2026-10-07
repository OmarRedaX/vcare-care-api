import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { requireAuth } from "../../../lib/auth/require-auth";
import { TOKENS } from "../../../lib/di/tokens";
import { sendNoContent, sendSuccess } from "../../../lib/http/response";
import { assertEmptyBody, validateBody, validateParams, validateQuery } from "../../../lib/validation/validate";
import { ApplicationApproveDto, ApplicationDocumentParamsDto, ApplicationIdParamsDto, ApplicationQueueQueryDto, ApplicationRejectDto, DocumentIdParamsDto, UploadIdParamsDto, UploadVerificationIntentRequestDto } from "../dto/verification.request.dto";
import { VerificationApplicationResponseDto, VerificationDocumentResponseDto } from "../dto/verification.response.dto";
import type { VerificationService } from "../service/verification.service";

@injectable()
export class VerificationController {
    constructor(@inject(TOKENS.VerificationService) private readonly service: VerificationService) {}
    createIntent = async (req: Request, res: Response): Promise<void> => { const dto = await validateBody(UploadVerificationIntentRequestDto, req.body); sendSuccess(res, await this.service.createIntent(requireAuth(req), dto.type), { status: 201 }); };
    complete = async (req: Request, res: Response): Promise<void> => { const params = await validateParams(UploadIdParamsDto, req.params); assertEmptyBody(req.body); const result = await this.service.complete(requireAuth(req), params.uploadId); sendSuccess(res, VerificationDocumentResponseDto.from(result.document), { status: result.replay ? 200 : 201 }); };
    myDownload = async (req: Request, res: Response): Promise<void> => { const params = await validateParams(DocumentIdParamsDto, req.params); assertEmptyBody(req.body); sendSuccess(res, await this.service.download(requireAuth(req), params.documentId)); };
    myDelete = async (req: Request, res: Response): Promise<void> => { const params = await validateParams(DocumentIdParamsDto, req.params); assertEmptyBody(req.body); await this.service.deleteDocument(requireAuth(req), params.documentId); sendNoContent(res); };
    queue = async (req: Request, res: Response): Promise<void> => { const query = await validateQuery(ApplicationQueueQueryDto, req.query); const page = await this.service.queue({ status: query.status!, cursor: query.cursor, limit: query.limit! }); sendSuccess(res, page.items.map((item) => VerificationApplicationResponseDto.from(item, "admin")), { meta: page.meta }); };
    detail = async (req: Request, res: Response): Promise<void> => { const params = await validateParams(ApplicationIdParamsDto, req.params); sendSuccess(res, VerificationApplicationResponseDto.from(await this.service.getApplication(requireAuth(req), params.id), "admin")); };
    adminDownload = async (req: Request, res: Response): Promise<void> => { const params = await validateParams(ApplicationDocumentParamsDto, req.params); assertEmptyBody(req.body); sendSuccess(res, await this.service.download(requireAuth(req), params.documentId, params.id)); };
    approve = async (req: Request, res: Response): Promise<void> => { const params = await validateParams(ApplicationIdParamsDto, req.params); const dto = await validateBody(ApplicationApproveDto, req.body ?? {}); const result = await this.service.decide(requireAuth(req), params.id, "approve", dto.note); sendSuccess(res, { ...VerificationApplicationResponseDto.from(result.view, "admin"), ...(result.status === 202 ? { identitySync: result.identitySync } : {}) }, { status: result.status }); };
    reject = async (req: Request, res: Response): Promise<void> => { const params = await validateParams(ApplicationIdParamsDto, req.params); const dto = await validateBody(ApplicationRejectDto, req.body); const result = await this.service.decide(requireAuth(req), params.id, "reject", dto.reason); sendSuccess(res, { ...VerificationApplicationResponseDto.from(result.view, "admin"), ...(result.status === 202 ? { identitySync: result.identitySync } : {}) }, { status: result.status }); };
    reopen = async (req: Request, res: Response): Promise<void> => { const params = await validateParams(ApplicationIdParamsDto, req.params); const dto = await validateBody(ApplicationRejectDto, req.body); const result = await this.service.decide(requireAuth(req), params.id, "reopen", dto.reason); sendSuccess(res, { ...VerificationApplicationResponseDto.from(result.view, "admin"), ...(result.status === 202 ? { identitySync: result.identitySync } : {}) }, { status: result.status }); };
}
