import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { ConsultationType } from "../entity/consultation-type.entity";
import type { ConsultationTypeColumnChanges, ConsultationTypeInput, ConsultationTypeRow, TypePageParams } from "../types";

export const CONSULTATION_TYPE_COLUMNS = ["id", "name", "duration_minutes", "price", "currency", "is_active", "created_at", "updated_at"] as const;

function toEntity(row: ConsultationTypeRow): ConsultationType {
    return new ConsultationType({
        id: row.id, name: row.name, durationMinutes: row.duration_minutes, price: row.price, currency: row.currency,
        isActive: row.is_active, createdAt: row.created_at, updatedAt: row.updated_at,
    });
}

/** The keyset page query is exported so an EXPLAIN test can inspect exactly what runs. */
export function listTypesPageQuery(profileId: number, params: TypePageParams, conn: Knex = db): Knex.QueryBuilder<ConsultationTypeRow, ConsultationTypeRow[]> {
    const query = conn<ConsultationTypeRow>("consultation_types").select<ConsultationTypeRow[]>(...CONSULTATION_TYPE_COLUMNS)
        .where("doctor_profile_id", profileId).whereNull("deleted_at");
    if (params.isActive !== null) query.where("is_active", params.isActive);
    if (params.afterId !== null) query.where("id", ">", params.afterId);
    return query.orderBy("id", "asc").limit(params.fetch);
}

export async function listTypesPage(profileId: number, params: TypePageParams, conn: Knex = db): Promise<ConsultationType[]> {
    const rows: ConsultationTypeRow[] = await listTypesPageQuery(profileId, params, conn);
    return rows.map(toEntity);
}

export async function countLiveTypes(profileId: number, conn: Knex.Transaction): Promise<number> {
    const row = await conn("consultation_types").where("doctor_profile_id", profileId).whereNull("deleted_at")
        .count<Array<{ count: number | string }>>({ count: "*" }).first();
    return Number(row?.count ?? 0);
}

/** New types are always created active; a duplicate live name raises 23505 on the name unique index (the service maps it). */
export async function insertType(profileId: number, input: ConsultationTypeInput, conn: Knex.Transaction): Promise<ConsultationType> {
    const rows: ConsultationTypeRow[] = await conn("consultation_types")
        .insert({ doctor_profile_id: profileId, name: input.name, duration_minutes: input.durationMinutes, price: input.price, currency: input.currency, is_active: true })
        .returning([...CONSULTATION_TYPE_COLUMNS]);
    const row = rows[0];
    if (row === undefined) throw new Error("consultation_type_insert_returned_no_row");
    return toEntity(row);
}

/** Scoped to the profile: a foreign or deleted id is `undefined`. */
export async function findTypeById(profileId: number, id: number, conn: Knex = db): Promise<ConsultationType | undefined> {
    const row: ConsultationTypeRow | undefined = await conn<ConsultationTypeRow>("consultation_types")
        .select(...CONSULTATION_TYPE_COLUMNS).where("id", id).where("doctor_profile_id", profileId).whereNull("deleted_at").first();
    return row === undefined ? undefined : toEntity(row);
}

export async function updateType(id: number, changes: ConsultationTypeColumnChanges, conn: Knex.Transaction): Promise<ConsultationType> {
    const rows: ConsultationTypeRow[] = await conn<ConsultationTypeRow>("consultation_types")
        .where("id", id).whereNull("deleted_at").update({ ...changes, updated_at: conn.fn.now() }).returning([...CONSULTATION_TYPE_COLUMNS]);
    const row = rows[0];
    if (row === undefined) throw new Error("consultation_type_update_returned_no_row");
    return toEntity(row);
}

/** The exact statement of `hasActiveType`, exported so an EXPLAIN test inspects what runs. */
export function hasActiveTypeQuery(profileId: number, conn: Knex = db): Knex.QueryBuilder<ConsultationTypeRow, Array<Pick<ConsultationTypeRow, "id">>> {
    return conn<ConsultationTypeRow>("consultation_types").select<Array<Pick<ConsultationTypeRow, "id">>>("id")
        .where("doctor_profile_id", profileId).where("is_active", true).whereNull("deleted_at").limit(1);
}

/** Domain rule 6: at least one live active type. */
export async function hasActiveType(profileId: number, conn: Knex = db): Promise<boolean> {
    const rows = await hasActiveTypeQuery(profileId, conn);
    return rows.length > 0;
}
