import { IsInt, IsOptional, IsString, Max, MaxLength, MinLength, Min } from "class-validator";
import { PaginationQueryDto } from "../../../lib/http/pagination/pagination.request.dto";
import { IsIsoDateTimeWithOffset } from "../../../lib/validation/date-decorator";
import { NoControlCharacters } from "../../../lib/validation/string-decorators";
import { ToInt } from "../../../lib/validation/transforms";
import { AUDIT_ACTION_MAX_LENGTH, AUDIT_DATE_MAX_LENGTH, AUDIT_ENTITY_TYPE_MAX_LENGTH } from "../constants";

/** Whitelisted filters only (unknown query keys are rejected). Exact-match semantics; `entityId` requires `entityType` (service rule). */
export class ListAuditLogsQueryDto extends PaginationQueryDto {
    @IsOptional() @ToInt() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) actorUserId?: number;
    @IsOptional() @IsString() @MinLength(1) @MaxLength(AUDIT_ACTION_MAX_LENGTH) @NoControlCharacters("nul") action?: string;
    @IsOptional() @IsString() @MinLength(1) @MaxLength(AUDIT_ENTITY_TYPE_MAX_LENGTH) @NoControlCharacters("nul") entityType?: string;
    @IsOptional() @ToInt() @IsInt() @Min(1) entityId?: number;
    @IsOptional() @IsString() @MaxLength(AUDIT_DATE_MAX_LENGTH) @IsIsoDateTimeWithOffset() from?: string;
    @IsOptional() @IsString() @MaxLength(AUDIT_DATE_MAX_LENGTH) @IsIsoDateTimeWithOffset() to?: string;
}
