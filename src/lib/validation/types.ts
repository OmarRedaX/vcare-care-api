export type ValidationSource = "body" | "query" | "params";

/**
 * What happens to members the DTO does not declare: `"reject"` (default — every request DTO: `forbidNonWhitelisted`)
 * or `"strip"` (removed before use — only for another service's response whose contract allows extra members, e.g.
 * Identity's JWKS). A DTO that must refuse a specific member under `"strip"` declares it and validates it explicitly.
 */
export type UnknownMembersPolicy = "reject" | "strip";

export interface ValidateOptions {
    unknownMembers?: UnknownMembersPolicy;
}
