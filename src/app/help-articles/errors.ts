import { AppError } from "../../lib/error/AppError";
import { ValidationFailed } from "../../lib/error/errors";

export const HelpArticleTitleTaken = new AppError("Conflict", 409, "A help article with this title already exists for this audience", [
    { field: "title", issue: "is already in use for this audience" },
]);

export const EmptyHelpArticleUpdate = ValidationFailed.withDetails([
    { field: "body", issue: "must contain at least one property" },
]);
