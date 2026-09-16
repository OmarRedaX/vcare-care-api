import type { Request } from "express";
import { clientIp } from "../http/client-ip";

export const byIp = (req: Request): string | null => clientIp(req);

export const byUser = (req: Request): string | null => (req.auth !== undefined ? String(req.auth.userId) : null);
