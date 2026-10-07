import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import type { DoctorLanguageRow } from "../types";

export async function listLanguages(profileId: number, conn: Knex = db): Promise<string[]> {
    const rows: DoctorLanguageRow[] = await conn<DoctorLanguageRow>("doctor_languages").select("language_code")
        .where("doctor_profile_id", profileId).orderBy("language_code", "asc");
    return rows.map((row) => row.language_code);
}

export async function insertLanguages(profileId: number, codes: string[], conn: Knex.Transaction): Promise<void> {
    if (codes.length === 0) return;
    await conn("doctor_languages").insert(codes.map((language_code) => ({ doctor_profile_id: profileId, language_code })))
        .onConflict(["doctor_profile_id", "language_code"]).ignore();
}

export async function deleteLanguagesNotIn(profileId: number, codes: string[], conn: Knex.Transaction): Promise<void> {
    await conn("doctor_languages").where("doctor_profile_id", profileId).whereNotIn("language_code", codes).del();
}
