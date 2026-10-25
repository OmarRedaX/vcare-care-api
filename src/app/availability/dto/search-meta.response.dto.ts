import type { DegradedPart } from "../enums";
import type { SearchMeta } from "../types";

/** `PaginationMeta` plus `degraded`, which is present only when a requested part could not be honoured (contract C5). */
export class SearchMetaResponseDto {
    nextCursor!: string | null;
    hasMore!: boolean;
    count!: number;
    degraded?: DegradedPart[];

    static from(meta: SearchMeta): SearchMetaResponseDto {
        const dto: SearchMetaResponseDto = { nextCursor: meta.nextCursor, hasMore: meta.hasMore, count: meta.count };
        if (meta.degraded !== undefined && meta.degraded.length > 0) dto.degraded = [...meta.degraded];
        return dto;
    }
}
