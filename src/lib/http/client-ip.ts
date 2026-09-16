import type { Request } from "express";
import { getEnv } from "../config/env";

const IPV4_MAPPED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

function normalise(value: string | undefined): string {
    if (value === undefined || value.trim().length === 0) {
        return "unknown";
    }
    const trimmed = value.trim();
    return IPV4_MAPPED.exec(trimmed)?.[1] ?? trimmed;
}

/**
 * The ONE client-IP rule (Express `trust proxy` stays off). With `TRUST_PROXY_HOPS = n > 0` the n-th entry
 * from the right of `X-Forwarded-For` is the client — entries further left are caller-controlled and
 * must never be trusted.
 */
export function clientIp(req: Request, trustProxyHops?: number): string {
    const hops = trustProxyHops ?? getEnv().TRUST_PROXY_HOPS;
    if (hops > 0) {
        const header = req.headers["x-forwarded-for"];
        const raw = Array.isArray(header) ? header.join(",") : header;
        if (typeof raw === "string") {
            const entries = raw
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0);
            const candidate = entries[entries.length - hops];
            if (candidate !== undefined) {
                return normalise(candidate);
            }
        }
    }
    return normalise(req.socket.remoteAddress);
}
