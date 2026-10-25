import { ValidationFailed } from "../../lib/error/errors";
import { FREE_MAP_BUCKET_MS } from "../../pkg/slots/free-map";
import { parseIsoDateTimeWithOffset } from "../../pkg/utils/iso-datetime";
import type { Candidate } from "../doctors/types";
import { DAY_MS, LOOKAHEAD_DAYS, NONE_SCORE, SEARCH_NAME_MIN_CODE_POINTS } from "./constants";
import { DiscoveryCursorKind, SearchSortKind, WindowMatchVerdict } from "./enums";
import type { DiscoveryCursor, SlotWindow } from "./types";

const MAX_SPAN_MS = LOOKAHEAD_DAYS * DAY_MS;

function invalid(field: string, issue: string): Error {
    return ValidationFailed.withDetails([{ field, issue }]);
}

function parseSupplied(raw: string, field: string, nowMs: number): number {
    const value = parseIsoDateTimeWithOffset(raw)?.getTime();
    if (value === undefined) throw invalid(field, "must be an ISO-8601 datetime with offset");
    if (value < nowMs || value > nowMs + MAX_SPAN_MS) throw invalid(field, "must be between now and 14 days from now");
    return value;
}

/**
 * AV-R16: the search availability window `[from, to)`, or `undefined` when no window parameter is supplied. A missing `from` is now, a missing `to` is
 * `from + 14 d` clipped to `now + 14 d` (D8); supplied values must lie in `[now, now + 14 d]`, `to` after `from`, at most 14 days apart.
 */
export function resolveSearchWindow(availableFrom: string | undefined, availableTo: string | undefined, nowMs: number): SlotWindow | undefined {
    if (availableFrom === undefined && availableTo === undefined) return undefined;
    const fromMs = availableFrom === undefined ? nowMs : parseSupplied(availableFrom, "availableFrom", nowMs);
    const toMs = availableTo === undefined ? Math.min(fromMs + MAX_SPAN_MS, nowMs + MAX_SPAN_MS) : parseSupplied(availableTo, "availableTo", nowMs);
    if (toMs <= fromMs) throw invalid(availableTo === undefined ? "availableFrom" : "availableTo", "must leave a window: availableTo must be after availableFrom");
    if (toMs - fromMs > MAX_SPAN_MS) throw invalid("availableTo", "must be at most 14 days after availableFrom");
    return { fromMs, toMs };
}

/** AV-R15: `minFee` above `maxFee` can match nothing and is a request error. */
export function assertFeeRange(minFee: number | undefined, maxFee: number | undefined): void {
    if (minFee !== undefined && maxFee !== undefined && minFee > maxFee) throw invalid("minFee", "must not be greater than maxFee");
}

/**
 * The lower-cased headline prefix of the `name` filter: NFC, trimmed, whitespace runs collapsed, then at least 2 code points (else `400`).
 * Slice 3 replaces this with the shared `normalizeName` used by the name index.
 */
export function resolveNamePrefix(name: string | undefined): string | undefined {
    if (name === undefined) return undefined;
    const prefix = name.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
    if ([...prefix].length < SEARCH_NAME_MIN_CODE_POINTS) throw invalid("name", "must have at least 2 characters");
    return prefix;
}

/** The order the list is served in: the sort, or price order when `earliest_availability` cannot use the index (AV-R20). */
export function effectiveKind(sort: SearchSortKind, indexUsable: boolean): DiscoveryCursorKind {
    if (sort === SearchSortKind.Price) return DiscoveryCursorKind.Price;
    if (sort === SearchSortKind.Experience) return DiscoveryCursorKind.Experience;
    return indexUsable ? DiscoveryCursorKind.Earliest : DiscoveryCursorKind.Degraded;
}

/** A score of a doctor with no usable index entry ranks last, like a known-none doctor. */
function scoreOf(candidate: Candidate, scores: ReadonlyMap<number, number>): number {
    return scores.get(candidate.userId) ?? NONE_SCORE;
}

/** AV-R17: `earliest` = `(score, id)` ascending; `price` and `degraded` = `(fee, id)` ascending; `experience` = `(years, id)` descending. */
export function orderCandidates(candidates: readonly Candidate[], kind: DiscoveryCursorKind, scores: ReadonlyMap<number, number>): Candidate[] {
    const ordered = [...candidates];
    switch (kind) {
        case DiscoveryCursorKind.Earliest:
            return ordered.sort((a, b) => scoreOf(a, scores) - scoreOf(b, scores) || a.profileId - b.profileId);
        case DiscoveryCursorKind.Experience:
            return ordered.sort((a, b) => b.years - a.years || b.profileId - a.profileId);
        default:
            return ordered.sort((a, b) => a.fee - b.fee || a.profileId - b.profileId);
    }
}

/** The sort value a cursor carries for a candidate under `kind`. */
export function cursorValueOf(candidate: Candidate, kind: DiscoveryCursorKind, scores: ReadonlyMap<number, number>): number {
    if (kind === DiscoveryCursorKind.Earliest) return scoreOf(candidate, scores);
    if (kind === DiscoveryCursorKind.Experience) return candidate.years;
    return candidate.fee;
}

/** Keyset skip over an ordered list: the candidates strictly after `(after.v, after.id)` in the order of `kind`. */
export function applyCursor(ordered: readonly Candidate[], kind: DiscoveryCursorKind, scores: ReadonlyMap<number, number>, after: DiscoveryCursor | null): Candidate[] {
    if (after === null) return [...ordered];
    const descending = kind === DiscoveryCursorKind.Experience;
    return ordered.filter((candidate) => {
        const value = cursorValueOf(candidate, kind, scores);
        if (value === after.v) return descending ? candidate.profileId < after.id : candidate.profileId > after.id;
        return descending ? value < after.v : value > after.v;
    });
}

/**
 * Settles a window filter from the rank-index score alone where it can (availability spec 12.2.2): with `sB` the bucket of the earliest start, a
 * start after the window's last bucket matches nothing, a start inside matches, and an earlier start says nothing about the window (the free-map
 * decides). A known-none doctor never matches. Equal to evaluating the map alone by construction.
 */
export function matchBySchedule(score: number, window: SlotWindow): WindowMatchVerdict {
    if (score >= NONE_SCORE) return WindowMatchVerdict.NoMatch;
    const scoreBucket = Math.floor(score / FREE_MAP_BUCKET_MS);
    const fromBucket = Math.floor(window.fromMs / FREE_MAP_BUCKET_MS);
    const toBucket = Math.floor((window.toMs - 1) / FREE_MAP_BUCKET_MS);
    if (scoreBucket > toBucket) return WindowMatchVerdict.NoMatch;
    return scoreBucket >= fromBucket ? WindowMatchVerdict.Match : WindowMatchVerdict.NeedsMap;
}
