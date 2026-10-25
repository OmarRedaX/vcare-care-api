import type { PageMeta } from "../../lib/http/pagination/types";
import type { HydratedUser } from "../../lib/identity-client/types";
import type { UserPolicy } from "../../lib/rbac/types";
import type { ExceptionRule, SlotRange, UtcInterval, WeeklyHoursRule } from "../../pkg/slots/types";
import type { Candidate, PublicDoctorView } from "../doctors/types";
import type { DegradedPart, DiscoveryCursorKind, SearchSortKind } from "./enums";

export interface DoctorSlotsQuery { typeId: number; from: string; to: string; timezone?: string }
export interface DoctorSlotInputs { timezone: string; weekly: WeeklyHoursRule[]; exceptions: ExceptionRule[]; busy: UtcInterval[]; durationMinutes: number; typeId: number }
export interface SlotWindow { fromMs: number; toMs: number }
export interface SlotType { id: number; durationMinutes: number }
export interface SlotCacheVersion { version: string; usable: boolean }
export interface SlotResult { slots: SlotRange[]; fromMs: number; toMs: number; timezone: string; doctorTimezone: string }
export type AvailabilityRoute = "slots" | "search" | "getDoctor";
export type AvailabilityPolicies = Readonly<Record<AvailabilityRoute, UserPolicy>>;

/** Validated search input (the request DTO's plain form). */
export interface SearchDoctorsQuery {
    specialty?: string; language?: string; name?: string; minFee?: number; maxFee?: number;
    availableFrom?: string; availableTo?: string; sort: SearchSortKind; cursor?: string; limit: number;
}
export interface GetDoctorQuery { timezone?: string }

/** Signed keyset position of a search page: the order it was issued under, the sort value of the last item, its profile id. */
export interface DiscoveryCursor { k: DiscoveryCursorKind; v: number; id: number }

/** One computed rank-index entry. `ver` is the `slots-ver` snapshot taken before loading inputs (null = Redis unreachable, nothing can be written). */
export interface ComputedEntry { userId: number; score: number; map: Uint8Array; ver: string | null }
/** `removed` = doctors that no longer have a live active consultation type. */
export interface ComputeResult { entries: ComputedEntry[]; removed: number[] }
/** One doctor's result inside a computed batch: the entry, or `null` when the doctor has no live active type any more. */
export type DoctorOutcome = ComputedEntry | null;
export type IndexWriteVerdict = "stored" | "rejected" | "failed";
/** `failed` = user ids whose entry could not be written (Redis down or a command error); a guard rejection is not a failure (the doctor is in the refresh set). */
export interface RefreshResult { entries: ComputedEntry[]; removed: number[]; stored: number; failed: number[] }
/** The dynamically defined guarded write (`defineCommand`), as the pipeline exposes it. */
export interface GuardedWriteCommands {
    writeNextAvailable(versionKey: string, indexKey: string, mapKey: string, expectedVersion: string, member: string, score: string, map: Buffer, ttlSeconds: number): unknown;
}

export interface DiscoveryItem { view: PublicDoctorView; nextAvailableAt: number | null }
export interface SearchMeta extends PageMeta { degraded?: DegradedPart[] }
export interface SearchResult { items: DiscoveryItem[]; hydrated: ReadonlyMap<number, HydratedUser>; meta: SearchMeta }
export interface ProfileResult { view: PublicDoctorView; hydrated: HydratedUser | undefined; nextAvailableAt: number | null; slots: SlotRange[]; timezone: string; admin: boolean }

/** One selected search page before views and hydration: the rows, the cursor position after them, and the fresh scores known for them. */
export interface PageSelection {
    rows: Candidate[];
    hasMore: boolean;
    nextCursor: string | null;
    scores: ReadonlyMap<number, number>;
    degraded: ReadonlySet<DegradedPart>;
}
