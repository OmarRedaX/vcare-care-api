import { AppError } from "../../lib/error/AppError";
import { ValidationFailed } from "../../lib/error/errors";

export const SpecialtyNameTaken = new AppError("Conflict", 409, "A specialty with this name already exists", [
    { field: "name", issue: "is already in use" },
]);

export const SpecialtySlugTaken = new AppError("Conflict", 409, "A specialty with this slug already exists", [
    { field: "slug", issue: "is already in use" },
]);

export const EmptySpecialtyUpdate = ValidationFailed.withDetails([
    { field: "body", issue: "must contain at least one property" },
]);
