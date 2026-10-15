import type { Pool } from "undici";
import { getEnv } from "../../../../src/lib/config/env";
import { CONTACT_SERVICE_SCOPES, STATUS_SERVICE_SCOPES } from "../../../../src/lib/identity-client/constants";
import { ServiceTokenCache } from "../../../../src/lib/identity-client/service-token-cache";

interface Stub { pool: Pool; bodies: string[] }

/** A pool whose token endpoint grants exactly `granted`, recording each request body. */
function stubPool(granted: string): Stub {
    const bodies: string[] = [];
    const pool = {
        request: (options: { body: string }) => {
            bodies.push(options.body);
            return Promise.resolve({
                statusCode: 200,
                body: { json: () => Promise.resolve({ success: true, data: { access_token: "t", token_type: "Bearer", expires_in: 300, scope: granted } }),
                    dump: () => Promise.resolve() },
            });
        },
    } as unknown as Pool;
    return { pool, bodies };
}

describe("ServiceTokenCache scopes", () => {
    it("should request the status scopes when none are given", async () => {
        const { pool, bodies } = stubPool(STATUS_SERVICE_SCOPES.join(" "));
        await new ServiceTokenCache({ pool, env: getEnv() }).get("r");
        expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({ scope: "users:read users:status:write", audience: "vcare-identity" });
    });

    it("should request only the contact scope when configured for contacts", async () => {
        const { pool, bodies } = stubPool("users:contact:read");
        await new ServiceTokenCache({ pool, env: getEnv(), scopes: CONTACT_SERVICE_SCOPES }).get("r");
        expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({ scope: "users:contact:read" });
    });

    it("should reject a token that lacks a requested scope", async () => {
        const { pool } = stubPool("users:read");
        await expect(new ServiceTokenCache({ pool, env: getEnv() }).get("r")).rejects.toThrow("InsufficientScope");
        const contact = stubPool("users:read users:status:write");
        await expect(new ServiceTokenCache({ pool: contact.pool, env: getEnv(), scopes: CONTACT_SERVICE_SCOPES }).get("r")).rejects.toThrow("InsufficientScope");
    });
});
