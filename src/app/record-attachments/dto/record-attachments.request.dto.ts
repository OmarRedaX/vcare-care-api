import { IsString, ValidateIf } from "class-validator";
import { CodePointLength, NoControlCharacters, NotBlank } from "../../../lib/validation/string-decorators";
import { ATTACHMENT_DESCRIPTION_MAX_LENGTH } from "../constants";
import type { RecordAttachmentIntentInput } from "../types";

/**
 * Intent body: `description` is optional clinical free text, set or absent (JSON `null` fails the type check); unknown members are
 * rejected by the shared validation options. The controller validates `req.body ?? {}`.
 */
export class RecordAttachmentIntentDto {
    @ValidateIf((_o, v) => v !== undefined) @IsString() @NotBlank() @CodePointLength(1, ATTACHMENT_DESCRIPTION_MAX_LENGTH) @NoControlCharacters("nul") description?: string;

    toInput(): RecordAttachmentIntentInput {
        return { attachmentDescription: this.description ?? null };
    }
}
