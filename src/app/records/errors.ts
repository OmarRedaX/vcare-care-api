import { AppError } from "../../lib/error/AppError";
import { Conflict, ValidationFailed } from "../../lib/error/errors";

export const NotAssignedDoctor = new AppError("NotAssignedDoctor", 403, "Only the assigned doctor can write this record");
export const RecordRequiresCompleted = new AppError("RecordRequiresCompleted", 409, "A record can be written only for a completed consultation");
export const RecordLocked = new AppError("RecordLocked", 409, "The record is locked");

export const RecordAlreadyExists = Conflict.withMessage("A record already exists for this consultation");
export const EmptyRecordUpdate = ValidationFailed.withDetails([{ field: "body", issue: "must contain at least one record field" }]);
export const ReasonRequiredAfterLock = ValidationFailed.withDetails([{ field: "reason", issue: "is required after the record is locked" }]);
