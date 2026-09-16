import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestContext } from "./types";

/**
 * Opened by `requestId()` for the whole request, so log lines written deep inside services,
 * repositories, promise continuations, and timers carry the request id without threading a logger through.
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequestId(): string | undefined {
    return requestContext.getStore()?.requestId;
}
