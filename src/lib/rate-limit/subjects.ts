import type { Request } from "express";
import type { Role } from "../types/types";
import { clientIp } from "../http/client-ip";

export const byIp = (req: Request): string | null => clientIp(req);

export const byUser = (req: Request): string | null => (req.auth !== undefined ? String(req.auth.userId) : null);

/** The user id for callers holding one of `roles`; `null` (limiter skipped) for every other principal. */
export const byUserOfRoles = (roles: readonly Role[]) => (req: Request): string | null =>
    req.auth !== undefined && roles.includes(req.auth.role) ? String(req.auth.userId) : null;
