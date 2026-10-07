import { ValidationFailed } from "../../lib/error/errors";

export { ApplicationNotEditable } from "../verification/errors";
export const UnknownSpecialty = ValidationFailed.withDetails([{ field: "specialtyIds", issue: "contains an unknown or inactive specialty" }]);
export const PrimarySpecialtyNotLinked = ValidationFailed.withDetails([{ field: "primarySpecialtyId", issue: "must be one of specialtyIds" }]);
export const PrimarySpecialtyRequired = ValidationFailed.withDetails([{ field: "primarySpecialtyId", issue: "is required when the current primary specialty is removed" }]);
export const CurrencyNotAllowed = ValidationFailed.withDetails([{ field: "consultationFee.currency", issue: "is not an allowed currency" }]);
export const EmptyDoctorProfileUpdate = ValidationFailed.withDetails([{ field: "body", issue: "must contain at least one property" }]);
