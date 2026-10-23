/** Lets pending I/O callbacks and timers run; CPU-bound loops call it between chunks so one long loop does not starve the process. */
export function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}
