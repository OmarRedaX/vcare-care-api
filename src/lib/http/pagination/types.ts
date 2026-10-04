export interface CursorPosition {
    sortValue: string | number;
    id: number;
}

export interface StringCursorPosition {
    sortValue: string;
    id: number;
}

export interface PageMeta {
    nextCursor: string | null;
    hasMore: boolean;
    count: number;
}

export interface Page<T> {
    items: T[];
    meta: PageMeta;
}
