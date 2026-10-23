import type { UserPolicy } from "../../lib/rbac/types";
import type { ExceptionRule, SlotRange, UtcInterval, WeeklyHoursRule } from "../../pkg/slots/types";

export interface DoctorSlotsQuery { typeId: number; from: string; to: string; timezone?: string }
export interface DoctorSlotInputs { timezone: string; weekly: WeeklyHoursRule[]; exceptions: ExceptionRule[]; busy: UtcInterval[]; durationMinutes: number; typeId: number }
export interface SlotWindow { fromMs: number; toMs: number }
export interface SlotType { id: number; durationMinutes: number }
export interface SlotCacheVersion { version: string; usable: boolean }
export interface SlotResult { slots: SlotRange[]; fromMs: number; toMs: number; timezone: string; doctorTimezone: string }
export type AvailabilityPolicies = Readonly<{ slots: UserPolicy }>;
