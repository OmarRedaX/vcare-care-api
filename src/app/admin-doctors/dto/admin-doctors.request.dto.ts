import { IsInt, IsString, Min } from "class-validator";
import { ToInt } from "../../../lib/validation/transforms";
import { CodePointLength, NoControlCharacters } from "../../../lib/validation/string-decorators";

/** `{doctorUserId}` is the doctor's Identity user id, not the profile id. */
export class DoctorUserIdParamsDto { @ToInt() @IsInt() @Min(1) doctorUserId!: number; }
export class SuspendDoctorDto { @IsString() @CodePointLength(3, 2000) @NoControlCharacters("all") reason!: string; }
export class ReinstateDoctorDto { @IsString() @CodePointLength(3, 2000) @NoControlCharacters("all") reason!: string; }
