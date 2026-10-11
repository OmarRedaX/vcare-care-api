import { ArrayMaxSize, IsArray, IsIn, ValidateIf } from "class-validator";
import { IsCalendarDate } from "../../../lib/validation/date-decorator";
import { IsTextList } from "../../../lib/validation/text-list-decorator";
import { IsIanaTimezone } from "../../../lib/validation/timezone-decorator";
import { MAX_PROFILE_LIST_ITEMS, PROFILE_LIST_ITEM_MAX_LENGTH } from "../constants";
import { BloodType, Gender } from "../enums";
import type { PatientProfileChanges } from "../types";

export class PatientProfileUpdateDto {
    @ValidateIf((_o, v) => v !== undefined && v !== null) @IsCalendarDate() dateOfBirth?: string | null;
    @ValidateIf((_o, v) => v !== undefined && v !== null) @IsIn(Object.values(Gender)) gender?: Gender | null;
    @ValidateIf((_o, v) => v !== undefined && v !== null) @IsIn(Object.values(BloodType)) bloodType?: BloodType | null;
    @ValidateIf((_o, v) => v !== undefined) @IsArray() @ArrayMaxSize(MAX_PROFILE_LIST_ITEMS) @IsTextList(PROFILE_LIST_ITEM_MAX_LENGTH) allergies?: string[];
    @ValidateIf((_o, v) => v !== undefined) @IsArray() @ArrayMaxSize(MAX_PROFILE_LIST_ITEMS) @IsTextList(PROFILE_LIST_ITEM_MAX_LENGTH) chronicConditions?: string[];
    @ValidateIf((_o, v) => v !== undefined) @IsIanaTimezone() timezone?: string;

    isEmpty(): boolean { return Object.values(this.toChanges()).every((value) => value === undefined); }
    toChanges(): PatientProfileChanges {
        const changes: PatientProfileChanges = {};
        if (this.dateOfBirth !== undefined) changes.dateOfBirth = this.dateOfBirth;
        if (this.gender !== undefined) changes.gender = this.gender;
        if (this.bloodType !== undefined) changes.bloodType = this.bloodType;
        if (this.allergies !== undefined) changes.allergies = this.allergies;
        if (this.chronicConditions !== undefined) changes.chronicConditions = this.chronicConditions;
        if (this.timezone !== undefined) changes.timezone = this.timezone;
        return changes;
    }
}
