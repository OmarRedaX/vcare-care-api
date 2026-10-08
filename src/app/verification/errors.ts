import { AppError } from "../../lib/error/AppError";
export const ApplicationNotEditable = new AppError("ApplicationNotEditable", 409, "The application cannot be edited in its current state");
export const ApplicationNotReviewable = new AppError("ApplicationNotReviewable", 409, "The application cannot be reviewed in its current state");
export const UploadIntentExpired = new AppError("UploadIntentExpired", 410, "The upload intent has expired");
