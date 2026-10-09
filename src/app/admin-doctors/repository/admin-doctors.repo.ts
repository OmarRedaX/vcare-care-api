import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { DOCTOR_PROFILE_COLUMNS, toDoctorProfile } from "../../doctors/doctor-profile.mapper";
import type { DoctorProfile } from "../../doctors/entity/doctor-profile.entity";
import { IdentitySyncStatus } from "../../doctors/enums";
import type { DoctorProfileRow } from "../../doctors/types";

/** Locks the live profile of an Identity user id (`uq_doctor_profiles_user_id`): the decision transaction's serialization point. */
export async function lockProfileByUserId(userId: number, conn: Knex = db): Promise<DoctorProfile | undefined> {
    const row: DoctorProfileRow | undefined = await conn<DoctorProfileRow>("doctor_profiles").select(...DOCTOR_PROFILE_COLUMNS).where({ user_id: userId }).whereNull("deleted_at").forUpdate().first();
    return row ? toDoctorProfile(row) : undefined;
}
/** Sets the local suspension and parks the account sync as `pending`; returns the committed `suspended_at` (DB clock). */
export async function applySuspension(profileId: number, adminUserId: number, reason: string, conn: Knex = db): Promise<Date> {
    const rows: { suspended_at: Date }[] = await conn("doctor_profiles").where({ id: profileId }).whereNull("deleted_at")
        .update({ suspended_at: conn.fn.now(), suspended_by: adminUserId, suspension_reason: reason, identity_sync_status: IdentitySyncStatus.Pending, updated_at: conn.fn.now() }).returning("suspended_at");
    const row = rows[0];
    if (!row) throw new Error("suspension_update_empty");
    return row.suspended_at;
}
/** Clears the local suspension (and the stale actor) and parks the account sync as `pending`; returns the DB clock of the change. */
export async function clearSuspension(profileId: number, conn: Knex = db): Promise<Date> {
    const rows: { updated_at: Date }[] = await conn("doctor_profiles").where({ id: profileId }).whereNull("deleted_at")
        .update({ suspended_at: null, suspended_by: null, suspension_reason: null, identity_sync_status: IdentitySyncStatus.Pending, updated_at: conn.fn.now() }).returning("updated_at");
    const row = rows[0];
    if (!row) throw new Error("reinstatement_update_empty");
    return row.updated_at;
}
