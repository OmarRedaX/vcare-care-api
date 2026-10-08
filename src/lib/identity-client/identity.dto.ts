import { Type } from "class-transformer";
import { Equals, IsArray, IsIn, IsInt, IsNotEmpty, IsOptional, IsPositive, IsString, IsUrl, MaxLength, Min, ValidateNested } from "class-validator";

export class TokenDataDto {
    @IsString() @IsNotEmpty() access_token!: string;
    @Equals("Bearer") token_type!: string;
    @IsInt() @Min(1) expires_in!: number;
    @IsString() @IsNotEmpty() scope!: string;
}
export class TokenEnvelopeDto {
    @Equals(true) success!: true;
    @ValidateNested() @Type(() => TokenDataDto) data!: TokenDataDto;
}
export class UserSummaryDto {
    @IsInt() @IsPositive() id!: number;
    @IsString() @IsNotEmpty() fullName!: string;
    @IsOptional() @IsUrl({ require_protocol: true }) avatarUrl!: string | null;
    @IsIn(["patient", "doctor", "admin"]) role!: string;
    @IsIn(["active", "rejected", "pending", "suspended"]) status!: "active" | "rejected" | "pending" | "suspended";
    @IsString() @IsNotEmpty() timezone!: string;
    @IsString() @IsNotEmpty() locale!: string;
}
export class UsersEnvelopeDto {
    @Equals(true) success!: true;
    @IsArray() @ValidateNested({ each: true }) @Type(() => UserSummaryDto) data!: UserSummaryDto[];
}
export class StatusDataDto {
    @IsInt() @IsPositive() id!: number;
    @IsIn(["active", "rejected", "pending", "suspended"]) status!: string;
    @IsString() @IsNotEmpty() updatedAt!: string;
}
export class StatusEnvelopeDto {
    @Equals(true) success!: true;
    @ValidateNested() @Type(() => StatusDataDto) data!: StatusDataDto;
}
export class CachedUserDto {
    @IsString() @IsNotEmpty() @MaxLength(120) fullName!: string;
    @IsOptional() @IsUrl({ require_protocol: true }) avatarUrl!: string | null;
    @IsIn(["active", "rejected", "pending", "suspended"]) status!: "active" | "rejected" | "pending" | "suspended";
}
