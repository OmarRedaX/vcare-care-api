import { errors, jwtVerify } from "jose";
import type { JWTHeaderParameters, JWTPayload } from "jose";
import { isAppError } from "../error/AppError";
import { TokenExpired, Unauthorized } from "../error/errors";
import type { Logger } from "../logger/logger";
import { logger as rootLogger } from "../logger/logger";
import type { AuthContext } from "../types/types";
import { isAccountStatus, isRole } from "../rbac/roles";
import { parsePositiveId } from "../../pkg/utils/id";
import {
    CLOCK_TOLERANCE_SECONDS,
    JWT_ALGORITHMS,
    JWT_AUDIENCE,
    JWT_ISSUER,
    JWT_REQUIRED_CLAIMS,
    MAX_JTI_LENGTH,
} from "./constants";
import type { KeySource, UserTokenVerifierOptions } from "./types";

/**
 * Verifies an Identity user access token locally (access spec §3.3.5; identity parity): EdDSA only, a key chosen by
 * `kid` from Identity's JWKS, `iss=vcare-identity`, `aud` ∋ `vcare-care`, `typ=user`, required `sub`/`exp`/`iat`/`jti`,
 * well-formed `sub`/`role`/`status`/`ev`, 30 s clock tolerance. Fails closed: anything unexpected is `Unauthorized`.
 * Never logs the token or any part of it.
 */
export class UserTokenVerifier {
    private readonly jwks: KeySource;
    private readonly now: () => Date;
    private readonly logger: Logger;

    constructor(options: UserTokenVerifierOptions) {
        this.jwks = options.jwks;
        this.now = options.now ?? (() => new Date());
        this.logger = options.logger ?? rootLogger;
    }

    /** Resolves the verified principal, or rejects with `Unauthorized` / `TokenExpired`. */
    async verify(token: string): Promise<AuthContext> {
        let payload: JWTPayload;
        try {
            const result = await jwtVerify(token, (header: JWTHeaderParameters) => this.resolveKey(header), {
                algorithms: JWT_ALGORITHMS,
                issuer: JWT_ISSUER,
                audience: JWT_AUDIENCE,
                clockTolerance: CLOCK_TOLERANCE_SECONDS,
                currentDate: this.now(),
                requiredClaims: JWT_REQUIRED_CLAIMS,
            });
            payload = result.payload;
        } catch (error) {
            throw this.mapError(error);
        }
        return toAuthContext(payload);
    }

    /** No `kid` → 401 without any fetch; an unknown `kid` after the gated refresh → 401. */
    private async resolveKey(header: JWTHeaderParameters) {
        const kid = header.kid;
        if (typeof kid !== "string" || kid.length === 0) {
            throw Unauthorized;
        }
        const key = await this.jwks.getKey(kid);
        if (key === undefined) {
            throw Unauthorized;
        }
        return key;
    }

    private mapError(error: unknown): Error {
        if (isAppError(error)) {
            return error;
        }
        // jose raises JWTExpired only after the signature verified.
        if (error instanceof errors.JWTExpired) {
            return TokenExpired;
        }
        if (error instanceof errors.JOSEError) {
            return Unauthorized;
        }
        // A bug (or the key source failing unexpectedly): fail closed, log the error — never the token.
        this.logger.error("token_verification_error", { error });
        return Unauthorized;
    }
}

/** Claim shape (identity parity). Any mismatch → `Unauthorized`. */
function toAuthContext(payload: JWTPayload): AuthContext {
    const userId = parsePositiveId(payload.sub);
    const { role, status, ev, typ, jti } = payload as Record<string, unknown>;
    if (
        typ !== "user" ||
        userId === undefined ||
        !isRole(role) ||
        !isAccountStatus(status) ||
        typeof ev !== "boolean" ||
        typeof jti !== "string" ||
        jti.length === 0 ||
        jti.length > MAX_JTI_LENGTH
    ) {
        throw Unauthorized;
    }
    return { userId, role, status, emailVerified: ev };
}
