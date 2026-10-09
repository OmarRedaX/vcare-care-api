import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";
import { PaginationQueryDto } from "../../../lib/http/pagination/pagination.request.dto";
import { ToInt } from "../../../lib/validation/transforms";
import { CodePointLength, NoControlCharacters, NotBlank } from "../../../lib/validation/string-decorators";
import { VerificationStatus } from "../../doctors/enums";
import { VerificationDocumentType } from "../enums";

export class UploadVerificationIntentRequestDto { @IsEnum(VerificationDocumentType) type!: VerificationDocumentType; }
export class DocumentIdParamsDto { @ToInt() @IsInt() @Min(1) documentId!: number; }
export class UploadIdParamsDto { @ToInt() @IsInt() @Min(1) uploadId!: number; }
export class ApplicationIdParamsDto { @ToInt() @IsInt() @Min(1) id!: number; }
export class ApplicationDocumentParamsDto { @ToInt() @IsInt() @Min(1) id!: number; @ToInt() @IsInt() @Min(1) documentId!: number; }
export class ApplicationApproveDto { @IsOptional() @IsString() @CodePointLength(0, 2000) @NoControlCharacters("all") @Matches(/^$|\S/, { message: "must not be blank" }) note?: string; }
export class ApplicationRejectDto { @IsString() @CodePointLength(3, 2000) @NoControlCharacters("all") @NotBlank() reason!: string; }
export class ApplicationQueueQueryDto extends PaginationQueryDto {
    @IsOptional() @IsEnum(VerificationStatus) status?: VerificationStatus = VerificationStatus.Submitted;
    @IsOptional() @IsString() @MaxLength(1024) override cursor?: string = undefined;
    @IsOptional() @ToInt() @IsInt() @Min(1) @Max(100) override limit?: number = 20;
}
