import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { requireAuth } from "../../../lib/auth/require-auth";
import { TOKENS } from "../../../lib/di/tokens";
import { NotFound } from "../../../lib/error/errors";
import { sendSuccess } from "../../../lib/http/response";
import { validateBody, validateQuery } from "../../../lib/validation/validate";
import { parsePositiveId } from "../../../pkg/utils/id";
import { CreateSpecialtyDto, ListSpecialtiesQueryDto, UpdateSpecialtyDto } from "../dto/specialties.request.dto";
import { SpecialtyResponseDto } from "../dto/specialties.response.dto";
import { EmptySpecialtyUpdate } from "../errors";
import type { SpecialtiesService } from "../service/specialties.service";

@injectable()
export class SpecialtiesController {
    constructor(@inject(TOKENS.SpecialtiesService) private readonly service: SpecialtiesService) {}

    list = async (req: Request, res: Response): Promise<void> => {
        const query = await validateQuery(ListSpecialtiesQueryDto, req.query);
        const page = await this.service.list(requireAuth(req), query);
        sendSuccess(res, page.items.map((item) => SpecialtyResponseDto.from(item)), { meta: { ...page.meta } });
    };

    create = async (req: Request, res: Response): Promise<void> => {
        const dto = await validateBody(CreateSpecialtyDto, req.body);
        const created = await this.service.create(requireAuth(req), dto.toInput());
        sendSuccess(res, SpecialtyResponseDto.from(created), { status: 201 });
    };

    update = async (req: Request, res: Response): Promise<void> => {
        const id = parsePositiveId(req.params.id);
        if (id === undefined) throw NotFound;
        const dto = await validateBody(UpdateSpecialtyDto, req.body);
        if (dto.isEmpty()) throw EmptySpecialtyUpdate;
        const updated = await this.service.update(requireAuth(req), id, dto.toChanges());
        sendSuccess(res, SpecialtyResponseDto.from(updated));
    };
}
