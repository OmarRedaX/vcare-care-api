import { registerDecorator } from "class-validator";

/**
 * Each item of a string list is 1..maxLength code points, not blank, free of control characters, and the list has no
 * duplicates (exact match). Non-arrays are left to `IsArray`. The rejected value is never part of the message.
 */
export function IsTextList(maxLength: number): PropertyDecorator {
    return (target, propertyKey) => registerDecorator({
        name: "isTextList", target: target.constructor, propertyName: String(propertyKey),
        validator: {
            validate(value: unknown): boolean {
                if (!Array.isArray(value)) return true;
                const seen = new Set<string>();
                for (const item of value as unknown[]) {
                    if (typeof item !== "string") return false;
                    const length = [...item].length;
                    if (length < 1 || length > maxLength || !/\S/.test(item) || /\p{Cc}/u.test(item) || seen.has(item)) return false;
                    seen.add(item);
                }
                return true;
            },
            defaultMessage(): string { return `each item must be 1 to ${maxLength} characters, not blank, without control characters, and unique`; },
        },
    });
}
