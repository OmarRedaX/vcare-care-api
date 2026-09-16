/**
 * Nothing global to close: each suite destroys the `db` pool and quits its Redis client in `afterAll`.
 * An open handle after the run is a bug, not something to paper over with `forceExit`.
 */
export default function globalTeardown(): void {
    // intentionally empty
}
