import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { requireAuth } from "../../../lib/auth/require-auth";
import { TOKENS } from "../../../lib/di/tokens";
import { NotFound } from "../../../lib/error/errors";
import { sendNoContent, sendSuccess } from "../../../lib/http/response";
import { validateBody, validateQuery } from "../../../lib/validation/validate";
import { parsePositiveId } from "../../../pkg/utils/id";
import { CreateHelpArticleDto, ListHelpArticlesQueryDto, UpdateHelpArticleDto } from "../dto/help-articles.request.dto";
import { HelpArticleResponseDto, HelpArticleSummaryResponseDto } from "../dto/help-articles.response.dto";
import { EmptyHelpArticleUpdate } from "../errors";
import type { HelpArticlesService } from "../service/help-articles.service";

@injectable()
export class HelpArticlesController {
    constructor(@inject(TOKENS.HelpArticlesService) private readonly service: HelpArticlesService) {}

    list = async (req: Request, res: Response): Promise<void> => {
        const query = await validateQuery(ListHelpArticlesQueryDto, req.query);
        const page = await this.service.list(requireAuth(req), query);
        sendSuccess(res, page.items.map((item) => HelpArticleSummaryResponseDto.from(item)), { meta: { ...page.meta } });
    };

    get = async (req: Request, res: Response): Promise<void> => {
        const id = parsePositiveId(req.params.id);
        if (id === undefined) throw NotFound;
        sendSuccess(res, HelpArticleResponseDto.from(await this.service.get(requireAuth(req), id)));
    };

    create = async (req: Request, res: Response): Promise<void> => {
        const dto = await validateBody(CreateHelpArticleDto, req.body);
        const created = await this.service.create(requireAuth(req), dto.toInput());
        sendSuccess(res, HelpArticleResponseDto.from(created), { status: 201 });
    };

    update = async (req: Request, res: Response): Promise<void> => {
        const id = parsePositiveId(req.params.id);
        if (id === undefined) throw NotFound;
        const dto = await validateBody(UpdateHelpArticleDto, req.body);
        if (dto.isEmpty()) throw EmptyHelpArticleUpdate;
        sendSuccess(res, HelpArticleResponseDto.from(await this.service.update(requireAuth(req), id, dto.toChanges())));
    };

    remove = async (req: Request, res: Response): Promise<void> => {
        const id = parsePositiveId(req.params.id);
        if (id === undefined) throw NotFound;
        await this.service.remove(requireAuth(req), id);
        sendNoContent(res);
    };
}
