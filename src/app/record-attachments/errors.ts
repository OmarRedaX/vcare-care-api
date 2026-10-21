import { AppError } from "../../lib/error/AppError";

export const AttachmentLimitReached = new AppError("AttachmentLimitReached", 409, "A record can hold at most 20 attachments");
