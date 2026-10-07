import type { ClassConstructor } from "class-transformer";
import { plainToInstance } from "class-transformer";
import type { ValidationError } from "class-validator";
import { validate } from "class-validator";
import { ValidationFailed } from "../error/errors";
import type { ErrorDetail } from "../error/types";
import type { ValidateOptions, ValidationSource } from "./types";

/** Rejected VALUES are never echoed — only the field path and the failed constraint. */
export function toErrorDetails(errors: ValidationError[]): ErrorDetail[] {
    const details: ErrorDetail[] = [];

    const walk = (error: ValidationError, prefix: string): void => {
        const field = prefix === "" ? error.property : `${prefix}.${error.property}`;
        const constraints = error.constraints;
        if (constraints !== undefined) {
            const isWhitelistFailure = Object.keys(constraints).includes("whitelistValidation");
            const firstMessage = Object.values(constraints)[0] ?? "is invalid";
            details.push({ field, issue: isWhitelistFailure ? "is not allowed" : firstMessage });
        }
        for (const child of error.children ?? []) {
            walk(child, field);
        }
    };

    for (const error of errors) {
        walk(error, "");
    }

    return details.sort((a, b) => a.field.localeCompare(b.field));
}

async function validateInput<T extends object>(
    dto: ClassConstructor<T>,
    input: unknown,
    source: ValidationSource,
    options?: ValidateOptions,
): Promise<T> {
    if (source === "body" && (typeof input !== "object" || input === null || Array.isArray(input))) {
        throw ValidationFailed.withDetails([{ field: "body", issue: "must be a JSON object" }]);
    }

    const instance = plainToInstance(dto, input ?? {}, {
        enableImplicitConversion: false,
        exposeDefaultValues: true,
    });

    const errors = await validate(instance as object, {
        whitelist: true,
        forbidNonWhitelisted: (options?.unknownMembers ?? "reject") === "reject",
        forbidUnknownValues: true,
        validationError: { target: false, value: false },
    });

    if (errors.length > 0) {
        throw ValidationFailed.withDetails(toErrorDetails(errors));
    }

    return instance;
}

export function validateBody<T extends object>(dto: ClassConstructor<T>, input: unknown, options?: ValidateOptions): Promise<T> {
    return validateInput(dto, input, "body", options);
}

export function validateQuery<T extends object>(dto: ClassConstructor<T>, input: unknown): Promise<T> {
    return validateInput(dto, input, "query");
}

export function validateParams<T extends object>(dto: ClassConstructor<T>, input: unknown): Promise<T> {
    return validateInput(dto, input, "params");
}

/** For routes that take no body: `{}` / absent passes, any member is rejected. A property-less DTO cannot do this (class-validator rejects it as an unknown value). */
export function assertEmptyBody(input: unknown): void {
    if (input === undefined || input === null) {
        return;
    }
    if (typeof input !== "object" || Array.isArray(input)) {
        throw ValidationFailed.withDetails([{ field: "body", issue: "must be a JSON object" }]);
    }
    const details = Object.keys(input).sort().map((field) => ({ field, issue: "is not allowed" }));
    if (details.length > 0) {
        throw ValidationFailed.withDetails(details);
    }
}
