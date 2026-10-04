import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { ToInt } from "../../validation/transforms";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "./page";

/** Query DTO every cursor-paginated list extends or composes. */
export class PaginationQueryDto {
    @IsOptional()
    @IsString()
    @MaxLength(1024)
    cursor?: string;

    @IsOptional()
    @ToInt()
    @IsInt()
    @Min(1)
    @Max(MAX_PAGE_LIMIT)
    limit?: number = DEFAULT_PAGE_LIMIT;
}
