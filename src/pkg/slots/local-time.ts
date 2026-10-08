const TIME_OF_DAY = /^(?:([01][0-9]|2[0-3]):([0-5][0-9])|(24):(00))$/;

/** `"HH:mm"` or `"24:00"` to minutes since midnight (`0..1440`). Anything else throws `RangeError`. */
export function parseTimeOfDay(text: string): number {
    const match = typeof text === "string" ? TIME_OF_DAY.exec(text) : null;
    if (match === null) {
        throw new RangeError("Invalid time of day");
    }
    if (match[3] !== undefined) {
        return 1440;
    }
    return Number(match[1]) * 60 + Number(match[2]);
}

/** Minutes since midnight (`0..1440`) to `"HH:mm"` (`"24:00"` for 1440). */
export function formatTimeOfDay(minutes: number): string {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
        throw new RangeError("Minutes out of range");
    }
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}
