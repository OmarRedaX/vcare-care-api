import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "./page";

/** Query DTO every cursor-paginated list extends or composes. */
export class PaginationQueryDto {
    @IsOptional()
    @IsString()
    @MaxLength(512)
    cursor?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(MAX_PAGE_LIMIT)
    limit?: number = DEFAULT_PAGE_LIMIT;
}
