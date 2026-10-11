import { Transform } from "class-transformer";

/** Convert only the exact string booleans; leave other values for IsBoolean to reject. */
export function ToBoolean(): PropertyDecorator {
    return Transform(({ value }: { value: unknown }) => {
        if (value === "true") return true;
        if (value === "false") return false;
        return value;
    }, { toClassOnly: true });
}

/** Convert canonical safe integer strings; leave other values for IsInt to reject. */
export function ToInt(): PropertyDecorator {
    return Transform(({ value }: { value: unknown }) => {
        if (typeof value === "string" && /^-?(0|[1-9][0-9]*)$/.test(value)) {
            const number = Number(value);
            if (Number.isSafeInteger(number)) return number;
        }
        return value;
    }, { toClassOnly: true });
}

/**
 * `a,b,c` to `["a","b","c"]` (empty segments stay, so `IsIn` rejects them). A repeated query parameter arrives as an array and
 * is wrapped so each-item validators reject it: one comma-separated parameter is the only accepted form.
 */
export function ToCommaList(): PropertyDecorator {
    return Transform(({ value }: { value: unknown }) => {
        if (typeof value === "string") return value.split(",");
        if (Array.isArray(value)) return [value];
        return value;
    }, { toClassOnly: true });
}
