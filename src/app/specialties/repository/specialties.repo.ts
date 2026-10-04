import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { Specialty } from "../entity/specialties.entity";
import type { ListSpecialtiesParams, SpecialtyColumnChanges, SpecialtyCreateInput, SpecialtyRow } from "../types";

/** The specialties catalog has no deleted_at: rows are deactivated, never deleted. */
export const SPECIALTY_COLUMNS = ["id", "name", "slug", "description", "is_active", "created_at", "updated_at"] as const;

function toEntity(row: SpecialtyRow): Specialty {
    return new Specialty({
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        isActive: row.is_active,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}

/** The keyset page query is exported so an EXPLAIN test can inspect exactly what runs. */
export function listSpecialtiesQuery(
    params: ListSpecialtiesParams,
    conn: Knex = db,
): Knex.QueryBuilder<SpecialtyRow, SpecialtyRow[]> {
    const query = conn<SpecialtyRow>("specialties").select<SpecialtyRow[]>(...SPECIALTY_COLUMNS);
    if (!params.includeInactive) query.where("is_active", true);
    if (params.after !== null) {
        query.whereRaw("(name, id) > (?, ?)", [params.after.sortValue, params.after.id]);
    }
    return query.orderBy("name", "asc").orderBy("id", "asc").limit(params.fetch);
}

export async function listSpecialties(params: ListSpecialtiesParams, conn: Knex = db): Promise<Specialty[]> {
    const rows: SpecialtyRow[] = await listSpecialtiesQuery(params, conn);
    return rows.map(toEntity);
}

export async function findSpecialtyByIdForUpdate(id: number, conn: Knex.Transaction): Promise<Specialty | undefined> {
    const row: SpecialtyRow | undefined = await conn<SpecialtyRow>("specialties")
        .select(...SPECIALTY_COLUMNS)
        .where("id", id)
        .forUpdate()
        .first();
    return row === undefined ? undefined : toEntity(row);
}

export async function insertSpecialty(input: SpecialtyCreateInput, conn: Knex.Transaction): Promise<Specialty> {
    const rows: SpecialtyRow[] = await conn<SpecialtyRow>("specialties")
        .insert({ name: input.name, slug: input.slug, description: input.description, is_active: true })
        .returning([...SPECIALTY_COLUMNS]);
    const row = rows[0];
    if (row === undefined) throw new Error("specialty_insert_returned_no_row");
    return toEntity(row);
}

export async function updateSpecialty(
    id: number,
    changes: SpecialtyColumnChanges,
    conn: Knex.Transaction,
): Promise<Specialty> {
    const rows: SpecialtyRow[] = await conn<SpecialtyRow>("specialties")
        .where("id", id)
        .update({ ...changes, updated_at: conn.fn.now() })
        .returning([...SPECIALTY_COLUMNS]);
    const row = rows[0];
    if (row === undefined) throw new Error("specialty_update_returned_no_row");
    return toEntity(row);
}
