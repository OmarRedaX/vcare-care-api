import { Specialty } from "../../../../src/app/specialties/entity/specialties.entity";
import { SpecialtyResponseDto } from "../../../../src/app/specialties/dto/specialties.response.dto";
import { inlineLists, schemaBlock } from "../../../helpers/contract";

describe("SpecialtyResponseDto", () => {
    const entity = new Specialty({
        id: 7,
        name: "Synthetic Specialty",
        slug: "synthetic-specialty",
        description: null,
        isActive: true,
        createdAt: new Date("2026-01-02T03:04:05.678Z"),
        updatedAt: new Date("2026-02-03T04:05:06.789Z"),
    });

    it("should copy every field and render dates with toISOString", () => {
        expect({ ...SpecialtyResponseDto.from(entity) }).toEqual({
            id: 7,
            name: "Synthetic Specialty",
            slug: "synthetic-specialty",
            description: null,
            isActive: true,
            createdAt: "2026-01-02T03:04:05.678Z",
            updatedAt: "2026-02-03T04:05:06.789Z",
        });
    });

    it("should produce exactly the contract Specialty required keys", () => {
        const [required = []] = inlineLists(schemaBlock("Specialty"), "required");
        expect(Object.keys(SpecialtyResponseDto.from(entity)).sort()).toEqual([...required].sort());
    });
});
