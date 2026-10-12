import { DateTime } from "luxon";

/** `Tuesday 14 October 2026, 15:30 (Africa/Cairo)`, DST-correct; an invalid zone falls back to `UTC`. */
export function formatLocal(ms: number, timezone: string): string {
    let zoned = DateTime.fromMillis(ms, { zone: timezone });
    if (!zoned.isValid) {
        zoned = DateTime.fromMillis(ms, { zone: "UTC" });
    }
    return `${zoned.setLocale("en").toFormat("cccc d LLLL yyyy, HH:mm")} (${zoned.zoneName ?? "UTC"})`;
}
