import { registerDecorator } from "class-validator";
import { isCalendarDate } from "../../pkg/slots/local-date";

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
