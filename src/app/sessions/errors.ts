import { AppError } from "../../lib/error/AppError";
import { ValidationFailed } from "../../lib/error/errors";

export const RoomNotOpen = new AppError("RoomNotOpen", 409, "The session room is not open");
export const NoShowTooEarly = new AppError("NoShowTooEarly", 409, "A no-show can be marked only after the grace period");
/** A video-provider failure or timeout on join/start (sessions V1). The consultation state is unchanged or repairable by repeating `join`. */
export const VideoUnavailable = new AppError("VideoUnavailable", 503, "The video service is temporarily unavailable");

export const CalendarWindowTooLarge = ValidationFailed.withDetails([{ field: "to", issue: "window is at most 7 days" }]);
