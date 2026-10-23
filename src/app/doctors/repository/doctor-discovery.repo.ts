import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { CANDIDATE_HARD_CAP } from "../constants";
import { DOCTOR_PROFILE_COLUMNS, toDoctorProfile } from "../doctor-profile.mapper";
import type { DoctorProfile } from "../entity/doctor-profile.entity";
import { CandidateOrder, IdentitySyncStatus, VerificationStatus } from "../enums";
import type {
    Candidate, CandidateFilters, CandidatePageParams, CandidateRow, CappedList, DoctorLanguageBatchRow, DoctorProfileRow, DoctorSpecialtyBatchRow,
    IndexDoctor, IndexDoctorRow, SlotDoctor, SlotDoctorRow, SpecialtyLink,
} from "../types";

export const SLOT_DOCTOR_COLUMNS = ["id", "user_id", "timezone", "verification_status", "identity_sync_status", "suspended_at", "is_accepting_patients"] as const;
export const CANDIDATE_COLUMNS = ["dp.id", "dp.user_id", "dp.consultation_fee", "dp.years_experience"] as const;
export const INDEX_DOCTOR_COLUMNS = ["dp.id", "dp.user_id", "dp.timezone"] as const;

/**
 * Domain rule 6, spelled once and exactly as the partial indexes `idx_doctor_profiles_bookable_*` spell their predicate (the planner can
 * only prove the implication from identical terms). Constants, never user input.
 */
const BOOKABLE_PREDICATE = `dp.verification_status = '${VerificationStatus.Approved}' AND dp.identity_sync_status = '${IdentitySyncStatus.Synced}' AND dp.suspended_at IS NULL AND dp.is_accepting_patients AND dp.deleted_at IS NULL`;
const ACTIVE_TYPE_EXISTS = "EXISTS (SELECT 1 FROM consultation_types ct WHERE ct.doctor_profile_id = dp.id AND ct.is_active AND ct.deleted_at IS NULL)";
const SPECIALTY_EXISTS = "EXISTS (SELECT 1 FROM doctor_specialties ds WHERE ds.doctor_profile_id = dp.id AND ds.specialty_id = (SELECT s.id FROM specialties s WHERE s.slug = ?))";
const LANGUAGE_EXISTS = "EXISTS (SELECT 1 FROM doctor_languages dl WHERE dl.doctor_profile_id = dp.id AND dl.language_code = ?)";

function toSlotDoctor(row: SlotDoctorRow): SlotDoctor {
    return { profileId: row.id, userId: row.user_id, timezone: row.timezone,
        bookableBase: row.verification_status === VerificationStatus.Approved && row.identity_sync_status === IdentitySyncStatus.Synced &&
            row.suspended_at === null && row.is_accepting_patients };
}

function toCandidate(row: CandidateRow): Candidate {
    return { profileId: row.id, userId: row.user_id, fee: row.consultation_fee, years: row.years_experience };
}

function toIndexDoctor(row: IndexDoctorRow): IndexDoctor {
    return { profileId: row.id, userId: row.user_id, timezone: row.timezone };
}

export async function findForSlots(userId: number, conn: Knex = db): Promise<SlotDoctor | undefined> {
    const row: SlotDoctorRow | undefined = await conn<SlotDoctorRow>("doctor_profiles")
        .select(...SLOT_DOCTOR_COLUMNS).where("user_id", userId).whereNull("deleted_at").first();
    return row === undefined ? undefined : toSlotDoctor(row);
}

/** The shared candidate statement: Domain rule 6 (with the live-active-type term) plus the whitelisted filters, all bound as parameters. */
function candidateBase(filters: CandidateFilters, conn: Knex): Knex.QueryBuilder<CandidateRow, CandidateRow[]> {
    const query = conn<CandidateRow>("doctor_profiles as dp").select<CandidateRow[]>(...CANDIDATE_COLUMNS)
        .whereRaw(BOOKABLE_PREDICATE).whereRaw(ACTIVE_TYPE_EXISTS);
    if (filters.minFee !== undefined) query.whereRaw("dp.consultation_fee >= ?", [filters.minFee]);
    if (filters.maxFee !== undefined) query.whereRaw("dp.consultation_fee <= ?", [filters.maxFee]);
    if (filters.specialty !== undefined) query.whereRaw(SPECIALTY_EXISTS, [filters.specialty]);
    if (filters.language !== undefined) query.whereRaw(LANGUAGE_EXISTS, [filters.language]);
    if (filters.namePrefix !== undefined) query.whereRaw("starts_with(lower(dp.headline), ?)", [filters.namePrefix]);
    return query;
}

/**
 * Path B: every candidate in `(fee, id)` order, capped at `CANDIDATE_HARD_CAP + 1` rows, so the rows kept beyond the cap are the same on every
 * request (a cursor never skips or repeats a doctor). Exported so an EXPLAIN test inspects what runs.
 */
export function listCandidatesQuery(filters: CandidateFilters, conn: Knex = db): Knex.QueryBuilder<CandidateRow, CandidateRow[]> {
    return candidateBase(filters, conn).orderBy("dp.consultation_fee", "asc").orderBy("dp.id", "asc").limit(CANDIDATE_HARD_CAP + 1);
}

/** Path A: one keyset page in price order `(fee, id)` or experience order `(years DESC, id DESC)`. */
export function pageCandidatesQuery(filters: CandidateFilters, params: CandidatePageParams, conn: Knex = db): Knex.QueryBuilder<CandidateRow, CandidateRow[]> {
    const query = candidateBase(filters, conn);
    if (params.order === CandidateOrder.Price) {
        if (params.after !== null) query.whereRaw("(dp.consultation_fee, dp.id) > (?, ?)", [params.after.value, params.after.id]);
        return query.orderBy("dp.consultation_fee", "asc").orderBy("dp.id", "asc").limit(params.fetch);
    }
    if (params.after !== null) query.whereRaw("(dp.years_experience, dp.id) < (?, ?)", [params.after.value, params.after.id]);
    return query.orderBy("dp.years_experience", "desc").orderBy("dp.id", "desc").limit(params.fetch);
}

export async function listCandidates(filters: CandidateFilters, conn: Knex = db): Promise<CappedList<Candidate>> {
    const rows: CandidateRow[] = await listCandidatesQuery(filters, conn);
    return { items: rows.slice(0, CANDIDATE_HARD_CAP).map(toCandidate), truncated: rows.length > CANDIDATE_HARD_CAP };
}

export async function pageCandidates(filters: CandidateFilters, params: CandidatePageParams, conn: Knex = db): Promise<Candidate[]> {
    const rows: CandidateRow[] = await pageCandidatesQuery(filters, params, conn);
    return rows.map(toCandidate);
}

/** Every bookable doctor (sweep), or those of `userIds` that still are (refresh, inline computation), ordered by profile id. */
export function listBookableForIndexQuery(userIds: readonly number[] | undefined, conn: Knex = db): Knex.QueryBuilder<IndexDoctorRow, IndexDoctorRow[]> {
    const query = conn<IndexDoctorRow>("doctor_profiles as dp").select<IndexDoctorRow[]>(...INDEX_DOCTOR_COLUMNS)
        .whereRaw(BOOKABLE_PREDICATE).whereRaw(ACTIVE_TYPE_EXISTS);
    if (userIds !== undefined) query.whereRaw("dp.user_id = ANY(?::bigint[])", [[...userIds]]);
    return query.orderBy("dp.id", "asc").limit(CANDIDATE_HARD_CAP + 1);
}

export async function listBookableForIndex(userIds: readonly number[] | undefined, conn: Knex = db): Promise<CappedList<IndexDoctor>> {
    if (userIds !== undefined && userIds.length === 0) return { items: [], truncated: false };
    const rows: IndexDoctorRow[] = await listBookableForIndexQuery(userIds, conn);
    return { items: rows.slice(0, CANDIDATE_HARD_CAP).map(toIndexDoctor), truncated: rows.length > CANDIDATE_HARD_CAP };
}

/** Page view loads (one statement each, `= ANY`): the live profiles of a page, their languages and their specialty links. */
export function listProfilesByUserIdsQuery(userIds: readonly number[], conn: Knex = db): Knex.QueryBuilder<DoctorProfileRow, DoctorProfileRow[]> {
    return conn<DoctorProfileRow>("doctor_profiles").select<DoctorProfileRow[]>(...DOCTOR_PROFILE_COLUMNS)
        .whereRaw("user_id = ANY(?::bigint[])", [[...userIds]]).whereNull("deleted_at");
}

export async function listProfilesByUserIds(userIds: readonly number[], conn: Knex = db): Promise<DoctorProfile[]> {
    if (userIds.length === 0) return [];
    const rows: DoctorProfileRow[] = await listProfilesByUserIdsQuery(userIds, conn);
    return rows.map(toDoctorProfile);
}

export function listLanguagesForProfilesQuery(profileIds: readonly number[], conn: Knex = db): Knex.QueryBuilder<DoctorLanguageBatchRow, DoctorLanguageBatchRow[]> {
    return conn<DoctorLanguageBatchRow>("doctor_languages").select<DoctorLanguageBatchRow[]>("doctor_profile_id", "language_code")
        .whereRaw("doctor_profile_id = ANY(?::bigint[])", [[...profileIds]]).orderBy("doctor_profile_id").orderBy("language_code");
}

export async function listLanguagesForProfiles(profileIds: readonly number[], conn: Knex = db): Promise<Map<number, string[]>> {
    const grouped = new Map<number, string[]>();
    if (profileIds.length === 0) return grouped;
    const rows: DoctorLanguageBatchRow[] = await listLanguagesForProfilesQuery(profileIds, conn);
    for (const row of rows) grouped.set(row.doctor_profile_id, [...(grouped.get(row.doctor_profile_id) ?? []), row.language_code]);
    return grouped;
}

export function listLinksForProfilesQuery(profileIds: readonly number[], conn: Knex = db): Knex.QueryBuilder<DoctorSpecialtyBatchRow, DoctorSpecialtyBatchRow[]> {
    return conn<DoctorSpecialtyBatchRow>("doctor_specialties").select<DoctorSpecialtyBatchRow[]>("doctor_profile_id", "specialty_id", "is_primary")
        .whereRaw("doctor_profile_id = ANY(?::bigint[])", [[...profileIds]]);
}

export async function listLinksForProfiles(profileIds: readonly number[], conn: Knex = db): Promise<Map<number, SpecialtyLink[]>> {
    const grouped = new Map<number, SpecialtyLink[]>();
    if (profileIds.length === 0) return grouped;
    const rows: DoctorSpecialtyBatchRow[] = await listLinksForProfilesQuery(profileIds, conn);
    for (const row of rows) grouped.set(row.doctor_profile_id, [...(grouped.get(row.doctor_profile_id) ?? []), { specialtyId: row.specialty_id, isPrimary: row.is_primary }]);
    return grouped;
}
