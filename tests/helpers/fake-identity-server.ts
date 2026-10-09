import http from "node:http";
import type { AddressInfo } from "node:net";
import type { IdentityStatus } from "../../src/lib/identity-client/types";

export interface FakeIdentityCall { method: string; path: string; requestId: string | undefined; authorization: string | undefined }
/** One recorded `PATCH /internal/users/{id}/status` body (every attempt, including ones answered with a failure). */
export interface FakeIdentityStatusBody { userId: number; status: IdentityStatus; reason: string; actorUserId: number; requestId: string | undefined }
/** Identity's `StatusChangeRequest.reason` maxLength (contract), counted in code points. */
export const FAKE_IDENTITY_REASON_MAX = 500;
export interface FakeIdentityUser { id: number; fullName: string; avatarUrl: string | null; status: IdentityStatus }
export interface FakeIdentityOptions { down?: boolean; tokenFailures?: number; statusFailures?: number; statusFailureCode?: number; batchFailures?: number; slowMs?: number; malformed?: boolean; forceUnauthorized?: number; forceConflict?: boolean }

export class FakeIdentityServer {
    readonly users = new Map<number, FakeIdentityUser>();
    readonly calls: FakeIdentityCall[] = [];
    readonly statusBodies: FakeIdentityStatusBody[] = [];
    readonly options: FakeIdentityOptions = {};
    private readonly server = http.createServer((req, res) => { void this.handle(req, res).catch(() => { res.destroy(); }); });

    async start(): Promise<string> {
        await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
        return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    }

    async close(): Promise<void> { await new Promise<void>((resolve) => this.server.close(() => resolve())); }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const path = req.url ?? "";
        this.calls.push({ method: req.method ?? "", path, requestId: req.headers["x-request-id"] as string | undefined,
            authorization: req.headers.authorization });
        if (this.options.down) { res.destroy(); return; }
        const send = (status: number, data: unknown): void => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(this.options.malformed && status === 200 ? "{" : JSON.stringify(data));
        };
        if (this.options.slowMs) await new Promise((resolve) => setTimeout(resolve, this.options.slowMs));
        if (req.method === "POST" && path === "/internal/auth/token") {
            if (this.options.tokenFailures && this.options.tokenFailures-- > 0) { send(500, {}); return; }
            send(200, { success: true, data: { access_token: "fake-token", token_type: "Bearer", expires_in: 300,
                scope: "users:read users:status:write" } });
            return;
        }
        if (this.options.forceUnauthorized && this.options.forceUnauthorized-- > 0) { send(401, { success: false }); return; }
        if (req.method === "GET" && path.startsWith("/internal/users?ids=")) {
            if (this.options.batchFailures && this.options.batchFailures-- > 0) { send(500, {}); return; }
            const ids = new URL(path, "http://localhost").searchParams.get("ids")?.split(",").map(Number) ?? [];
            send(200, { success: true, data: ids.flatMap((id) => {
                const user = this.users.get(id);
                return user ? [{ ...user, role: "doctor", timezone: "UTC", locale: "en" }] : [];
            }) });
            return;
        }
        const match = /^\/internal\/users\/(\d+)\/status$/.exec(path);
        if (req.method === "PATCH" && match) {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
            const body = JSON.parse(Buffer.concat(chunks).toString()) as { status: IdentityStatus; reason: string; actorUserId: number };
            this.statusBodies.push({ userId: Number(match[1]), status: body.status, reason: body.reason, actorUserId: body.actorUserId, requestId: req.headers["x-request-id"] as string | undefined });
            if (this.options.statusFailures && this.options.statusFailures-- > 0) { send(this.options.statusFailureCode ?? 500, {}); return; }
            const user = this.users.get(Number(match[1]));
            if (!user) { send(404, { success: false, error: { code: "NotFound" } }); return; }
            // Mirrors Identity's StatusChangeRequest: a reason longer than 500 code points is a 400, never a status change.
            if (typeof body.reason !== "string" || [...body.reason].length > FAKE_IDENTITY_REASON_MAX) {
                send(400, { success: false, error: { code: "ValidationFailed", message: "Request validation failed", details: [{ field: "reason", issue: "must be at most 500 characters" }] } });
                return;
            }
            if (this.options.forceConflict) { send(409, { success: false, error: { code: "InvalidStatusTransition" } }); return; }
            const allowed = user.status === body.status ||
                (user.status === "pending" && (body.status === "active" || body.status === "rejected")) ||
                (user.status === "rejected" && body.status === "pending") ||
                (user.status === "active" && body.status === "suspended") ||
                (user.status === "suspended" && body.status === "active");
            if (!allowed) { send(409, { success: false, error: { code: "InvalidStatusTransition" } }); return; }
            user.status = body.status;
            send(200, { success: true, data: { id: user.id, status: user.status, updatedAt: new Date().toISOString() } });
            return;
        }
        send(404, { success: false });
    }
}
