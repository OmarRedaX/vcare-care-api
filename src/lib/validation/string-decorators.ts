import { registerDecorator } from "class-validator";
import type { ControlCharacterPolicy } from "./types";

/** JSON Schema and Postgres char_length count Unicode code points. */
export function CodePointLength(min: number, max: number): PropertyDecorator {
    return (target, propertyKey) => registerDecorator({
        name: "codePointLength",
        target: target.constructor,
        propertyName: String(propertyKey),
        validator: {
            validate(value: unknown): boolean {
                return typeof value === "string" && [...value].length >= min && [...value].length <= max;
            },
            defaultMessage(): string {
                return `must be between ${min} and ${max} code points`;
            },
        },
    });
}

/** Reject Postgres-incompatible NUL, or every Unicode control character for display text. */
export function NoControlCharacters(policy: ControlCharacterPolicy): PropertyDecorator {
    return (target, propertyKey) => registerDecorator({
        name: "noControlCharacters",
        target: target.constructor,
        propertyName: String(propertyKey),
        validator: {
            validate(value: unknown): boolean {
                return typeof value === "string" && (policy === "all" ? !/\p{Cc}/u.test(value) : !value.includes("\u0000"));
            },
            defaultMessage(): string {
                return policy === "all" ? "must not contain control characters" : "must not contain a NUL character";
            },
        },
    });
}

/**
 * Rejects empty and whitespace-only text (U+3000, U+00A0 and U+FEFF count as whitespace, like `\s`). Text forwarded to Identity
 * must pass this: Identity answers a blank reason with a non-retryable 400.
 */
export function NotBlank(): PropertyDecorator {
    return (target, propertyKey) => registerDecorator({
        name: "notBlank",
        target: target.constructor,
        propertyName: String(propertyKey),
        validator: {
            validate(value: unknown): boolean {
                return typeof value === "string" && /\S/.test(value);
            },
            defaultMessage(): string {
                return "must not be blank";
            },
        },
    });
}
