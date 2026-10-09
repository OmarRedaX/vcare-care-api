import { registerDecorator } from "class-validator";
import { isCalendarDate } from "../../pkg/slots/local-date";
import { parseIsoDateTimeWithOffset } from "../../pkg/utils/iso-datetime";

/** A real calendar date written `YYYY-MM-DD` (`2027-02-30` is rejected). Domain-free, so it lives in `lib/validation`. */
export function IsCalendarDate(): PropertyDecorator {
    return (target, propertyKey) => registerDecorator({
        name: "isCalendarDate", target: target.constructor, propertyName: String(propertyKey),
        validator: {
            validate(value: unknown): boolean { return typeof value === "string" && isCalendarDate(value); },
            defaultMessage(): string { return "must be a valid calendar date"; },
        },
    });
}

/** An ISO-8601 date-time with a UTC offset (`Z` or `±HH:MM`), see `parseIsoDateTimeWithOffset`. Domain-free. */
export function IsIsoDateTimeWithOffset(): PropertyDecorator {
    return (target, propertyKey) => registerDecorator({
        name: "isIsoDateTimeWithOffset", target: target.constructor, propertyName: String(propertyKey),
        validator: {
            validate(value: unknown): boolean { return parseIsoDateTimeWithOffset(value) !== undefined; },
            defaultMessage(): string { return "must be an ISO-8601 date-time with a UTC offset"; },
        },
    });
}
