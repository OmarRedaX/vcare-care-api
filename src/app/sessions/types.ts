import type { UserPolicy } from "../../lib/rbac/types";
import type { Consultation } from "../consultations/entity/consultation.entity";
import type { RenderedConsultation } from "../consultations/types";
import type { ScheduleException } from "../schedules/entity/schedule-exception.entity";

/** What `join` and `start` return: the row plus this participant's room, token and the window bounds. */
export interface SessionJoinResult {
    consultation: Consultation; roomId: string; joinToken: string; joinTokenExpiresAt: Date; windowOpensAt: Date; windowClosesAt: Date;
}

/** The no-show note is never stored; only its length reaches the audit row. */
export interface NoShowInput { note?: string }

/** A validated `GET /consultations/calendar` query; `timezone` is canonical when present. */
export interface CalendarQuery { fromMs: number; toMs: number; timezone: string | undefined }

export interface RenderedCalendar {
    fromMs: number; toMs: number; timezone: string; items: RenderedConsultation[]; exceptions: ScheduleException[];
}

export type SessionsRoute = "join" | "start" | "complete" | "noShow" | "waitingRoom" | "calendar";
export type SessionsPolicies = Readonly<Record<SessionsRoute, UserPolicy>>;
