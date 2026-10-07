import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsDefined, IsInt, IsString, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from "class-validator";
import { CodePointLength, NoControlCharacters } from "../../../lib/validation/string-decorators";
import { IsIanaTimezone } from "../../../lib/validation/timezone-decorator";
import { BIO_MAX_LENGTH, DEFAULT_SLOT_MINUTES_MAX, DEFAULT_SLOT_MINUTES_MIN, FEE_AMOUNT_MAX, HEADLINE_MAX_LENGTH, HEADLINE_MIN_LENGTH, LANGUAGES_MAX, LANGUAGES_MIN, LANGUAGE_CODE_PATTERN, SPECIALTIES_MAX, SPECIALTIES_MIN, TIMEZONE_MAX_LENGTH, YEARS_EXPERIENCE_MAX, YEARS_EXPERIENCE_MIN } from "../constants";
import type { DoctorProfileChanges, DoctorProfileInput } from "../types";

export class MoneyDto {
    @IsInt() @Min(0) @Max(FEE_AMOUNT_MAX) amount!: number;
    @IsString() @Matches(/^[A-Z]{3}$/) currency!: string;
}

export class DoctorApplyDto {
    @IsString() @CodePointLength(HEADLINE_MIN_LENGTH, HEADLINE_MAX_LENGTH) @NoControlCharacters("all") headline!: string;
    @ValidateIf((_object, value) => value !== undefined) @IsString() @CodePointLength(0, BIO_MAX_LENGTH) @NoControlCharacters("nul") bio?: string;
    @IsInt() @Min(YEARS_EXPERIENCE_MIN) @Max(YEARS_EXPERIENCE_MAX) yearsExperience!: number;
    @IsArray() @ArrayMinSize(LANGUAGES_MIN) @ArrayMaxSize(LANGUAGES_MAX) @ArrayUnique() @Matches(LANGUAGE_CODE_PATTERN, { each: true }) languages!: string[];
    @IsArray() @ArrayMinSize(SPECIALTIES_MIN) @ArrayMaxSize(SPECIALTIES_MAX) @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true }) specialtyIds!: number[];
    @IsInt() @Min(1) primarySpecialtyId!: number;
    @IsDefined() @ValidateNested() @Type(() => MoneyDto) consultationFee!: MoneyDto;
    @IsInt() @Min(DEFAULT_SLOT_MINUTES_MIN) @Max(DEFAULT_SLOT_MINUTES_MAX) defaultSlotMinutes!: number;
    @IsString() @MaxLength(TIMEZONE_MAX_LENGTH) @IsIanaTimezone() timezone!: string;
    @IsBoolean() submit!: boolean;

    toInput(): DoctorProfileInput {
        return { headline: this.headline, bio: this.bio, yearsExperience: this.yearsExperience, languages: this.languages,
            specialtyIds: this.specialtyIds, primarySpecialtyId: this.primarySpecialtyId, consultationFee: this.consultationFee,
            defaultSlotMinutes: this.defaultSlotMinutes, timezone: this.timezone, submit: this.submit };
    }
}

export class DoctorProfileUpdateDto {
    @ValidateIf((_o, v) => v !== undefined) @IsString() @CodePointLength(HEADLINE_MIN_LENGTH, HEADLINE_MAX_LENGTH) @NoControlCharacters("all") headline?: string;
    @ValidateIf((_o, v) => v !== undefined && v !== null) @IsString() @CodePointLength(0, BIO_MAX_LENGTH) @NoControlCharacters("nul") bio?: string | null;
    @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(YEARS_EXPERIENCE_MIN) @Max(YEARS_EXPERIENCE_MAX) yearsExperience?: number;
    @ValidateIf((_o, v) => v !== undefined) @IsArray() @ArrayMinSize(LANGUAGES_MIN) @ArrayMaxSize(LANGUAGES_MAX) @ArrayUnique() @Matches(LANGUAGE_CODE_PATTERN, { each: true }) languages?: string[];
    @ValidateIf((_o, v) => v !== undefined) @IsArray() @ArrayMinSize(SPECIALTIES_MIN) @ArrayMaxSize(SPECIALTIES_MAX) @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true }) specialtyIds?: number[];
    @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(1) primarySpecialtyId?: number;
    @ValidateIf((_o, v) => v !== undefined) @ValidateNested() @Type(() => MoneyDto) consultationFee?: MoneyDto;
    @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(DEFAULT_SLOT_MINUTES_MIN) @Max(DEFAULT_SLOT_MINUTES_MAX) defaultSlotMinutes?: number;
    @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(TIMEZONE_MAX_LENGTH) @IsIanaTimezone() timezone?: string;
    @ValidateIf((_o, v) => v !== undefined) @IsBoolean() isAcceptingPatients?: boolean;

    isEmpty(): boolean { return Object.values(this.toChanges()).every((value) => value === undefined); }
    toChanges(): DoctorProfileChanges {
        const changes: DoctorProfileChanges = {};
        if (this.headline !== undefined) changes.headline = this.headline;
        if (this.bio !== undefined) changes.bio = this.bio;
        if (this.yearsExperience !== undefined) changes.yearsExperience = this.yearsExperience;
        if (this.languages !== undefined) changes.languages = this.languages;
        if (this.specialtyIds !== undefined) changes.specialtyIds = this.specialtyIds;
        if (this.primarySpecialtyId !== undefined) changes.primarySpecialtyId = this.primarySpecialtyId;
        if (this.consultationFee !== undefined) changes.consultationFee = this.consultationFee;
        if (this.defaultSlotMinutes !== undefined) changes.defaultSlotMinutes = this.defaultSlotMinutes;
        if (this.timezone !== undefined) changes.timezone = this.timezone;
        if (this.isAcceptingPatients !== undefined) changes.isAcceptingPatients = this.isAcceptingPatients;
        return changes;
    }
}
