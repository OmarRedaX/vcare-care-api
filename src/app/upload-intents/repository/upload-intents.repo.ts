import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import type { UploadIntentRow } from "../types";

export const INTENT_COLUMNS = ["id", "kind", "target_id", "owner_user_id", "document_type", "description", "quarantine_key", "max_bytes", "expires_at", "consumed_at", "result_id", "created_at"] as const;

export async function insertIntent(row: Pick<UploadIntentRow, "kind" | "target_id" | "owner_user_id" | "document_type" | "description" | "quarantine_key" | "max_bytes" | "expires_at">, conn: Knex = db): Promise<UploadIntentRow> { const rows: UploadIntentRow[] = await conn<UploadIntentRow>("upload_intents").insert(row).returning([...INTENT_COLUMNS]); const inserted = rows[0]; if (!inserted) throw new Error("intent_insert_empty"); return inserted; }
export async function findIntent(id: number, conn: Knex = db): Promise<UploadIntentRow | undefined> { return conn<UploadIntentRow>("upload_intents").select(...INTENT_COLUMNS).where({ id }).first(); }
export async function findIntentForUpdate(id: number, conn: Knex = db): Promise<UploadIntentRow | undefined> { return conn<UploadIntentRow>("upload_intents").select(...INTENT_COLUMNS).where({ id }).forUpdate().first(); }
export async function closeIntent(id: number, resultId: number | null = null, conn: Knex = db): Promise<void> { await conn("upload_intents").where({ id }).whereNull("consumed_at").update({ consumed_at: conn.fn.now(), result_id: resultId }); }
/** Purge listing for every intent kind: `SELECT … WHERE consumed_at IS NULL AND expires_at <= now() ORDER BY expires_at` (idx_upload_intents_expires_at_open). */
export async function listExpiredOpenIntents(limit = 500, conn: Knex = db): Promise<UploadIntentRow[]> { return conn<UploadIntentRow>("upload_intents").select(...INTENT_COLUMNS).whereNull("consumed_at").where("expires_at", "<=", conn.fn.now()).orderBy("expires_at").limit(Math.min(500, Math.max(1, limit))); }
export async function deleteIntentsOlderThan(cutoff: Date, limit = 500, conn: Knex = db): Promise<number> { const ids: { id: number }[] = await conn<{ id: number }>("upload_intents").select("id").where("created_at", "<", cutoff).whereNotNull("consumed_at").orderBy("created_at").limit(Math.min(500, Math.max(1, limit))); if (!ids.length) return 0; return conn("upload_intents").whereIn("id", ids.map((row) => row.id)).delete(); }
