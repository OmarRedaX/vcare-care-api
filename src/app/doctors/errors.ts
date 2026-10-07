import { AppError } from "../../lib/error/AppError";
import { ValidationFailed } from "../../lib/error/errors";

export const ApplicationNotEditable = new AppError("Conflict", 409, "The application is under review or approved and cannot be replaced", [{ field: "verificationStatus", issue: "does not allow apply" }]);
export const SubmitRequiresDocuments = ValidationFailed.withDetails([{ field: "documents", issue: "a license and an id document are required to submit" }]);
export const UnknownSpecialty = ValidationFailed.withDetails([{ field: "specialtyIds", issue: "contains an unknown or inactive specialty" }]);
export const PrimarySpecialtyNotLinked = ValidationFailed.withDetails([{ field: "primarySpecialtyId", issue: "must be one of specialtyIds" }]);
export const PrimarySpecialtyRequired = ValidationFailed.withDetails([{ field: "primarySpecialtyId", issue: "is required when the current primary specialty is removed" }]);
export const CurrencyNotAllowed = ValidationFailed.withDetails([{ field: "consultationFee.currency", issue: "is not an allowed currency" }]);
export const EmptyDoctorProfileUpdate = ValidationFailed.withDetails([{ field: "body", issue: "must contain at least one property" }]);
