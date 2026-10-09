import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { sendSuccess } from "../../../lib/http/response";
import { validateQuery } from "../../../lib/validation/validate";
import { ListAuditLogsQueryDto } from "../dto/audit.request.dto";
import { AuditLogResponseDto } from "../dto/audit.response.dto";
import type { AuditService } from "../service/audit.service";

@injectable()
export class AuditController {
    constructor(@inject(TOKENS.AuditService) private readonly service: AuditService) {}

    list = async (req: Request, res: Response): Promise<void> => {
        const query = await validateQuery(ListAuditLogsQueryDto, req.query);
        const page = await this.service.list(query);
        sendSuccess(res, page.items.map((item) => AuditLogResponseDto.from(item)), { meta: { ...page.meta } });
    };
}
