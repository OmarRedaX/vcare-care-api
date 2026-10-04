import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { actorFromAuth, AuditRecorder } from "../../../lib/audit/audit";
import { TOKENS } from "../../../lib/di/tokens";
import { NotFound } from "../../../lib/error/errors";
import { decodeTextCursor } from "../../../lib/http/pagination/cursor";
import { buildPage, resolveLimit } from "../../../lib/http/pagination/page";
import type { Page } from "../../../lib/http/pagination/types";
import { uniqueViolationConstraint } from "../../../lib/knex/pg-errors";
import type { AuthContext } from "../../../lib/types/types";
import { SPECIALTY_CONSTRAINTS, SPECIALTY_ENTITY_TYPE, SPECIALTY_NAME_MAX_LENGTH } from "../constants";
import type { ListSpecialtiesQueryDto } from "../dto/specialties.request.dto";
import { SpecialtyAuditAction, SpecialtyField } from "../enums";
import type { Specialty } from "../entity/specialties.entity";
import { SpecialtyNameTaken, SpecialtySlugTaken } from "../errors";
import { findSpecialtyByIdForUpdate, insertSpecialty, listSpecialties, updateSpecialty } from "../repository/specialties.repo";
import type { SpecialtyChanges, SpecialtyCreateInput, SpecialtyDiff } from "../types";

@injectable()
export class SpecialtiesService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.AuditRecorder) private readonly audit: AuditRecorder,
    ) {}

    async list(viewer: AuthContext, query: ListSpecialtiesQueryDto): Promise<Page<Specialty>> {
        const limit = resolveLimit(query.limit);
        const after = query.cursor === undefined ? null : decodeTextCursor(query.cursor, SPECIALTY_NAME_MAX_LENGTH);
        const includeInactive = viewer.role === "admin" && query.includeInactive === true;
        const rows = await listSpecialties({ includeInactive, after, fetch: limit + 1 }, this.db);
        return buildPage(rows, limit, (row) => [row.name, row.id]);
    }

    async create(actor: AuthContext, input: SpecialtyCreateInput): Promise<Specialty> {
        try {
            return await this.db.transaction(async (trx) => {
                const created = await insertSpecialty(input, trx);
                await this.audit.record(trx, {
                    actor: actorFromAuth(actor),
                    action: SpecialtyAuditAction.Created,
                    entityType: SPECIALTY_ENTITY_TYPE,
                    entityId: created.id,
                    metadata: {},
                });
                return created;
            });
        } catch (error) {
            throw this.toConflict(error);
        }
    }

    async update(actor: AuthContext, id: number, changes: SpecialtyChanges): Promise<Specialty> {
        try {
            return await this.db.transaction(async (trx) => {
                const current = await findSpecialtyByIdForUpdate(id, trx);
                if (current === undefined) throw NotFound;
                const diff = this.diff(current, changes);
                if (diff.fields.length === 0) return current;
                const updated = await updateSpecialty(id, diff.columns, trx);
                await this.audit.record(trx, {
                    actor: actorFromAuth(actor),
                    action: SpecialtyAuditAction.Updated,
                    entityType: SPECIALTY_ENTITY_TYPE,
                    entityId: id,
                    metadata: { changedFields: diff.fields.join(",") },
                });
                return updated;
            });
        } catch (error) {
            throw this.toConflict(error);
        }
    }

    private diff(current: Specialty, changes: SpecialtyChanges): SpecialtyDiff {
        const fields: SpecialtyField[] = [];
        const columns: SpecialtyDiff["columns"] = {};
        if (changes.name !== undefined && changes.name !== current.name) {
            fields.push(SpecialtyField.Name);
            columns.name = changes.name;
        }
        if (changes.slug !== undefined && changes.slug !== current.slug) {
            fields.push(SpecialtyField.Slug);
            columns.slug = changes.slug;
        }
        if (changes.description !== undefined && changes.description !== current.description) {
            fields.push(SpecialtyField.Description);
            columns.description = changes.description;
        }
        if (changes.isActive !== undefined && changes.isActive !== current.isActive) {
            fields.push(SpecialtyField.IsActive);
            columns.is_active = changes.isActive;
        }
        fields.sort();
        return { fields, columns };
    }

    private toConflict(error: unknown): unknown {
        const constraint = uniqueViolationConstraint(error);
        if (constraint === SPECIALTY_CONSTRAINTS.name) return SpecialtyNameTaken;
        if (constraint === SPECIALTY_CONSTRAINTS.slug) return SpecialtySlugTaken;
        return error;
    }
}
