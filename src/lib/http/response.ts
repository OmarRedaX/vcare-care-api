import type { Response } from "express";
import type { SendSuccessOptions } from "./types";

/** The one success envelope: `{ success: true, data, meta? }`. `meta` is omitted when not provided; `siblings` render next to `data` and never replace `success`/`data`. */
export function sendSuccess<T>(res: Response, data: T, options?: SendSuccessOptions): void {
    const body: Record<string, unknown> = { ...options?.siblings, success: true, data };
    if (options?.meta !== undefined) {
        body.meta = options.meta;
    }
    res.status(options?.status ?? 200).json(body);
}

export function sendNoContent(res: Response): void {
    res.status(204).end();
}
