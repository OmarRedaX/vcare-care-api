import type { Knex } from "knex";
import { ownerDb } from "./db";

/** One synthetic doctor for the discovery suites (availability spec 9.2). Everything defaults to a bookable UTC doctor. */
export interface DoctorSeed {
    userId: number;
    headline?: string;
    years?: number;
    fee?: number;
    timezone?: string;
    accepting?: boolean;
    verification?: "draft" | "submitted" | "approved" | "rejected";
    sync?: "not_required" | "pending" | "synced" | "failed";
    suspended?: boolean;
    deleted?: boolean;
    /** `false` = no working hours; default every weekday 09:00-17:00. */
    hours?: false | { start: string; end: string; weekdays?: number[] };
    /** Default one active 30-minute type. */
    types?: Array<{ name?: string; minutes: number; active?: boolean; deleted?: boolean }>;
    languages?: string[];
    specialtyIds?: number[];
}

export async function seedSpecialty(slug: string, name: string, conn: Knex = ownerDb): Promise<number> {
    const rows = await conn("specialties").insert({ slug, name, is_active: true }).returning("id");
    return Number((rows[0] as { id: number }).id);
}

/** Inserts the profile and its hours, types, languages and specialty links through real SQL; returns the profile id. */
export async function seedDoctor(seed: DoctorSeed, conn: Knex = ownerDb): Promise<number> {
    const verification = seed.verification ?? "approved";
    const rows = await conn("doctor_profiles").insert({
        user_id: seed.userId, headline: seed.headline ?? `Synthetic headline ${seed.userId}`, years_experience: seed.years ?? 5,
        consultation_fee: seed.fee ?? 1000, currency: "EGP", default_slot_minutes: 30, timezone: seed.timezone ?? "UTC",
        is_accepting_patients: seed.accepting ?? true, verification_status: verification, identity_sync_status: seed.sync ?? "synced",
        decided_at: verification === "approved" || verification === "rejected" ? new Date() : null,
        suspended_at: seed.suspended === true ? new Date() : null, suspension_reason: seed.suspended === true ? "Synthetic suspension" : null,
        deleted_at: seed.deleted === true ? new Date() : null,
    }).returning("id");
    const profileId = Number((rows[0] as { id: number }).id);
    if (seed.hours !== false) {
        const hours = seed.hours ?? { start: "09:00", end: "17:00" };
        await conn("working_hours").insert((hours.weekdays ?? [1, 2, 3, 4, 5, 6, 7]).map((weekday) => ({
            doctor_profile_id: profileId, weekday, start_time: hours.start, end_time: hours.end })));
    }
    const types = seed.types ?? [{ minutes: 30 }];
    await conn("consultation_types").insert(types.map((type, position) => ({
        doctor_profile_id: profileId, name: type.name ?? `Synthetic visit ${position + 1}`, duration_minutes: type.minutes, price: seed.fee ?? 1000,
        currency: "EGP", is_active: type.active ?? true, deleted_at: type.deleted === true ? new Date() : null })));
    if (seed.languages !== undefined && seed.languages.length > 0) {
        await conn("doctor_languages").insert(seed.languages.map((language_code) => ({ doctor_profile_id: profileId, language_code })));
    }
    if (seed.specialtyIds !== undefined && seed.specialtyIds.length > 0) {
        await conn("doctor_specialties").insert(seed.specialtyIds.map((specialty_id, position) => ({
            doctor_profile_id: profileId, specialty_id, is_primary: position === 0 })));
    }
    return profileId;
}

/** Shape of a bulk-generated doctor table (see `seedBulkDoctors`). */
export interface BulkDoctorOptions {
    count: number;
    firstUserId: number;
    /** Every `bookableEvery`-th doctor (index % n === 0) is bookable; the others cycle through non-bookable states. 1 = all bookable. */
    bookableEvery: number;
    timezone?: string;
    /** Weekdays-all hours start at 08:00 + (id % 3) h for 8 h. */
    withHours: boolean;
}

/**
 * Bulk synthetic doctors with `generate_series` (never row-by-row). Index i = 0..count-1 gets user id `firstUserId + i`, a fee of
 * `100 + (i * 37) % 900` (many ties), `i % 41` years, language `ar` (+ `en` when i % 3 = 0, `fr` when i % 200 = 0) and one specialty `spec-(i % 10)`.
 * With `bookableEvery = 8` the state cycle is: 0 bookable, 1 suspended, 2 not accepting, 3 submitted, 4 sync pending, 5 rejected,
 * 6 approved-and-synced but only an inactive type, 7 soft-deleted. Every profile gets one type (active except cycle 6), so the `EXISTS` term is exercised.
 * Specialties `spec-0`..`spec-9` must exist (see `seedBulkSpecialties`).
 */
export async function seedBulkDoctors(options: BulkDoctorOptions, conn: Knex = ownerDb): Promise<void> {
    const { count, firstUserId, bookableEvery } = options;
    const timezone = options.timezone ?? "UTC";
    await conn.raw(`
        INSERT INTO doctor_profiles (user_id, headline, years_experience, consultation_fee, currency, default_slot_minutes, timezone,
            is_accepting_patients, verification_status, identity_sync_status, decided_at, suspended_at, suspension_reason, deleted_at)
        SELECT ?::bigint + i, 'Synthetic bulk doctor ' || i, i % 41, 100 + (i * 37) % 900, 'EGP', 30, ?::text,
            CASE WHEN ?::int > 1 AND i % ?::int = 2 THEN false ELSE true END,
            CASE WHEN ?::int > 1 AND i % ?::int = 3 THEN 'submitted' WHEN ?::int > 1 AND i % ?::int = 5 THEN 'rejected' ELSE 'approved' END,
            CASE WHEN ?::int > 1 AND i % ?::int = 4 THEN 'pending' ELSE 'synced' END,
            CASE WHEN ?::int > 1 AND i % ?::int = 3 THEN NULL ELSE now() END,
            CASE WHEN ?::int > 1 AND i % ?::int = 1 THEN now() ELSE NULL END,
            CASE WHEN ?::int > 1 AND i % ?::int = 1 THEN 'Synthetic suspension' ELSE NULL END,
            CASE WHEN ?::int > 1 AND i % ?::int = 7 THEN now() ELSE NULL END
        FROM generate_series(0, ?::int - 1) AS i`,
    [firstUserId, timezone, ...Array.from({ length: 8 }, () => [bookableEvery, bookableEvery]).flat(), count]);
    await conn.raw(`
        INSERT INTO consultation_types (doctor_profile_id, name, duration_minutes, price, currency, is_active)
        SELECT dp.id, 'Synthetic bulk visit', 30, dp.consultation_fee, 'EGP', NOT (?::int > 1 AND (dp.user_id - ?::bigint) % ?::int = 6)
        FROM doctor_profiles dp WHERE dp.user_id >= ?::bigint AND dp.user_id < ?::bigint + ?::int`,
    [bookableEvery, firstUserId, bookableEvery, firstUserId, firstUserId, count]);
    if (options.withHours) {
        await conn.raw(`
            INSERT INTO working_hours (doctor_profile_id, weekday, start_time, end_time)
            SELECT dp.id, d, make_time(8 + (dp.id % 3)::int, 0, 0), make_time(16 + (dp.id % 3)::int, 0, 0)
            FROM doctor_profiles dp CROSS JOIN generate_series(1, 7) AS d WHERE dp.user_id >= ?::bigint AND dp.user_id < ?::bigint + ?::int`,
        [firstUserId, firstUserId, count]);
    }
    await conn.raw(`
        INSERT INTO doctor_languages (doctor_profile_id, language_code)
        SELECT dp.id, l.code FROM doctor_profiles dp
        JOIN LATERAL (VALUES ('ar', true), ('en', (dp.user_id - ?::bigint) % 3 = 0), ('fr', (dp.user_id - ?::bigint) % 200 = 0)) AS l(code, keep) ON l.keep
        WHERE dp.user_id >= ?::bigint AND dp.user_id < ?::bigint + ?::int`,
    [firstUserId, firstUserId, firstUserId, firstUserId, count]);
    await conn.raw(`
        INSERT INTO doctor_specialties (doctor_profile_id, specialty_id, is_primary)
        SELECT dp.id, s.id, true FROM doctor_profiles dp
        JOIN specialties s ON s.slug = 'spec-' || ((dp.user_id - ?::bigint) % 10)
        WHERE dp.user_id >= ?::bigint AND dp.user_id < ?::bigint + ?::int`,
    [firstUserId, firstUserId, firstUserId, count]);
}

/** Specialties `spec-0`..`spec-9` for `seedBulkDoctors`. */
export async function seedBulkSpecialties(conn: Knex = ownerDb): Promise<void> {
    await conn("specialties").insert(Array.from({ length: 10 }, (_, i) => ({ slug: `spec-${i}`, name: `Synthetic specialty ${i}`, is_active: true })));
}

/** User ids of the bookable doctors a `seedBulkDoctors` call generated. */
export function bulkBookableUserIds(options: BulkDoctorOptions): number[] {
    return Array.from({ length: options.count }, (_, i) => i).filter((i) => i % options.bookableEvery === 0).map((i) => options.firstUserId + i);
}
