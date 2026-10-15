import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { requireAuth } from "../../../lib/auth/require-auth";
import { TOKENS } from "../../../lib/di/tokens";
import { NotFound, ValidationFailed } from "../../../lib/error/errors";
import { sendSuccess } from "../../../lib/http/response";
import { hashBody } from "../../../lib/idempotency/idempotency";
import type { AuthContext } from "../../../lib/types/types";
import { validateBody, validateQuery } from "../../../lib/validation/validate";
import { parsePositiveId } from "../../../pkg/utils/id";
import { CancelDto, ConsultationCreateDto, GetConsultationQueryDto, ListConsultationsQueryDto, RescheduleDto } from "../dto/consultations.request.dto";
import { ConsultationResponseDto } from "../dto/consultations.response.dto";
import type { Consultation } from "../entity/consultation.entity";
import type { ConsultationQueriesService } from "../service/consultation-queries.service";
import type { ConsultationsService } from "../service/consultations.service";

const IDEMPOTENCY_KEY_REQUIRED = ValidationFailed.withDetails([{ field: "Idempotency-Key", issue: "is required" }]);

@injectable()
export class ConsultationsController {
    constructor(
        @inject(TOKENS.ConsultationsService) private readonly commands: ConsultationsService,
        @inject(TOKENS.ConsultationQueriesService) private readonly queries: ConsultationQueriesService,
    ) {}

    book = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        const dto = await validateBody(ConsultationCreateDto, req.body);
        const created = await this.commands.book(auth, dto.toInput(), idempotencyKey(req), hashBody(req.body));
        sendSuccess(res, await this.render(auth, created), { status: 201 });
    };

    list = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        const query = await validateQuery(ListConsultationsQueryDto, req.query);
        const page = await this.queries.list(auth, query.toQuery());
        const viewer = { userId: auth.userId, role: auth.role };
        sendSuccess(res, page.items.map((item) => ConsultationResponseDto.from(item.consultation, viewer, item.view)), { meta: { ...page.meta } });
    };

    get = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        const id = parsePositiveId(req.params.id);
        if (id === undefined) throw NotFound;
        const query = await validateQuery(GetConsultationQueryDto, req.query);
        const rendered = await this.queries.get(auth, id, query.timezone);
        sendSuccess(res, ConsultationResponseDto.from(rendered.consultation, { userId: auth.userId, role: auth.role }, rendered.view));
    };

    reschedule = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        const id = parsePositiveId(req.params.id);
        if (id === undefined) throw NotFound;
        const dto = await validateBody(RescheduleDto, req.body);
        sendSuccess(res, await this.render(auth, await this.commands.reschedule(auth, id, dto.toInput())));
    };

    cancel = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        const id = parsePositiveId(req.params.id);
        if (id === undefined) throw NotFound;
        const dto = await validateBody(CancelDto, req.body);
        sendSuccess(res, await this.render(auth, await this.commands.cancel(auth, id, dto.toInput())));
    };

    /** The actor's own write response: unhydrated participants, clinical detail for participants. */
    private async render(auth: AuthContext, consultation: Consultation): Promise<ConsultationResponseDto> {
        const rendered = await this.queries.renderOwn(auth, consultation);
        return ConsultationResponseDto.from(rendered.consultation, { userId: auth.userId, role: auth.role }, rendered.view);
    }
}

/** The idempotency middleware already required and shape-checked the header; this only narrows the type. */
function idempotencyKey(req: Request): string {
    const key = req.get("Idempotency-Key");
    if (key === undefined) throw IDEMPOTENCY_KEY_REQUIRED;
    return key.toLowerCase();
}
