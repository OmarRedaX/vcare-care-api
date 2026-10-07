import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { DOCTOR_PROFILE_COLUMNS, toDoctorProfile as toEntity } from "../doctor-profile.mapper";
import type { DoctorProfile } from "../entity/doctor-profile.entity";
import { IdentitySyncStatus, VerificationStatus } from "../enums";
import type { DoctorProfileColumnChanges, DoctorProfileInput, DoctorProfileRow } from "../types";

export async function findProfileByUserId(userId: number, conn: Knex = db): Promise<DoctorProfile | undefined> {
    const row: DoctorProfileRow | undefined = await conn<DoctorProfileRow>("doctor_profiles")
        .select(...DOCTOR_PROFILE_COLUMNS).where("user_id", userId).whereNull("deleted_at").first();
    return row === undefined ? undefined : toEntity(row);
}

export async function findProfileByUserIdForUpdate(userId: number, conn: Knex.Transaction): Promise<DoctorProfile | undefined> {
    const row: DoctorProfileRow | undefined = await conn<DoctorProfileRow>("doctor_profiles")
        .select(...DOCTOR_PROFILE_COLUMNS).where("user_id", userId).whereNull("deleted_at").forUpdate().first();
    return row === undefined ? undefined : toEntity(row);
}

export async function insertProfile(userId: number, input: DoctorProfileInput, timezone: string, conn: Knex.Transaction): Promise<DoctorProfile> {
    const rows: DoctorProfileRow[] = await conn<DoctorProfileRow>("doctor_profiles").insert({
        user_id: userId, headline: input.headline, bio: input.bio ?? null, years_experience: input.yearsExperience,
        consultation_fee: input.consultationFee.amount, currency: input.consultationFee.currency,
        default_slot_minutes: input.defaultSlotMinutes, timezone, is_accepting_patients: true,
        verification_status: VerificationStatus.Draft, identity_sync_status: IdentitySyncStatus.NotRequired,
    }).returning([...DOCTOR_PROFILE_COLUMNS]);
    const row = rows[0];
    if (row === undefined) throw new Error("doctor_profile_insert_returned_no_row");
    return toEntity(row);
}

export async function updateProfile(id: number, changes: DoctorProfileColumnChanges, conn: Knex.Transaction): Promise<DoctorProfile> {
    const rows: DoctorProfileRow[] = await conn<DoctorProfileRow>("doctor_profiles")
        .where("id", id).whereNull("deleted_at").update({ ...changes, updated_at: conn.fn.now() })
        .returning([...DOCTOR_PROFILE_COLUMNS]);
    const row = rows[0];
    if (row === undefined) throw new Error("doctor_profile_update_returned_no_row");
    return toEntity(row);
}

export async function isUserLocallySuspended(userId: number, conn: Knex = db): Promise<boolean> {
    const row: Pick<DoctorProfileRow, "id"> | undefined = await conn<DoctorProfileRow>("doctor_profiles")
        .select("id").where("user_id", userId).whereNull("deleted_at").whereNotNull("suspended_at").first();
    return row !== undefined;
}
