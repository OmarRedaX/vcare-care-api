import { IsBoolean, IsOptional, IsString, Matches, MaxLength, ValidateIf } from "class-validator";
import { PaginationQueryDto } from "../../../lib/http/pagination/pagination.request.dto";
import { CodePointLength, NoControlCharacters } from "../../../lib/validation/string-decorators";
import { ToBoolean } from "../../../lib/validation/transforms";
import {
    SLUG_PATTERN,
    SPECIALTY_DESCRIPTION_MAX_LENGTH,
    SPECIALTY_NAME_MAX_LENGTH,
    SPECIALTY_NAME_MIN_LENGTH,
    SPECIALTY_SLUG_MAX_LENGTH,
} from "../constants";
import type { SpecialtyChanges, SpecialtyCreateInput } from "../types";

export class ListSpecialtiesQueryDto extends PaginationQueryDto {
    @IsOptional()
    @ToBoolean()
    @IsBoolean()
    includeInactive?: boolean = false;
}

export class CreateSpecialtyDto {
    @IsString()
    @CodePointLength(SPECIALTY_NAME_MIN_LENGTH, SPECIALTY_NAME_MAX_LENGTH)
    @NoControlCharacters("all")
    name!: string;

    @IsString()
    @MaxLength(SPECIALTY_SLUG_MAX_LENGTH)
    @Matches(SLUG_PATTERN)
    slug!: string;

    @ValidateIf((_object, value) => value !== undefined)
    @IsString()
    @CodePointLength(0, SPECIALTY_DESCRIPTION_MAX_LENGTH)
    @NoControlCharacters("nul")
    description?: string;

    toInput(): SpecialtyCreateInput {
        return { name: this.name, slug: this.slug, description: this.description ?? null };
    }
}

export class UpdateSpecialtyDto {
    @ValidateIf((_object, value) => value !== undefined)
    @IsString()
    @CodePointLength(SPECIALTY_NAME_MIN_LENGTH, SPECIALTY_NAME_MAX_LENGTH)
    @NoControlCharacters("all")
    name?: string;

    @ValidateIf((_object, value) => value !== undefined)
    @IsString()
    @MaxLength(SPECIALTY_SLUG_MAX_LENGTH)
    @Matches(SLUG_PATTERN)
    slug?: string;

    @IsOptional()
    @IsString()
    @CodePointLength(0, SPECIALTY_DESCRIPTION_MAX_LENGTH)
    @NoControlCharacters("nul")
    description?: string | null;

    @ValidateIf((_object, value) => value !== undefined)
    @IsBoolean()
    isActive?: boolean;

    /** An empty PATCH has no defined field, even though class fields may exist as undefined. */
    isEmpty(): boolean {
        return this.name === undefined && this.slug === undefined && this.description === undefined &&
            this.isActive === undefined;
    }

    toChanges(): SpecialtyChanges {
        const changes: SpecialtyChanges = {};
        if (this.name !== undefined) changes.name = this.name;
        if (this.slug !== undefined) changes.slug = this.slug;
        if (this.description !== undefined) changes.description = this.description;
        if (this.isActive !== undefined) changes.isActive = this.isActive;
        return changes;
    }
}
