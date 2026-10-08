/** The full `ErrorCode` enum from contracts/openapi.yaml. Codes are stable forever once shipped. */
export type ErrorCode =
    | "ValidationFailed"
    | "Unauthorized"
    | "TokenExpired"
    | "ServiceTokenRequired"
    | "InsufficientScope"
    | "Forbidden"
    | "EmailNotVerified"
    | "DoctorNotBookable"
    | "SlotUnavailable"
    | "OutsideWorkingHours"
    | "BookingInPast"
    | "BeyondBookingHorizon"
    | "PolicyWindowViolation"
    | "InvalidTransition"
    | "NoShowTooEarly"
    | "RoomNotOpen"
    | "RecordRequiresCompleted"
    | "NotAssignedDoctor"
    | "RecordLocked"
    | "ApplicationNotReviewable"
    | "ApplicationNotEditable"
    | "UploadIntentExpired"
    | "ScheduleConflictsUnconfirmed"
    | "IdentityUnavailable"
    | "IdempotencyConflict"
    | "NotFound"
    | "Conflict"
    | "RateLimited"
    | "InternalError";

export interface ErrorDetail {
    field: string;
    issue: string;
}

export interface ErrorEnvelope {
    success: false;
    error: {
        code: ErrorCode;
        message: string;
        details: readonly ErrorDetail[];
        requestId: string;
    };
}

/** Shape of a body-parser failure; `type` identifies the reason (`entity.parse.failed`, …). */
export interface BodyParserError {
    type: string;
    status?: number;
}
