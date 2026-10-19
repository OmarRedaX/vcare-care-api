import { AppError } from "../../lib/error/AppError";
export const UploadIntentExpired = new AppError("UploadIntentExpired", 410, "The upload intent has expired");
