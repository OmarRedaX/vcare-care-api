import { IsInt, IsString, Matches, Max, Min, ValidateIf } from "class-validator";
import { PaginationQueryDto } from "../../../lib/http/pagination/pagination.request.dto";
import { CodePointLength, NoControlCharacters, NotBlank } from "../../../lib/validation/string-decorators";
import {
    AMENDMENT_REASON_MAX_LENGTH, AMENDMENT_REASON_MIN_LENGTH, CHIEF_COMPLAINT_MAX_LENGTH, CHIEF_COMPLAINT_MIN_LENGTH, DIAGNOSIS_CODE_PATTERN,
    DIAGNOSIS_TEXT_MAX_LENGTH, FOLLOW_UP_MAX_DAYS, FOLLOW_UP_MIN_DAYS, NOTES_MAX_LENGTH, TREATMENT_PLAN_MAX_LENGTH,
} from "../constants";
import type { RecordChanges, RecordCreateInput, RecordUpdateInput, TimelineQuery } from "../types";

/**
 * Create body: `chiefComplaint` is the one required member. The patient and doctor ids are never read from the body (the service copies
 * them from the consultation) and unknown members are rejected. An optional member is set or absent: JSON `null` fails its type check.
 */
export class MedicalRecordCreateDto {
    @IsString() @NotBlank() @CodePointLength(CHIEF_COMPLAINT_MIN_LENGTH, CHIEF_COMPLAINT_MAX_LENGTH) @NoControlCharacters("nul") chiefComplaint!: string;
    @ValidateIf((_o, v) => v !== undefined) @IsString() @NotBlank() @CodePointLength(1, NOTES_MAX_LENGTH) @NoControlCharacters("nul") examinationNotes?: string;
    @ValidateIf((_o, v) => v !== undefined) @IsString() @NotBlank() @CodePointLength(1, DIAGNOSIS_TEXT_MAX_LENGTH) @NoControlCharacters("nul") diagnosisText?: string;
    @ValidateIf((_o, v) => v !== undefined) @IsString() @Matches(DIAGNOSIS_CODE_PATTERN) diagnosisCode?: string;
    @ValidateIf((_o, v) => v !== undefined) @IsString() @NotBlank() @CodePointLength(1, TREATMENT_PLAN_MAX_LENGTH) @NoControlCharacters("nul") treatmentPlan?: string;
    @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(FOLLOW_UP_MIN_DAYS) @Max(FOLLOW_UP_MAX_DAYS) followUpInDays?: number;

    toInput(): RecordCreateInput {
        const input: RecordCreateInput = { chiefComplaint: this.chiefComplaint };
        if (this.examinationNotes !== undefined) input.examinationNotes = this.examinationNotes;
        if (this.diagnosisText !== undefined) input.diagnosisText = this.diagnosisText;
        if (this.diagnosisCode !== undefined) input.diagnosisCode = this.diagnosisCode;
        if (this.treatmentPlan !== undefined) input.treatmentPlan = this.treatmentPlan;
        if (this.followUpInDays !== undefined) input.followUpInDays = this.followUpInDays;
        return input;
    }
}

/**
 * Patch body: the same six members, all optional, plus `reason` (required only after the lock, which only the service can know).
 * A body with no record member is rejected by the controller through `hasRecordField()` (`reason` alone is not a change).
 */
export class MedicalRecordPatchDto {
    @ValidateIf((_o, v) => v !== undefined) @IsString() @NotBlank() @CodePointLength(CHIEF_COMPLAINT_MIN_LENGTH, CHIEF_COMPLAINT_MAX_LENGTH) @NoControlCharacters("nul") chiefComplaint?: string;
    @ValidateIf((_o, v) => v !== undefined) @IsString() @NotBlank() @CodePointLength(1, NOTES_MAX_LENGTH) @NoControlCharacters("nul") examinationNotes?: string;
    @ValidateIf((_o, v) => v !== undefined) @IsString() @NotBlank() @CodePointLength(1, DIAGNOSIS_TEXT_MAX_LENGTH) @NoControlCharacters("nul") diagnosisText?: string;
    @ValidateIf((_o, v) => v !== undefined) @IsString() @Matches(DIAGNOSIS_CODE_PATTERN) diagnosisCode?: string;
    @ValidateIf((_o, v) => v !== undefined) @IsString() @NotBlank() @CodePointLength(1, TREATMENT_PLAN_MAX_LENGTH) @NoControlCharacters("nul") treatmentPlan?: string;
    @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(FOLLOW_UP_MIN_DAYS) @Max(FOLLOW_UP_MAX_DAYS) followUpInDays?: number;
    @ValidateIf((_o, v) => v !== undefined) @IsString() @NotBlank() @CodePointLength(AMENDMENT_REASON_MIN_LENGTH, AMENDMENT_REASON_MAX_LENGTH) @NoControlCharacters("nul") reason?: string;

    hasRecordField(): boolean {
        return Object.keys(this.toChanges()).length > 0;
    }

    toInput(): RecordUpdateInput {
        return this.reason === undefined ? { changes: this.toChanges() } : { changes: this.toChanges(), reason: this.reason };
    }

    private toChanges(): RecordChanges {
        const changes: RecordChanges = {};
        if (this.chiefComplaint !== undefined) changes.chiefComplaint = this.chiefComplaint;
        if (this.examinationNotes !== undefined) changes.examinationNotes = this.examinationNotes;
        if (this.diagnosisText !== undefined) changes.diagnosisText = this.diagnosisText;
        if (this.diagnosisCode !== undefined) changes.diagnosisCode = this.diagnosisCode;
        if (this.treatmentPlan !== undefined) changes.treatmentPlan = this.treatmentPlan;
        if (this.followUpInDays !== undefined) changes.followUpInDays = this.followUpInDays;
        return changes;
    }
}

/** `cursor` and `limit` come from the shared pagination DTO; the cursor is decoded by the service. */
export class TimelineQueryDto extends PaginationQueryDto {
    toQuery(): TimelineQuery {
        return { cursor: this.cursor, limit: this.limit };
    }
}
