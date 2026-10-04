import type { Specialty } from "../entity/specialties.entity";

export class SpecialtyResponseDto {
    id!: number;
    name!: string;
    slug!: string;
    description!: string | null;
    isActive!: boolean;
    createdAt!: string;
    updatedAt!: string;

    static from(entity: Specialty): SpecialtyResponseDto {
        const response = new SpecialtyResponseDto();
        response.id = entity.id;
        response.name = entity.name;
        response.slug = entity.slug;
        response.description = entity.description;
        response.isActive = entity.isActive;
        response.createdAt = entity.createdAt.toISOString();
        response.updatedAt = entity.updatedAt.toISOString();
        return response;
    }
}
