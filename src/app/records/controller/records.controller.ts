import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { requireAuth } from "../../../lib/auth/require-auth";
import { TOKENS } from "../../../lib/di/tokens";
import { NotFound } from "../../../lib/error/errors";
import { sendSuccess } from "../../../lib/http/response";
import { assertEmptyBody, validateBody, validateQuery } from "../../../lib/validation/validate";
import { parsePositiveId } from "../../../pkg/utils/id";
import { MedicalRecordCreateDto, MedicalRecordPatchDto, TimelineQueryDto } from "../dto/records.request.dto";
import { MedicalRecordAmendmentResponseDto, MedicalRecordResponseDto, PatientTimelineResponseDto } from "../dto/records.response.dto";
import { EmptyRecordUpdate } from "../errors";
import type { RecordQueriesService } from "../service/record-queries.service";
import type { RecordsService } from "../service/records.service";

/**
 * validate -> service -> render. No route here takes an `Idempotency-Key`. The controller passes the validated clinical text on and never
 * reads it; a non-numeric path id is `404` (the ownership resolver already answered, this only narrows the type).
 */
@injectable()
export class RecordsController {
    constructor(
        @inject(TOKENS.RecordsService) private readonly commands: RecordsService,
        @inject(TOKENS.RecordQueriesService) private readonly queries: RecordQueriesService,
    ) {}

    create = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        const consultationId = pathId(req.params.id);
        const dto = await validateBody(MedicalRecordCreateDto, req.body);
        const record = await this.commands.create(auth, consultationId, dto.toInput());
        sendSuccess(res, MedicalRecordResponseDto.from(record, [], [], { userId: auth.userId, role: auth.role }), { status: 201 });
    };

    get = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        const id = pathId(req.params.id);
        // The route takes no query; a property-less DTO cannot reject members, so the shared empty-input check is used.
        assertEmptyBody(req.query);
        const result = await this.queries.get(auth, id);
        sendSuccess(res, MedicalRecordResponseDto.from(result.record, result.amendments, result.attachments, { userId: auth.userId, role: auth.role }));
    };

    update = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        const id = pathId(req.params.id);
        const dto = await validateBody(MedicalRecordPatchDto, req.body);
        // A `reason` alone is not a change: rejected before any database access.
        if (!dto.hasRecordField()) throw EmptyRecordUpdate;
        const viewer = { userId: auth.userId, role: auth.role };
        const result = await this.commands.update(auth, id, dto.toInput());
        if (result.kind === "amended") {
            sendSuccess(res, MedicalRecordAmendmentResponseDto.from(result.amendment, viewer), { status: 201 });
            return;
        }
        // In place or the pre-lock no-op: the current record with its live attachment metadata; a record cannot hold amendments before its lock.
        sendSuccess(res, MedicalRecordResponseDto.from(result.record, [], result.attachments, viewer));
    };

    timeline = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        const patientUserId = pathId(req.params.patientUserId);
        const query = await validateQuery(TimelineQueryDto, req.query);
        const result = await this.queries.timeline(auth, patientUserId, query.toQuery());
        sendSuccess(res, PatientTimelineResponseDto.from(result.patient, result.items, { userId: auth.userId, role: auth.role }), { meta: { ...result.meta } });
    };
}

function pathId(value: unknown): number {
    const id = parsePositiveId(value);
    if (id === undefined) throw NotFound;
    return id;
}
