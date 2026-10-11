import { ValidationFailed } from "../../lib/error/errors";

export const TimezoneRequiredOnCreate = ValidationFailed.withDetails([{ field: "timezone", issue: "is required when creating the profile" }]);
export const EmptyPatientProfileUpdate = ValidationFailed.withDetails([{ field: "body", issue: "must contain at least one property" }]);
export const DateOfBirthInFuture = ValidationFailed.withDetails([{ field: "dateOfBirth", issue: "must not be in the future" }]);
