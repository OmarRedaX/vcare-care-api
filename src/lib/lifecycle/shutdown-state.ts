/** Single source of truth for "are we shutting down?" — readiness returns 503 as soon as it flips. */
export class ShutdownState {
    private shuttingDown = false;

    isShuttingDown(): boolean {
        return this.shuttingDown;
    }

    markShuttingDown(): void {
        this.shuttingDown = true;
    }
}
