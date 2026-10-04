import type { Request } from "express";
import { requireAuth } from "../../../../src/lib/auth/require-auth";
import { Unauthorized } from "../../../../src/lib/error/errors";
import type { AuthContext } from "../../../../src/lib/types/types";

describe("lib/auth/requireAuth", () => {
    it("should return the principal when userGuard has set req.auth", () => {
        const principal: AuthContext = { userId: 101, role: "patient", status: "active", emailVerified: true };
        const req = { auth: principal } as Request;

        expect(requireAuth(req)).toBe(principal);
    });

    it("should throw Unauthorized when req.auth is missing", () => {
        expect(() => requireAuth({} as Request)).toThrow(Unauthorized);
    });
});
