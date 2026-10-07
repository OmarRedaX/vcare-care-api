import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import type { DoctorSpecialtyLinkRow, SpecialtyLink } from "../types";

export async function listSpecialtyLinks(profileId: number, conn: Knex = db): Promise<SpecialtyLink[]> {
    const rows: DoctorSpecialtyLinkRow[] = await conn<DoctorSpecialtyLinkRow>("doctor_specialties")
        .select("specialty_id", "is_primary").where("doctor_profile_id", profileId);
    return rows.map((row) => ({ specialtyId: row.specialty_id, isPrimary: row.is_primary }));
}

export async function deleteLinksNotIn(profileId: number, ids: number[], conn: Knex.Transaction): Promise<void> {
    await conn("doctor_specialties").where("doctor_profile_id", profileId).whereNotIn("specialty_id", ids).del();
}

export async function clearPrimaryExcept(profileId: number, primaryId: number, conn: Knex.Transaction): Promise<void> {
    await conn("doctor_specialties").where("doctor_profile_id", profileId).where("is_primary", true)
        .whereNot("specialty_id", primaryId).update({ is_primary: false });
}

export async function insertLinks(profileId: number, links: SpecialtyLink[], conn: Knex.Transaction): Promise<void> {
    if (links.length === 0) return;
    await conn("doctor_specialties").insert(links.map((link) => ({ doctor_profile_id: profileId, specialty_id: link.specialtyId, is_primary: link.isPrimary })))
        .onConflict(["doctor_profile_id", "specialty_id"]).ignore();
}

export async function markPrimary(profileId: number, primaryId: number, conn: Knex.Transaction): Promise<void> {
    await conn("doctor_specialties").where("doctor_profile_id", profileId).where("specialty_id", primaryId)
        .where("is_primary", false).update({ is_primary: true });
}
