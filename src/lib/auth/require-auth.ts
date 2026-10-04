import type { Request } from "express";
import { Unauthorized } from "../error/errors";
import type { AuthContext } from "../types/types";

/** The verified principal set by userGuard. Throws Unauthorized if absent. */
export function requireAuth(req: Request): AuthContext {
    if (req.auth === undefined) {
        throw Unauthorized;
    }
    return req.auth;
}
