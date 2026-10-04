import type { StringCursorPosition } from "../../lib/http/pagination/types";
import type { UserPolicy } from "../../lib/rbac/types";
import type { SpecialtyField } from "./enums";

export interface SpecialtyRow {
    id: number;
    name: string;
    slug: string;
    description: string | null;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
}

export interface ListSpecialtiesParams {
    includeInactive: boolean;
    after: StringCursorPosition | null;
    fetch: number;
}

export interface SpecialtyCreateInput {
    name: string;
    slug: string;
    description: string | null;
}

export interface SpecialtyChanges {
    name?: string;
    slug?: string;
    description?: string | null;
    isActive?: boolean;
}

export interface SpecialtyColumnChanges {
    name?: string;
    slug?: string;
    description?: string | null;
    is_active?: boolean;
}

export interface SpecialtyDiff {
    fields: SpecialtyField[];
    columns: SpecialtyColumnChanges;
}

export type SpecialtiesRoute = "list" | "create" | "update";
export type SpecialtiesPolicies = Readonly<Record<SpecialtiesRoute, UserPolicy>>;
