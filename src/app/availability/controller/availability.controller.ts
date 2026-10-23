import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { requireAuth } from "../../../lib/auth/require-auth";
import { TOKENS } from "../../../lib/di/tokens";
import { NotFound } from "../../../lib/error/errors";
import { sendSuccess } from "../../../lib/http/response";
import { validateQuery } from "../../../lib/validation/validate";
import { parsePositiveId } from "../../../pkg/utils/id";
import { DoctorSlotsQueryDto } from "../dto/availability.request.dto";
import { SlotResponseDto } from "../dto/availability.response.dto";
import { SlotWindowMetaDto } from "../dto/slot-window-meta.response.dto";
import { AvailabilityService } from "../service/availability.service";

@injectable()
export class AvailabilityController {
    constructor(@inject(TOKENS.AvailabilityService) private readonly service: AvailabilityService) {}
    slots = async (req: Request, res: Response): Promise<void> => {
        const doctorUserId = parsePositiveId(req.params.doctorUserId);
        if (doctorUserId === undefined) throw NotFound;
        const query = await validateQuery(DoctorSlotsQueryDto, req.query);
        const result = await this.service.getSlots(requireAuth(req), doctorUserId, query.toQuery());
        sendSuccess(res, result.slots.map((slot) => SlotResponseDto.from(slot, result.timezone)), { meta: { ...SlotWindowMetaDto.from(result) } });
    };
}
