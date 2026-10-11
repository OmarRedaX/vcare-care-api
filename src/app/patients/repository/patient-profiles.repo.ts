import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { PatientProfile } from "../entity/patient-profile.entity";
import type { PatientProfileColumnChanges, PatientProfileInput, PatientProfileRow } from "../types";

/** `date_of_birth` is selected as text (`YYYY-MM-DD`), never a JS Date, so no timezone shift can alter the calendar date. */
function profileColumns(conn: Knex): Array<string | Knex.Raw> {
    return ["id", "user_id", conn.raw("to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth"), "gender", "blood_type",
        "allergies", "chronic_conditions", "timezone", "created_at", "updated_at"];
}

function toEntity(row: PatientProfileRow): PatientProfile {
    return new PatientProfile({ id: row.id, userId: row.user_id, dateOfBirth: row.date_of_birth, gender: row.gender, bloodType: row.blood_type,
        allergies: row.allergies, chronicConditions: row.chronic_conditions, timezone: row.timezone, createdAt: row.created_at, updatedAt: row.updated_at });
}

export async function findProfileByUserId(userId: number, conn: Knex = db): Promise<PatientProfile | undefined> {
    const rows = await conn("patient_profiles")
        .select<PatientProfileRow[]>(profileColumns(conn)).where("user_id", userId).whereNull("deleted_at").limit(1);
    const row = rows[0];
    return row === undefined ? undefined : toEntity(row);
}

export async function findProfileByUserIdForUpdate(userId: number, conn: Knex.Transaction): Promise<PatientProfile | undefined> {
    const rows = await conn("patient_profiles")
        .select<PatientProfileRow[]>(profileColumns(conn)).where("user_id", userId).whereNull("deleted_at").forUpdate().limit(1);
    const row = rows[0];
    return row === undefined ? undefined : toEntity(row);
}

export async function insertProfile(userId: number, input: PatientProfileInput, conn: Knex.Transaction): Promise<PatientProfile> {
    const rows: PatientProfileRow[] = await conn<PatientProfileRow>("patient_profiles").insert({
        user_id: userId, date_of_birth: input.dateOfBirth, gender: input.gender, blood_type: input.bloodType,
        allergies: input.allergies, chronic_conditions: input.chronicConditions, timezone: input.timezone,
    }).returning(profileColumns(conn));
    const row = rows[0];
    if (row === undefined) throw new Error("patient_profile_insert_returned_no_row");
    return toEntity(row);
}

export async function updateProfile(id: number, changes: PatientProfileColumnChanges, conn: Knex.Transaction): Promise<PatientProfile> {
    const rows: PatientProfileRow[] = await conn<PatientProfileRow>("patient_profiles")
        .where("id", id).whereNull("deleted_at").update({ ...changes, updated_at: conn.fn.now() })
        .returning(profileColumns(conn));
    const row = rows[0];
    if (row === undefined) throw new Error("patient_profile_update_returned_no_row");
    return toEntity(row);
}
