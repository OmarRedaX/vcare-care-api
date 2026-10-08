import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { requireAuth } from "../../../lib/auth/require-auth";
import { TOKENS } from "../../../lib/di/tokens";
import { NotFound } from "../../../lib/error/errors";
import { sendNoContent, sendSuccess } from "../../../lib/http/response";
import { validateBody, validateQuery } from "../../../lib/validation/validate";
import { parsePositiveId } from "../../../pkg/utils/id";
import {
    ConsultationTypeCreateDto, ConsultationTypeUpdateDto, DeleteExceptionQueryDto, ListExceptionsQueryDto, ListTypesQueryDto,
    ScheduleExceptionCreateDto, WorkingHoursReplaceDto,
} from "../dto/schedules.request.dto";
import { ConsultationTypeResponseDto, ScheduleExceptionResponseDto, WorkingHoursResponseDto } from "../dto/schedules.response.dto";
import { EmptyConsultationTypeUpdate } from "../errors";
import type { SchedulesService } from "../service/schedules.service";

@injectable()
export class SchedulesController {
    constructor(@inject(TOKENS.SchedulesService) private readonly service: SchedulesService) {}

    getWorkingHours = async (req: Request, res: Response): Promise<void> => {
        sendSuccess(res, WorkingHoursResponseDto.from(await this.service.getWorkingHours(requireAuth(req))));
    };

    replaceWorkingHours = async (req: Request, res: Response): Promise<void> => {
        const dto = await validateBody(WorkingHoursReplaceDto, req.body);
        sendSuccess(res, WorkingHoursResponseDto.from(await this.service.replaceWorkingHours(requireAuth(req), dto.toInput())));
    };

    listExceptions = async (req: Request, res: Response): Promise<void> => {
        const query = await validateQuery(ListExceptionsQueryDto, req.query);
        const page = await this.service.listExceptions(requireAuth(req), query);
        sendSuccess(res, page.items.map((item) => ScheduleExceptionResponseDto.from(item)), { meta: { ...page.meta } });
    };

    createException = async (req: Request, res: Response): Promise<void> => {
        const dto = await validateBody(ScheduleExceptionCreateDto, req.body);
        const created = await this.service.createExceptions(requireAuth(req), dto.toInput());
        sendSuccess(res, created.map((item) => ScheduleExceptionResponseDto.from(item)), { status: 201 });
    };

    deleteException = async (req: Request, res: Response): Promise<void> => {
        const id = parsePositiveId(req.params.id);
        if (id === undefined) throw NotFound;
        const query = await validateQuery(DeleteExceptionQueryDto, req.query);
        await this.service.deleteException(requireAuth(req), id, query.confirmConflicts === true);
        sendNoContent(res);
    };

    listTypes = async (req: Request, res: Response): Promise<void> => {
        const query = await validateQuery(ListTypesQueryDto, req.query);
        const page = await this.service.listConsultationTypes(requireAuth(req), query);
        sendSuccess(res, page.items.map((item) => ConsultationTypeResponseDto.from(item)), { meta: { ...page.meta } });
    };

    createType = async (req: Request, res: Response): Promise<void> => {
        const dto = await validateBody(ConsultationTypeCreateDto, req.body);
        sendSuccess(res, ConsultationTypeResponseDto.from(await this.service.createConsultationType(requireAuth(req), dto.toInput())), { status: 201 });
    };

    updateType = async (req: Request, res: Response): Promise<void> => {
        const id = parsePositiveId(req.params.id);
        if (id === undefined) throw NotFound;
        const dto = await validateBody(ConsultationTypeUpdateDto, req.body);
        if (dto.isEmpty()) throw EmptyConsultationTypeUpdate;
        sendSuccess(res, ConsultationTypeResponseDto.from(await this.service.updateConsultationType(requireAuth(req), id, dto.toChanges())));
    };
}
