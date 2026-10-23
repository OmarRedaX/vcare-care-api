import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { IdentitySyncStatus, VerificationStatus } from "../enums";
import type { SlotDoctor, SlotDoctorRow } from "../types";

export const SLOT_DOCTOR_COLUMNS = ["id", "user_id", "timezone", "verification_status", "identity_sync_status", "suspended_at", "is_accepting_patients"] as const;

function toEntity(row: SlotDoctorRow): SlotDoctor {
    return { profileId: row.id, userId: row.user_id, timezone: row.timezone,
        bookableBase: row.verification_status === VerificationStatus.Approved && row.identity_sync_status === IdentitySyncStatus.Synced &&
            row.suspended_at === null && row.is_accepting_patients };
}

export async function findForSlots(userId: number, conn: Knex = db): Promise<SlotDoctor | undefined> {
    const row: SlotDoctorRow | undefined = await conn<SlotDoctorRow>("doctor_profiles")
        .select(...SLOT_DOCTOR_COLUMNS).where("user_id", userId).whereNull("deleted_at").first();
    return row === undefined ? undefined : toEntity(row);
}
