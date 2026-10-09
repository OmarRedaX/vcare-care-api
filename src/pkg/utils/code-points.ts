/** Keeps at most `max` Unicode code points; a surrogate pair is never split. */
export function truncateCodePoints(value: string, max: number): string {
    if (max <= 0) {
        return "";
    }
    let count = 0;
    let end = 0;
    for (const point of value) {
        if (count === max) {
            return value.slice(0, end);
        }
        count += 1;
        end += point.length;
    }
    return value;
}
