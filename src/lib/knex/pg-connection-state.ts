import type { PgClientQueryState } from "./types";

/**
 * Pool `validate` for pg connections (spec §3.4.8). pg 8.23 without pipelining keeps a query whose `query_timeout`
 * fired after it was sent as `_activeQuery`, never destroys the socket, and never emits `error` — so Knex's own
 * validation passes and the pool would hand the dead connection out again, queueing every later query behind the
 * dead one. A free connection that still has an active, queued, or sent-but-unanswered query is therefore not idle:
 * returning `false` makes tarn destroy it (pg `end()` force-destroys the stream while a query is active) and create a
 * fresh one for the acquire.
 *
 * The fields are pg-private (the public `activeQuery` getter is deprecated for pg 9), so they are read ONLY here.
 * When their shape is unrecognised the connection is kept — the pre-fix behaviour — instead of discarding every
 * connection; the unit test fails first if a pg upgrade changes the shape.
 */
export function isConnectionIdle(connection: unknown): boolean {
    if (typeof connection !== "object" || connection === null || !("_activeQuery" in connection)) {
        return true;
    }
    const state: PgClientQueryState = connection;
    const queued = state._queryQueue;
    const sent = state._sentQueryQueue;
    if (!Array.isArray(queued) || !Array.isArray(sent)) {
        return true;
    }
    return state._activeQuery == null && queued.length === 0 && sent.length === 0;
}
