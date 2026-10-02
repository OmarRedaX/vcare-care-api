import { randomUUID } from "node:crypto";
import { request } from "undici";
import { currentRequestId } from "../logger/request-context";
import { JWKS_FETCH_TIMEOUT_MS, JWKS_MAX_BYTES } from "./constants";
import type { JwksFailureReason } from "./types";

const ACCEPTED_CONTENT_TYPES = ["application/json", "application/jwk-set+json"];
const TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"]);

/** A failed JWKS fetch. Carries a bounded reason (and the HTTP status) — never the URL path or the body. */
export class JwksFetchError extends Error {
    constructor(
        readonly reason: JwksFailureReason,
        readonly status?: number,
    ) {
        super(`jwks_fetch_failed: ${reason}`);
        this.name = "JwksFetchError";
    }
}

function isTimeout(error: unknown, timeoutSignal: AbortSignal): boolean {
    if (timeoutSignal.aborted) {
        return true;
    }
    const code = (error as { code?: unknown } | null)?.code;
    const name = (error as { name?: unknown } | null)?.name;
    return (typeof code === "string" && TIMEOUT_CODES.has(code)) || name === "TimeoutError";
}

function headerValue(value: string | string[] | undefined): string {
    return (Array.isArray(value) ? value[0] : value) ?? "";
}

/**
 * GET Identity's public JWKS with `undici` (the only `undici` import in `src/` until `lib/identity-client`): one
 * 2 s budget for connect + headers + body, no redirects (any status but 200 fails), JSON content type only, body
 * capped at 64 KiB while it streams. Forwards `X-Request-Id` (the request's when triggered inside one, else a fresh
 * UUID — CLAUDE.md → API conventions). The response is parsed, NOT validated: `JwksCache` validates it.
 */
export async function fetchJwksDocument(url: string, signal: AbortSignal): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeoutSignal]);

    let response: Awaited<ReturnType<typeof request>>;
    try {
        response = await request(url, {
            method: "GET",
            headers: {
                accept: "application/json",
                "x-request-id": currentRequestId() ?? randomUUID(),
            },
            headersTimeout: JWKS_FETCH_TIMEOUT_MS,
            bodyTimeout: JWKS_FETCH_TIMEOUT_MS,
            signal: combined,
        });
    } catch (error) {
        throw new JwksFetchError(isTimeout(error, timeoutSignal) ? "timeout" : "network");
    }

    const discard = (): void => {
        response.body.destroy();
    };

    if (response.statusCode !== 200) {
        discard();
        throw new JwksFetchError("http_status", response.statusCode);
    }

    const contentType = headerValue(response.headers["content-type"]).toLowerCase();
    if (!ACCEPTED_CONTENT_TYPES.some((accepted) => contentType.startsWith(accepted))) {
        discard();
        throw new JwksFetchError("content_type");
    }

    const chunks: Buffer[] = [];
    let size = 0;
    try {
        for await (const chunk of response.body) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
            size += buffer.length;
            if (size > JWKS_MAX_BYTES) {
                discard();
                throw new JwksFetchError("too_large");
            }
            chunks.push(buffer);
        }
    } catch (error) {
        if (error instanceof JwksFetchError) {
            throw error;
        }
        throw new JwksFetchError(isTimeout(error, timeoutSignal) ? "timeout" : "network");
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
        throw new JwksFetchError("invalid_json");
    }
}
