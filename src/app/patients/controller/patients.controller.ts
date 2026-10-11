import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { requireAuth } from "../../../lib/auth/require-auth";
import { TOKENS } from "../../../lib/di/tokens";
import { NotFound } from "../../../lib/error/errors";
import { sendSuccess } from "../../../lib/http/response";
import { parsePositiveId } from "../../../pkg/utils/id";
import { validateBody } from "../../../lib/validation/validate";
import { PatientProfileUpdateDto } from "../dto/patients.request.dto";
import { PatientProfileResponseDto } from "../dto/patients.response.dto";
import { EmptyPatientProfileUpdate } from "../errors";
import type { PatientsService } from "../service/patients.service";

@injectable()
export class PatientsController {
    constructor(@inject(TOKENS.PatientsService) private readonly service: PatientsService) {}

    getMe = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        sendSuccess(res, PatientProfileResponseDto.from(await this.service.getOwn(auth), { userId: auth.userId, role: auth.role }));
    };
    getById = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        const patientUserId = parsePositiveId(req.params.patientUserId);
        if (patientUserId === undefined) throw NotFound;
        sendSuccess(res, PatientProfileResponseDto.from(await this.service.getForViewer(auth, patientUserId), { userId: auth.userId, role: auth.role }));
    };
    updateMe = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        const dto = await validateBody(PatientProfileUpdateDto, req.body);
        if (dto.isEmpty()) throw EmptyPatientProfileUpdate;
        sendSuccess(res, PatientProfileResponseDto.from(await this.service.upsert(auth, dto.toChanges()), { userId: auth.userId, role: auth.role }));
    };
}
