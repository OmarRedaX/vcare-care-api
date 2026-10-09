import { AppError } from "../../lib/error/AppError";

export const InvalidTransition = new AppError("InvalidTransition", 409, "The doctor cannot change from the current state");
export const IdentityUnavailable = new AppError("IdentityUnavailable", 503, "Suspension applied locally; session revocation is pending");
