import { validateBody } from "../validation/validate";
import { TokenEnvelopeDto } from "./identity.dto";
import type { ServiceTokenCacheOptions } from "./types";

export class ServiceTokenCache {
    private token: string | null = null;
    private expiresAt = 0;
    private inFlight: Promise<string> | null = null;
    private readonly now: () => number;

    constructor(private readonly options: ServiceTokenCacheOptions) {
        this.now = options.now ?? Date.now;
    }

    get(requestId: string): Promise<string> {
        if (this.token !== null && this.now() < this.expiresAt - 30_000) return Promise.resolve(this.token);
        if (this.inFlight !== null) return this.inFlight;
        const pending = this.fetch(requestId);
        this.inFlight = pending;
        void pending.finally(() => { this.inFlight = null; }).catch(() => undefined);
        return pending;
    }

    invalidate(token?: string): void {
        if (token === undefined || token === this.token) {
            this.token = null;
            this.expiresAt = 0;
        }
    }

    private async fetch(requestId: string): Promise<string> {
        const startedAt = this.now();
        const response = await this.options.pool.request({
            path: "/internal/auth/token", method: "POST",
            headers: { "content-type": "application/json", accept: "application/json", "x-request-id": requestId },
            body: JSON.stringify({ grant_type: "client_credentials", client_id: this.options.env.SERVICE_CLIENT_ID,
                client_secret: this.options.env.SERVICE_CLIENT_SECRET, audience: "vcare-identity", scope: "users:read users:status:write" }),
            headersTimeout: 2_000, bodyTimeout: 2_000, signal: AbortSignal.timeout(2_000),
        });
        if (response.statusCode !== 200) {
            await response.body.dump();
            throw new Error(`HTTP_${response.statusCode}`);
        }
        const data = await validateBody(TokenEnvelopeDto, await response.body.json(), { unknownMembers: "strip" });
        if (!data.data.scope.split(" ").includes("users:read") || !data.data.scope.split(" ").includes("users:status:write")) {
            throw new Error("MalformedResponse");
        }
        this.token = data.data.access_token;
        this.expiresAt = startedAt + data.data.expires_in * 1_000;
        return this.token;
    }
}
