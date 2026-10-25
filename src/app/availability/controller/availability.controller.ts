import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { requireAuth } from "../../../lib/auth/require-auth";
import { TOKENS } from "../../../lib/di/tokens";
import { NotFound } from "../../../lib/error/errors";
import { sendSuccess } from "../../../lib/http/response";
import { validateQuery } from "../../../lib/validation/validate";
import { parsePositiveId } from "../../../pkg/utils/id";
import { DoctorSlotsQueryDto, GetDoctorQueryDto, SearchDoctorsQueryDto } from "../dto/availability.request.dto";
import { SlotResponseDto } from "../dto/availability.response.dto";
import { DiscoveryDoctorResponseDto } from "../dto/discovery-doctor.response.dto";
import { SearchMetaResponseDto } from "../dto/search-meta.response.dto";
import { SlotWindowMetaDto } from "../dto/slot-window-meta.response.dto";
import { AvailabilityService } from "../service/availability.service";
import { DiscoveryService } from "../service/discovery.service";

@injectable()
export class AvailabilityController {
    constructor(
        @inject(TOKENS.AvailabilityService) private readonly service: AvailabilityService,
        @inject(TOKENS.DiscoveryService) private readonly discovery: DiscoveryService,
    ) {}

    slots = async (req: Request, res: Response): Promise<void> => {
        const doctorUserId = parsePositiveId(req.params.doctorUserId);
        if (doctorUserId === undefined) throw NotFound;
        const query = await validateQuery(DoctorSlotsQueryDto, req.query);
        const result = await this.service.getSlots(requireAuth(req), doctorUserId, query.toQuery());
        sendSuccess(res, result.slots.map((slot) => SlotResponseDto.from(slot, result.timezone)), { meta: { ...SlotWindowMetaDto.from(result) } });
    };

    search = async (req: Request, res: Response): Promise<void> => {
        const query = await validateQuery(SearchDoctorsQueryDto, req.query);
        const result = await this.discovery.search(query.toQuery());
        sendSuccess(res, result.items.map((item) => DiscoveryDoctorResponseDto.fromSearch(item, result.hydrated.get(item.view.profile.userId))),
            { meta: { ...SearchMetaResponseDto.from(result.meta) } });
    };

    getDoctor = async (req: Request, res: Response): Promise<void> => {
        const doctorUserId = parsePositiveId(req.params.doctorUserId);
        if (doctorUserId === undefined) throw NotFound;
        const query = await validateQuery(GetDoctorQueryDto, req.query);
        const result = await this.discovery.getDoctor(requireAuth(req), doctorUserId, query.toQuery());
        sendSuccess(res, DiscoveryDoctorResponseDto.fromProfile(result));
    };
}
