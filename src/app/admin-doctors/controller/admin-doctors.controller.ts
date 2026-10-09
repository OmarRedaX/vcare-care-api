import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { requireAuth } from "../../../lib/auth/require-auth";
import { TOKENS } from "../../../lib/di/tokens";
import { sendSuccess } from "../../../lib/http/response";
import { validateBody, validateParams } from "../../../lib/validation/validate";
import { SUSPENSION_PENDING_MARKER } from "../constants";
import { DoctorUserIdParamsDto, ReinstateDoctorDto, SuspendDoctorDto } from "../dto/admin-doctors.request.dto";
import { ReinstatementResultResponseDto, SuspensionResultResponseDto } from "../dto/admin-doctors.response.dto";
import { IdentityUnavailable } from "../errors";
import type { AdminDoctorsService } from "../service/admin-doctors.service";

@injectable()
export class AdminDoctorsController {
    constructor(@inject(TOKENS.AdminDoctorsService) private readonly service: AdminDoctorsService) {}

    suspend = async (req: Request, res: Response): Promise<void> => {
        const params = await validateParams(DoctorUserIdParamsDto, req.params);
        const dto = await validateBody(SuspendDoctorDto, req.body);
        const { view, confirmed } = await this.service.suspend(requireAuth(req), params.doctorUserId, dto.reason);
        const data = SuspensionResultResponseDto.from(view);
        // Never report a suspension as complete before Identity confirms: 503 with the local state in `data` (contract `SuspensionPending`).
        if (!confirmed) throw IdentityUnavailable.withExtra({ suspension: SUSPENSION_PENDING_MARKER, data });
        sendSuccess(res, data);
    };

    reinstate = async (req: Request, res: Response): Promise<void> => {
        const params = await validateParams(DoctorUserIdParamsDto, req.params);
        const dto = await validateBody(ReinstateDoctorDto, req.body);
        const result = await this.service.reinstate(requireAuth(req), params.doctorUserId, dto.reason);
        const data = ReinstatementResultResponseDto.from(result.view);
        if (result.status === 202) sendSuccess(res, data, { status: 202, siblings: { identitySync: result.identitySync } });
        else sendSuccess(res, data);
    };
}
