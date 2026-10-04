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
