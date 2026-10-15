import { toIsoInZone } from "../../../pkg/utils/time";
import { ConsultationResponseDto } from "../../consultations/dto/consultations.response.dto";
import type { ConsultationView, ConsultationViewer } from "../../consultations/types";
import { ScheduleExceptionResponseDto } from "../../schedules/dto/schedules.response.dto";
import type { RenderedCalendar, SessionJoinResult } from "../types";

/** `joinToken` is a per-participant secret: it only ever appears in this response and is never logged (redacted by name). */
export class SessionJoinResponseDto {
    consultation!: ConsultationResponseDto;
    roomId!: string;
    joinToken!: string;
    joinTokenExpiresAt!: string;
    windowOpensAt!: string;
    windowClosesAt!: string;

    static from(result: SessionJoinResult, viewer: ConsultationViewer, view: ConsultationView): SessionJoinResponseDto {
        return {
            consultation: ConsultationResponseDto.from(result.consultation, viewer, view), roomId: result.roomId, joinToken: result.joinToken,
            joinTokenExpiresAt: result.joinTokenExpiresAt.toISOString(), windowOpensAt: result.windowOpensAt.toISOString(),
            windowClosesAt: result.windowClosesAt.toISOString(),
        };
    }
}

export class CalendarViewResponseDto {
    from!: string;
    to!: string;
    timezone!: string;
    consultations!: ConsultationResponseDto[];
    exceptions!: ScheduleExceptionResponseDto[];

    /** `from`/`to` echo the request instants rendered in `timezone`; every entry is the doctor's own and carries no clinical text. */
    static from(calendar: RenderedCalendar, viewer: ConsultationViewer): CalendarViewResponseDto {
        return {
            from: toIsoInZone(calendar.fromMs, calendar.timezone), to: toIsoInZone(calendar.toMs, calendar.timezone), timezone: calendar.timezone,
            consultations: calendar.items.map((item) => ConsultationResponseDto.from(item.consultation, viewer, item.view)),
            exceptions: calendar.exceptions.map((exception) => ScheduleExceptionResponseDto.from(exception)),
        };
    }
}
