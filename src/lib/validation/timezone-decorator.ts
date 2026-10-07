import { registerDecorator } from "class-validator";
import { IANAZone } from "luxon";

/** Validate doctor and scheduling zones with the locked timezone library. */
export function IsIanaTimezone(): PropertyDecorator {
    return (target, propertyKey) => registerDecorator({
        name: "isIanaTimezone", target: target.constructor, propertyName: String(propertyKey),
        validator: {
            validate(value: unknown): boolean {
                if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
                return IANAZone.isValidZone(value);
            },
            defaultMessage(): string { return "must be a valid IANA timezone"; },
        },
    });
}

export function canonicalIanaTimezone(value: string): string {
    return new Intl.DateTimeFormat(undefined, { timeZone: value }).resolvedOptions().timeZone;
}
