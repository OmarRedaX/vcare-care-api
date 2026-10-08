import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { requireAuth } from "../../../lib/auth/require-auth";
import { TOKENS } from "../../../lib/di/tokens";
import { sendSuccess } from "../../../lib/http/response";
import { validateBody } from "../../../lib/validation/validate";
import { DoctorApplyDto, DoctorProfileUpdateDto } from "../dto/doctors.request.dto";
import { DoctorProfileOwnResponseDto } from "../dto/doctors.response.dto";
import { EmptyDoctorProfileUpdate } from "../errors";
import { VerificationApplicationResponseDto as LiveVerificationApplicationResponseDto } from "../../verification/dto/verification.response.dto";
import type { DoctorsService } from "../service/doctors.service";

@injectable()
export class DoctorsController {
    constructor(@inject(TOKENS.DoctorsService) private readonly service: DoctorsService) {}

    apply = async (req: Request, res: Response): Promise<void> => {
        const dto = await validateBody(DoctorApplyDto, req.body);
        const result = await this.service.apply(requireAuth(req), dto.toInput());
        if (result.status === 202) {
            const application = await this.service.getOwnApplication(requireAuth(req));
            sendSuccess(res, { ...LiveVerificationApplicationResponseDto.from(application, "doctor"), identitySync: result.identitySync }, { status: 202 });
        } else sendSuccess(res, DoctorProfileOwnResponseDto.from(result.view), { status: result.status ?? (result.created ? 201 : 200) });
    };
    getMe = async (req: Request, res: Response): Promise<void> => {
        sendSuccess(res, DoctorProfileOwnResponseDto.from(await this.service.getOwn(requireAuth(req))));
    };
    updateMe = async (req: Request, res: Response): Promise<void> => {
        const dto = await validateBody(DoctorProfileUpdateDto, req.body);
        if (dto.isEmpty()) throw EmptyDoctorProfileUpdate;
        sendSuccess(res, DoctorProfileOwnResponseDto.from(await this.service.update(requireAuth(req), dto.toChanges())));
    };
    getApplication = async (req: Request, res: Response): Promise<void> => {
        sendSuccess(res, LiveVerificationApplicationResponseDto.from(await this.service.getOwnApplication(requireAuth(req)), "doctor"));
    };
}
