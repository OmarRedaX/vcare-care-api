import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, Equals, IsArray, IsString, Length, Matches, ValidateNested } from "class-validator";
import { JWKS_MAX_KEYS } from "./constants";

/**
 * One key of Identity's JWKS — mirrors the hub copy of Identity's contract (`Jwk`). Validated, never trusted
 * (CLAUDE.md → Cross-service integration: a malformed response is a failure, not data). The contract's `Jwk` allows
 * extra members, so unknown PUBLIC members (`key_ops`, `x5t`, …) are stripped (`unknownMembers: "strip"`), never
 * imported; the six members below stay strict.
 */
export class JwkDto {
    @Equals("OKP")
    kty!: string;

    @Equals("Ed25519")
    crv!: string;

    /** base64url Ed25519 public key: 32 bytes = 43 characters, no padding. */
    @IsString()
    @Matches(/^[A-Za-z0-9_-]{43}$/)
    x!: string;

    @IsString()
    @Length(1, 128)
    kid!: string;

    @Equals("EdDSA")
    alg!: string;

    @Equals("sig")
    use!: string;

    /** The Ed25519 PRIVATE key member: its presence means Identity is leaking key material — refuse the whole set. */
    @Equals(undefined, { message: "private key material is not allowed" })
    d?: never;
}

/** Identity's `GET /.well-known/jwks.json` body (`Jwks`). Unknown members are stripped (see `JwkDto`). */
export class JwksDocumentDto {
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(JWKS_MAX_KEYS)
    @ValidateNested({ each: true })
    @Type(() => JwkDto)
    keys!: JwkDto[];
}
