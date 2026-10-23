import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from "class-validator";
import { DEFAULT_PAGE_LIMIT } from "../../../lib/http/pagination/page";
import { PaginationQueryDto } from "../../../lib/http/pagination/pagination.request.dto";
import { IsIsoDateTimeWithOffset } from "../../../lib/validation/date-decorator";
import { NoControlCharacters } from "../../../lib/validation/string-decorators";
import { IsIanaTimezone } from "../../../lib/validation/timezone-decorator";
import { ToInt } from "../../../lib/validation/transforms";
import { FEE_AMOUNT_MAX, LANGUAGE_CODE_PATTERN, TIMEZONE_MAX_LENGTH } from "../../doctors/constants";
import { SearchSortKind } from "../enums";
import type { DoctorSlotsQuery, GetDoctorQuery, SearchDoctorsQuery } from "../types";

export class DoctorSlotsQueryDto {
    @ToInt() @IsInt() @Min(1) typeId!: number;
    @IsString() @MaxLength(40) @IsIsoDateTimeWithOffset() from!: string;
    @IsString() @MaxLength(40) @IsIsoDateTimeWithOffset() to!: string;
    @IsOptional() @IsString() @MaxLength(64) @IsIanaTimezone() timezone?: string;
    toQuery(): DoctorSlotsQuery { return { typeId: this.typeId, from: this.from, to: this.to, timezone: this.timezone }; }
}

/** `GET /api/doctors/{doctorUserId}` query: only the rendering zone. */
export class GetDoctorQueryDto {
    @IsOptional() @IsString() @MaxLength(TIMEZONE_MAX_LENGTH) @IsIanaTimezone() timezone?: string;
    toQuery(): GetDoctorQuery { return { timezone: this.timezone }; }
}

/** `GET /api/doctors` query (availability spec 3.3): whitelisted filters, a sort, and keyset pagination; unknown keys are rejected. */
export class SearchDoctorsQueryDto extends PaginationQueryDto {
    @IsOptional() @IsString() @MinLength(1) @MaxLength(100) specialty?: string;
    @IsOptional() @IsString() @Matches(LANGUAGE_CODE_PATTERN) language?: string;
    @IsOptional() @IsString() @MinLength(2) @MaxLength(100) @NoControlCharacters("all") name?: string;
    @IsOptional() @ToInt() @IsInt() @Min(0) @Max(FEE_AMOUNT_MAX) minFee?: number;
    @IsOptional() @ToInt() @IsInt() @Min(0) @Max(FEE_AMOUNT_MAX) maxFee?: number;
    @IsOptional() @IsString() @MaxLength(40) @IsIsoDateTimeWithOffset() availableFrom?: string;
    @IsOptional() @IsString() @MaxLength(40) @IsIsoDateTimeWithOffset() availableTo?: string;
    @IsOptional() @IsIn(Object.values(SearchSortKind)) sort: SearchSortKind = SearchSortKind.EarliestAvailability;

    toQuery(): SearchDoctorsQuery {
        return { specialty: this.specialty, language: this.language, name: this.name, minFee: this.minFee, maxFee: this.maxFee,
            availableFrom: this.availableFrom, availableTo: this.availableTo, sort: this.sort, cursor: this.cursor, limit: this.limit ?? DEFAULT_PAGE_LIMIT };
    }
}
