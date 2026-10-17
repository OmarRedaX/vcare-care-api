import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { requireAuth } from "../../../lib/auth/require-auth";
import { TOKENS } from "../../../lib/di/tokens";
import { NotFound } from "../../../lib/error/errors";
import { sendSuccess } from "../../../lib/http/response";
import type { AuthContext } from "../../../lib/types/types";
import { assertEmptyBody, validateBody, validateQuery } from "../../../lib/validation/validate";
import { parsePositiveId } from "../../../pkg/utils/id";
import { ConsultationResponseDto } from "../../consultations/dto/consultations.response.dto";
import type { Consultation } from "../../consultations/entity/consultation.entity";
import { CalendarQueryDto, NoShowDto } from "../dto/sessions.request.dto";
import { CalendarViewResponseDto, SessionJoinResponseDto } from "../dto/sessions.response.dto";
import type { SessionQueriesService } from "../service/session-queries.service";
import type { SessionsService } from "../service/sessions.service";
import type { SessionJoinResult } from "../types";

@injectable()
export class SessionsController {
    constructor(
        @inject(TOKENS.SessionsService) private readonly commands: SessionsService,
        @inject(TOKENS.SessionQueriesService) private readonly queries: SessionQueriesService,
    ) {}

    /** Join and start take no body: the controller never reads `req.body`. */
    join = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        sendSuccess(res, await this.renderJoin(auth, await this.commands.join(auth, pathId(req))));
    };

    start = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        sendSuccess(res, await this.renderJoin(auth, await this.commands.start(auth, pathId(req))));
    };

    complete = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        sendSuccess(res, await this.renderOwn(auth, await this.commands.complete(auth, pathId(req))));
    };

    noShow = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        const id = pathId(req);
        // An absent body is `{}`; a present one is validated (unknown members rejected).
        const dto = req.body === undefined ? new NoShowDto() : await validateBody(NoShowDto, req.body);
        sendSuccess(res, await this.renderOwn(auth, await this.commands.noShow(auth, id, dto.toInput())));
    };

    waitingRoom = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        // The route takes no query; a property-less DTO cannot reject members, so the shared empty-input check is used.
        assertEmptyBody(req.query);
        const viewer = { userId: auth.userId, role: auth.role };
        const items = await this.queries.waitingRoom(auth);
        sendSuccess(res, items.map((item) => ConsultationResponseDto.from(item.consultation, viewer, item.view)));
    };

    calendar = async (req: Request, res: Response): Promise<void> => {
        const auth = requireAuth(req);
        const query = await validateQuery(CalendarQueryDto, req.query);
        const calendar = await this.queries.calendar(auth, query.toQuery());
        sendSuccess(res, CalendarViewResponseDto.from(calendar, { userId: auth.userId, role: auth.role }));
    };

    private async renderJoin(auth: AuthContext, result: SessionJoinResult): Promise<SessionJoinResponseDto> {
        const rendered = await this.queries.renderOwn(auth, result.consultation);
        return SessionJoinResponseDto.from(result, { userId: auth.userId, role: auth.role }, rendered.view);
    }

    private async renderOwn(auth: AuthContext, consultation: Consultation): Promise<ConsultationResponseDto> {
        const rendered = await this.queries.renderOwn(auth, consultation);
        return ConsultationResponseDto.from(rendered.consultation, { userId: auth.userId, role: auth.role }, rendered.view);
    }
}

/** A non-numeric id is 404 (existence is private); the ownership resolver already answered, this only narrows the type. */
function pathId(req: Request): number {
    const id = parsePositiveId(req.params.id);
    if (id === undefined) throw NotFound;
    return id;
}
