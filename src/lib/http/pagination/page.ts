import { encodeCursor } from "./cursor";
import type { Page } from "./types";

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export function resolveLimit(limit: number | undefined): number {
    return limit ?? DEFAULT_PAGE_LIMIT;
}

/**
 * Builds a keyset page from rows fetched with `limit + 1`: the extra row proves `hasMore` without a COUNT.
 * `positionOf` returns the `(sortValue, id)` pair of the row, matching the query's ORDER BY.
 */
export function buildPage<T>(rows: T[], limit: number, positionOf: (row: T) => [string | number, number]): Page<T> {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];

    let nextCursor: string | null = null;
    if (hasMore && last !== undefined) {
        const [sortValue, id] = positionOf(last);
        nextCursor = encodeCursor(sortValue, id);
    }

    return { items, meta: { nextCursor, hasMore, count: items.length } };
}
