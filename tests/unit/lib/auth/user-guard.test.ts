import express from "express";
import request from "supertest";
import { MAX_BEARER_TOKEN_LENGTH } from "../../../../src/lib/auth/constants";
import { userGuard } from "../../../../src/lib/auth/user-guard";
import type { UserTokenVerifier } from "../../../../src/lib/auth/user-token-verifier";
import { container } from "../../../../src/lib/di/container";
import { TOKENS } from "../../../../src/lib/di/tokens";
import { errorHandler } from "../../../../src/lib/error/errorHandler";
import { TokenExpired, Unauthorized } from "../../../../src/lib/error/errors";
import { requestContext } from "../../../../src/lib/logger/request-context";
import { isAuthorizeHandler, isGuardHandler } from "../../../../src/lib/rbac/markers";
import { requestId } from "../../../../src/lib/request-id/request-id";
import type { AuthContext } from "../../../../src/lib/types/types";

const PATIENT: AuthContext = { userId: 101, role: "patient", status: "active", emailVerified: true };

function fakeVerifier(outcome: AuthContext | Error = PATIENT) {
    const verify = jest.fn((_token: string) =>
        outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve({ ...outcome }),
    );
    return { verify, verifier: { verify } as unknown as UserTokenVerifier };
}

function app(verifier?: UserTokenVerifier) {
    const instance = express();
    instance.use(requestId());
    instance.get("/api/things/:id", userGuard(verifier === undefined ? undefined : { verifier }), (req, res) => {
        const store = requestContext.getStore();
        res.json({ auth: req.auth, context: { userId: store?.userId, role: store?.role } });
    });
    instance.use(errorHandler);
    return instance;
}

describe("lib/auth/userGuard", () => {
    it.each<[string, string | undefined]>([
        ["the header is missing", undefined],
        ["the scheme is not Bearer", "Basic dXNlcjpwYXNz"],
        ["the token is empty", "Bearer "],
        ["there are two tokens", "Bearer aaa bbb"],
        ["the scheme has no space", "Bearertoken"],
        ["the token exceeds 4 096 chars", `Bearer ${"a".repeat(MAX_BEARER_TOKEN_LENGTH + 1)}`],
    ])("should return 401 Unauthorized without verifying when %s", async (_label, header) => {
        const { verify, verifier } = fakeVerifier();
        const req = request(app(verifier)).get("/api/things/1");
        const res = header === undefined ? await req : await req.set("Authorization", header);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe("Unauthorized");
        expect(verify).not.toHaveBeenCalled();
    });

    it("should verify a token of exactly 4 096 chars and accept a lower-case scheme", async () => {
        const { verify, verifier } = fakeVerifier();
        const token = "a".repeat(MAX_BEARER_TOKEN_LENGTH);
        expect((await request(app(verifier)).get("/api/things/1").set("Authorization", `Bearer ${token}`)).status).toBe(200);
        expect((await request(app(verifier)).get("/api/things/1").set("Authorization", "bearer tok")).status).toBe(200);
        expect(verify.mock.calls.map((call) => call[0])).toEqual([token, "tok"]);
    });

    it("should set req.auth and the request-context userId and role when verification succeeds", async () => {
        const { verifier } = fakeVerifier({ userId: 77, role: "doctor", status: "pending", emailVerified: false });
        const res = await request(app(verifier)).get("/api/things/1").set("Authorization", "Bearer good");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            auth: { userId: 77, role: "doctor", status: "pending", emailVerified: false },
            context: { userId: 77, role: "doctor" },
        });
    });

    it("should ignore X-User-Id, X-Role, and X-Forwarded-User when a token is present (A1)", async () => {
        const { verifier } = fakeVerifier();
        const res = await request(app(verifier))
            .get("/api/things/1")
            .set("Authorization", "Bearer good")
            .set("X-User-Id", "999")
            .set("X-Role", "admin")
            .set("X-Forwarded-User", "admin@example.test");
        expect(res.body.auth).toEqual(PATIENT);
        expect(res.body.context).toEqual({ userId: 101, role: "patient" });
    });

    it("should return 401 when only identity headers are sent (A1)", async () => {
        const { verify, verifier } = fakeVerifier();
        const res = await request(app(verifier)).get("/api/things/1").set("X-User-Id", "101").set("X-Role", "admin");
        expect(res.status).toBe(401);
        expect(verify).not.toHaveBeenCalled();
    });

    it.each([
        [Unauthorized, 401, "Unauthorized"],
        [TokenExpired, 401, "TokenExpired"],
    ])("should forward the verifier's %p rejection", async (error, status, code) => {
        const { verifier } = fakeVerifier(error);
        const res = await request(app(verifier)).get("/api/things/1").set("Authorization", "Bearer bad");
        expect(res.status).toBe(status);
        expect(res.body.error.code).toBe(code);
    });

    it("should carry GUARD_MARKER and not AUTHORIZE_MARKER", () => {
        const guard = userGuard();
        expect(isGuardHandler(guard)).toBe(true);
        expect(isAuthorizeHandler(guard)).toBe(false);
        expect(Object.keys(guard)).toEqual([]); // the marker is non-enumerable
    });

    it("should resolve the container's verifier per request when none is passed", async () => {
        const { verify, verifier } = fakeVerifier({ userId: 5, role: "admin", status: "active", emailVerified: true });
        const original = container.resolve<UserTokenVerifier>(TOKENS.UserTokenVerifier);
        const instance = app(); // built BEFORE the override: the guard must still see it
        container.registerInstance(TOKENS.UserTokenVerifier, verifier);
        try {
            const res = await request(instance).get("/api/things/1").set("Authorization", "Bearer x");
            expect(res.body.auth.userId).toBe(5);
            expect(verify).toHaveBeenCalledTimes(1);
        } finally {
            container.registerInstance(TOKENS.UserTokenVerifier, original);
        }
    });
});
