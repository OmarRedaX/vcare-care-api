import { AppError } from "../../lib/error/AppError";
import { ValidationFailed } from "../../lib/error/errors";

export const DoctorNotBookable = new AppError("DoctorNotBookable", 409, "The doctor is not available for booking");
export const SlotUnavailable = new AppError("SlotUnavailable", 409, "The selected slot is no longer available");
export const OutsideWorkingHours = new AppError("OutsideWorkingHours", 422, "The requested time is outside the doctor's working hours");
export const BookingInPast = new AppError("BookingInPast", 422, "The requested time is in the past");
export const BeyondBookingHorizon = new AppError("BeyondBookingHorizon", 422, "The requested time is beyond the booking horizon");
export const PolicyWindowViolation = new AppError("PolicyWindowViolation", 409, "This consultation can no longer be changed by the patient");
export const InvalidTransition = new AppError("InvalidTransition", 409, "The consultation cannot change from its current status");

export const FollowUpNotSupported = ValidationFailed.withDetails([{ field: "followUpOfRecordId", issue: "is not supported yet" }]);
export const ReasonRequiredOnReschedule = ValidationFailed.withDetails([{ field: "reason", issue: "is required when an admin reschedules" }]);
export const ReasonRequiredOnCancel = ValidationFailed.withDetails([{ field: "reason", issue: "is required when a doctor or admin cancels" }]);
export const TimeRangeReversed = ValidationFailed.withDetails([{ field: "from", issue: "must be before to" }]);
