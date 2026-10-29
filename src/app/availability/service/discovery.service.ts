import { inject, injectable } from "tsyringe";
import type { Env } from "../../../lib/config/types";
import { TOKENS } from "../../../lib/di/tokens";
import { NotFound } from "../../../lib/error/errors";
import { hydrateUsersOrEmpty } from "../../../lib/identity-client/hydrate";
import type { IdentityClient } from "../../../lib/identity-client/identity-client";
import type { Logger } from "../../../lib/logger/logger";
import type { AuthContext, Clock } from "../../../lib/types/types";
import { localDateOf } from "../../../pkg/slots/local-date";
import { testFreeMap } from "../../../pkg/slots/free-map";
import type { SlotRange } from "../../../pkg/slots/types";
import { normalizeName } from "../../../pkg/utils/name";
import { DoctorDiscoveryReader } from "../../doctors/service/doctor-discovery.reader";
import { DoctorsService } from "../../doctors/service/doctors.service";
import { CandidateOrder } from "../../doctors/enums";
import type { Candidate, CandidateFilters, PublicDoctorView } from "../../doctors/types";
import { DAY_MS, LOG_CANDIDATES_TRUNCATED, LOOKAHEAD_DAYS, METRIC_DEGRADED, METRIC_INDEX_MISS, METRIC_INLINE_COMPUTE_MS, NONE_SCORE, PREVIEW_SLOT_COUNT } from "../constants";
import { decodeDiscoveryCursor, encodeDiscoveryCursor } from "../discovery-cursor";
import { DegradedPart, DiscoveryCursorKind, WindowMatchVerdict } from "../enums";
import { applyCursor, assertFeeRange, assertNamePrefix, cursorValueOf, effectiveKind, matchBySchedule, orderCandidates, resolveSearchWindow } from "../rules";
import type { ComputedEntry, DiscoveryCursor, DiscoveryItem, GetDoctorQuery, PageSelection, ProfileResult, SearchDoctorsQuery, SearchResult, SlotWindow } from "../types";
import { AvailabilityService } from "./availability.service";
import { NextAvailableComputer } from "./next-available.computer";
import { NextAvailableIndex } from "./next-available.index";

/** Reporting order of `meta.degraded` (AV-R20). */
const DEGRADED_ORDER: readonly DegradedPart[] = [DegradedPart.Sort, DegradedPart.AvailabilityFilter, DegradedPart.NameFilter];

@injectable()
export class DiscoveryService {
    constructor(
        @inject(TOKENS.DoctorDiscoveryReader) private readonly reader: DoctorDiscoveryReader,
        @inject(TOKENS.DoctorsService) private readonly doctors: DoctorsService,
        @inject(TOKENS.AvailabilityService) private readonly availability: AvailabilityService,
        @inject(TOKENS.NextAvailableIndex) private readonly index: NextAvailableIndex,
        @inject(TOKENS.NextAvailableComputer) private readonly computer: NextAvailableComputer,
        @inject(TOKENS.IDENTITY_CLIENT) private readonly identity: IdentityClient,
        @inject(TOKENS.Logger) private readonly logger: Logger,
        @inject(TOKENS.Env) private readonly env: Env,
        @inject(TOKENS.Clock) private readonly clock: Clock,
    ) {}

    /**
     * `GET /api/doctors`. Validates the cross-field rules, ranks the bookable candidates (the rank index when Redis is usable, price order otherwise),
     * hydrates the page once (Case 2) and drops doctors whose Identity account is not active. Redis never causes a 5xx (AV-R20).
     */
    async search(query: SearchDoctorsQuery): Promise<SearchResult> {
        const nowMs = this.clock.now();
        assertFeeRange(query.minFee, query.maxFee);
        const window = resolveSearchWindow(query.availableFrom, query.availableTo, nowMs);
        const namePrefix = query.name === undefined ? undefined : assertNamePrefix(normalizeName(query.name));
        const nameMatches = namePrefix === undefined ? undefined : await this.index.readNameMatches(namePrefix);
        // AV-R27: a requested name filter whose index is missing, expired or unreadable matched headlines only, and the response says so.
        const nameFellBack = namePrefix !== undefined && nameMatches === undefined;
        const filters: CandidateFilters = { specialty: query.specialty, language: query.language, minFee: query.minFee, maxFee: query.maxFee, namePrefix, nameMatchedUserIds: nameMatches };
        const indexed = this.index.isUsable() ? await this.selectIndexed(query, filters, window, nameFellBack, nowMs) : undefined;
        const selection = indexed ?? await this.selectDegraded(query, filters, window, nameFellBack, nowMs);
        const userIds = selection.rows.map((row) => row.userId);
        const [views, hydrated] = await Promise.all([this.doctors.findPublicViews(userIds), hydrateUsersOrEmpty(this.identity, this.logger, userIds)]);
        const items: DiscoveryItem[] = [];
        for (const row of selection.rows) {
            const view = views.get(row.userId);
            const accountStatus = hydrated.get(row.userId)?.status;
            if (view === undefined || (accountStatus !== undefined && accountStatus !== "active")) continue;
            const score = selection.scores.get(row.userId);
            items.push({ view, nextAvailableAt: score !== undefined && score < NONE_SCORE && score > nowMs ? score : null });
        }
        const degraded = DEGRADED_ORDER.filter((part) => selection.degraded.has(part));
        for (const part of degraded) this.logger.metric(METRIC_DEGRADED, 1, { reason: part });
        return { items, hydrated, meta: { nextCursor: selection.nextCursor, hasMore: selection.hasMore, count: items.length, ...(degraded.length > 0 ? { degraded } : {}) } };
    }

    /** `GET /api/doctors/{id}` (AV-R21): the public profile with a slots preview from the shortest active type. */
    async getDoctor(actor: AuthContext, doctorUserId: number, query: GetDoctorQuery): Promise<ProfileResult> {
        const view = (await this.doctors.findPublicViews([doctorUserId])).get(doctorUserId);
        const admin = actor.role === "admin";
        if (view === undefined || (!admin && !view.bookable)) throw NotFound;
        const timezone = await this.availability.resolveRenderZone(actor, query.timezone);
        const nowMs = this.clock.now();
        const [slots, hydrated] = await Promise.all([
            view.bookable ? this.previewSlots(view, nowMs) : Promise.resolve<SlotRange[]>([]),
            hydrateUsersOrEmpty(this.identity, this.logger, [doctorUserId]),
        ]);
        return { view, hydrated: hydrated.get(doctorUserId), nextAvailableAt: slots[0]?.startMs ?? null, slots: slots.slice(0, PREVIEW_SLOT_COUNT), timezone, admin };
    }

    private async previewSlots(view: PublicDoctorView, nowMs: number): Promise<SlotRange[]> {
        const shortest = [...view.activeTypes].sort((a, b) => a.durationMinutes - b.durationMinutes || a.id - b.id)[0];
        if (shortest === undefined) return [];
        const toMs = nowMs + LOOKAHEAD_DAYS * DAY_MS;
        const doctor = { profileId: view.profile.id, userId: view.profile.userId, timezone: view.profile.timezone, bookableBase: true };
        const slots = await this.availability.listSlots(doctor, { id: shortest.id, durationMinutes: shortest.durationMinutes },
            localDateOf(nowMs, doctor.timezone), localDateOf(toMs - 1, doctor.timezone));
        return slots.filter((slot) => slot.startMs > nowMs && slot.startMs < toMs).slice(0, PREVIEW_SLOT_COUNT);
    }

    // ── planning ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

    /**
     * The plan for a usable index. Plain price and experience without a window page with a SQL keyset (path A); every other case pages the
     * in-memory candidate array (path B). Returns `undefined` when an index command fails, so the request reruns degraded.
     */
    private async selectIndexed(query: SearchDoctorsQuery, filters: CandidateFilters, window: SlotWindow | undefined, nameFellBack: boolean,
        nowMs: number): Promise<PageSelection | undefined> {
        const kind = effectiveKind(query.sort, true);
        const after = query.cursor === undefined ? null : decodeDiscoveryCursor(query.cursor, this.env.SERVICE_CLIENT_SECRET, kind);
        const degraded = new Set<DegradedPart>(nameFellBack ? [DegradedPart.NameFilter] : []);
        if (window !== undefined || kind === DiscoveryCursorKind.Earliest) return this.pageInMemory(query, filters, kind, after, window, degraded, nowMs);
        const { rows, hasMore } = await this.keysetRows(query, filters, kind, after);
        const stored = await this.index.scores(rows.map((row) => row.userId));
        if (stored === undefined) return undefined;
        const fresh = this.freshScores(rows, stored, nowMs);
        await this.fillMisses(rows.filter((row) => !fresh.has(row.userId)), fresh, undefined, nowMs);
        return this.selection(rows, hasMore, kind, fresh, degraded);
    }

    /** Redis unusable (or failed mid-request): price order, no window filter, positions computed inline up to the cap (AV-R20). */
    private async selectDegraded(query: SearchDoctorsQuery, filters: CandidateFilters, window: SlotWindow | undefined, nameFellBack: boolean,
        nowMs: number): Promise<PageSelection> {
        const kind = effectiveKind(query.sort, false);
        const after = query.cursor === undefined ? null : decodeDiscoveryCursor(query.cursor, this.env.SERVICE_CLIENT_SECRET, kind);
        const degraded = new Set<DegradedPart>(nameFellBack ? [DegradedPart.NameFilter] : []);
        if (kind === DiscoveryCursorKind.Degraded) degraded.add(DegradedPart.Sort);
        if (window !== undefined) degraded.add(DegradedPart.AvailabilityFilter);
        const { rows, hasMore } = await this.keysetRows(query, filters, kind, after);
        const fresh = new Map<number, number>();
        await this.fillMisses(rows, fresh, undefined, nowMs);
        return this.selection(rows, hasMore, kind, fresh, degraded);
    }

    /** Path A: one SQL keyset page in price or experience order (`limit + 1` fetched). */
    private async keysetRows(query: SearchDoctorsQuery, filters: CandidateFilters, kind: DiscoveryCursorKind, after: DiscoveryCursor | null): Promise<{ rows: Candidate[]; hasMore: boolean }> {
        const order = kind === DiscoveryCursorKind.Experience ? CandidateOrder.Experience : CandidateOrder.Price;
        const fetched = await this.reader.pageCandidates(filters, { order, after: after === null ? null : { value: after.v, id: after.id }, fetch: query.limit + 1 });
        return { rows: fetched.slice(0, query.limit), hasMore: fetched.length > query.limit };
    }

    private selection(rows: Candidate[], hasMore: boolean, kind: DiscoveryCursorKind, scores: ReadonlyMap<number, number>, degraded: ReadonlySet<DegradedPart>): PageSelection {
        const last = rows[rows.length - 1];
        const nextCursor = hasMore && last !== undefined
            ? encodeDiscoveryCursor({ k: kind, v: cursorValueOf(last, kind, scores), id: last.profileId }, this.env.SERVICE_CLIENT_SECRET) : null;
        return { rows, hasMore, nextCursor, scores, degraded };
    }

    /** Path B: every candidate with its position, optionally filtered by the window, ordered and paged in memory. */
    private async pageInMemory(query: SearchDoctorsQuery, filters: CandidateFilters, kind: DiscoveryCursorKind, after: DiscoveryCursor | null,
        window: SlotWindow | undefined, degraded: Set<DegradedPart>, nowMs: number): Promise<PageSelection | undefined> {
        const listed = await this.reader.listCandidates(filters);
        if (listed.truncated) this.logger.warn(LOG_CANDIDATES_TRUNCATED);
        const candidates = listed.items;
        const stored = await this.index.scores(candidates.map((candidate) => candidate.userId));
        if (stored === undefined) return undefined;
        const fresh = this.freshScores(candidates, stored, nowMs);
        const misses = candidates.filter((candidate) => !fresh.has(candidate.userId));
        let maps: Map<number, Uint8Array | null> | undefined;
        if (window !== undefined) {
            const needMap = candidates.filter((candidate) => matchBySchedule(fresh.get(candidate.userId) ?? NONE_SCORE, window) === WindowMatchVerdict.NeedsMap);
            maps = await this.index.maps(needMap.map((candidate) => candidate.userId));
            if (maps === undefined) return undefined;
            for (const candidate of needMap) {
                if (maps.get(candidate.userId) !== null) continue;
                fresh.delete(candidate.userId);
                misses.push(candidate);
            }
        }
        await this.fillMisses(misses, fresh, maps, nowMs);
        const matched = window === undefined ? candidates : this.filterByWindow(candidates, fresh, maps, window, degraded);
        const remaining = applyCursor(orderCandidates(matched, kind, fresh), kind, fresh, after);
        return this.selection(remaining.slice(0, query.limit), remaining.length > query.limit, kind, fresh, degraded);
    }

    /** Candidates whose availability proves a free slot in the window; unknown ones are excluded and flagged (AV-R18). */
    private filterByWindow(candidates: readonly Candidate[], fresh: ReadonlyMap<number, number>, maps: ReadonlyMap<number, Uint8Array | null> | undefined,
        window: SlotWindow, degraded: Set<DegradedPart>): Candidate[] {
        const matched: Candidate[] = [];
        for (const candidate of candidates) {
            const score = fresh.get(candidate.userId);
            if (score === undefined) { degraded.add(DegradedPart.AvailabilityFilter); continue; }
            const verdict = matchBySchedule(score, window);
            if (verdict === WindowMatchVerdict.Match) { matched.push(candidate); continue; }
            if (verdict === WindowMatchVerdict.NoMatch) continue;
            const map = maps?.get(candidate.userId);
            const hit = map === null || map === undefined ? undefined : testFreeMap(map, window.fromMs, window.toMs);
            if (hit === undefined) degraded.add(DegradedPart.AvailabilityFilter);
            else if (hit) matched.push(candidate);
        }
        return matched;
    }

    /** AV-R18: the stored positions that are still ahead of now; a missing or elapsed one is a miss. */
    private freshScores(candidates: readonly Candidate[], stored: ReadonlyMap<number, number | null> | undefined, nowMs: number): Map<number, number> {
        const fresh = new Map<number, number>();
        for (const candidate of candidates) {
            const score = stored?.get(candidate.userId);
            if (score !== null && score !== undefined && score > nowMs) fresh.set(candidate.userId, score);
        }
        return fresh;
    }

    /** Computes at most `AVAILABILITY_INLINE_MISS_CAP` misses (ascending profile id) inline; the rest stay unknown. */
    private async fillMisses(misses: readonly Candidate[], fresh: Map<number, number>, maps: Map<number, Uint8Array | null> | undefined, nowMs: number): Promise<void> {
        if (misses.length === 0) return;
        this.logger.metric(METRIC_INDEX_MISS, misses.length);
        const chosen = [...misses].sort((a, b) => a.profileId - b.profileId).slice(0, this.env.AVAILABILITY_INLINE_MISS_CAP);
        if (chosen.length === 0) return;
        const started = Date.now();
        const entries = await this.computeInline(chosen.map((candidate) => candidate.userId), nowMs);
        this.logger.metric(METRIC_INLINE_COMPUTE_MS, Date.now() - started);
        for (const entry of entries) {
            fresh.set(entry.userId, entry.score);
            maps?.set(entry.userId, entry.map);
        }
    }

    private async computeInline(userIds: readonly number[], nowMs: number): Promise<ComputedEntry[]> {
        const bookable = await this.reader.listBookableForIndex(userIds);
        return (await this.computer.refresh(bookable.items, nowMs)).entries;
    }
}
