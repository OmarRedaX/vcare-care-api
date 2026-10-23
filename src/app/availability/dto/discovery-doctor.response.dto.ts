import type { HydratedUser } from "../../../lib/identity-client/types";
import { MoneyResponseDto, SpecialtyRefResponseDto } from "../../doctors/dto/doctors.response.dto";
import type { PublicDoctorView } from "../../doctors/types";
import { ConsultationTypeResponseDto } from "../../schedules/dto/schedules.response.dto";
import { DoctorBookability } from "../enums";
import type { DiscoveryItem, ProfileResult } from "../types";
import { SlotResponseDto } from "./availability.response.dto";

/**
 * The public `DoctorProfile` (contract) for search items and the profile route. It carries no verification state, review note, suspension,
 * sync status or `defaultSlotMinutes`; only an admin viewer of the profile route additionally gets `status` (availability spec 3.2).
 */
export class DiscoveryDoctorResponseDto {
    userId!: number;
    displayName!: string | null;
    avatarUrl!: string | null;
    profileHydrated!: boolean;
    headline!: string;
    bio!: string | null;
    yearsExperience!: number;
    languages!: string[];
    specialties!: SpecialtyRefResponseDto[];
    consultationFee!: MoneyResponseDto;
    timezone!: string;
    isAcceptingPatients!: boolean;
    nextAvailableAt!: string | null;
    consultationTypes!: ConsultationTypeResponseDto[];
    nextAvailableSlots?: SlotResponseDto[];
    status?: DoctorBookability;

    private static base(view: PublicDoctorView, hydrated: HydratedUser | undefined, nextAvailableAt: number | null): DiscoveryDoctorResponseDto {
        const profile = view.profile;
        return {
            userId: profile.userId, displayName: hydrated?.displayName ?? null, avatarUrl: hydrated?.avatarUrl ?? null, profileHydrated: hydrated !== undefined,
            headline: profile.headline, bio: profile.bio, yearsExperience: profile.yearsExperience, languages: [...view.languages].sort(),
            specialties: view.specialties.map((ref) => SpecialtyRefResponseDto.from(ref)),
            consultationFee: MoneyResponseDto.from(profile.consultationFeeAmount, profile.currency), timezone: profile.timezone,
            isAcceptingPatients: profile.isAcceptingPatients, nextAvailableAt: nextAvailableAt === null ? null : new Date(nextAvailableAt).toISOString(),
            consultationTypes: view.activeTypes.map((type) => ConsultationTypeResponseDto.from(type)),
        };
    }

    /** A search item: no slots preview, no `status`. */
    static fromSearch(item: DiscoveryItem, hydrated: HydratedUser | undefined): DiscoveryDoctorResponseDto {
        return DiscoveryDoctorResponseDto.base(item.view, hydrated, item.nextAvailableAt);
    }

    /** The profile: the slots preview rendered in the caller zone, and `status` for an admin viewer. */
    static fromProfile(result: ProfileResult): DiscoveryDoctorResponseDto {
        const dto = DiscoveryDoctorResponseDto.base(result.view, result.hydrated, result.nextAvailableAt);
        dto.nextAvailableSlots = result.slots.map((slot) => SlotResponseDto.from(slot, result.timezone));
        if (result.admin) dto.status = result.view.bookable ? DoctorBookability.Bookable : DoctorBookability.NotBookable;
        return dto;
    }
}
