import "reflect-metadata";
import type { Knex } from "knex";
import * as repo from "../../../../src/app/consultations/repository/consultations.repo";
import { buildScheduleImpactProvider } from "../../../../src/app/consultations/service/schedule-impact.provider";
import { ConsultationSuspensionImpactProvider } from "../../../../src/app/consultations/service/suspension-impact.provider";
import type { ScheduleImpactContext } from "../../../../src/app/schedules/types";
import { localInstant } from "../../../../src/pkg/slots/instant";
import type { OpenDay } from "../../../../src/pkg/slots/types";

const TZ = "Africa/Cairo";
const NOW = new Date("2030-01-01T08:00:00Z");
const MINUTE = 60_000;
const trx = { id: "trx" } as unknown as Knex.Transaction;
const ctx = (change: ScheduleImpactContext["change"]): ScheduleImpactContext => ({ doctorProfileId: 9, doctorUserId: 202, timezone: TZ, now: NOW, change });
const candidate = (id: number, startIso: string, minutes = 30) => ({ id, starts_at: new Date(startIso), ends_at: new Date(Date.parse(startIso) + minutes * MINUTE) });
const day = (date: string, startIso: string, endIso: string): OpenDay => ({ date, intervals: [{ startMs: Date.parse(startIso), endMs: Date.parse(endIso) }] });

function setup() {
    const resolveOpenDays = jest.fn().mockResolvedValue([]);
    const enqueue = jest.fn().mockResolvedValue(undefined);
    const provider = buildScheduleImpactProvider({ getSchedules: () => ({ resolveOpenDays }) as never, notifications: { enqueue } });
    return { provider, resolveOpenDays, enqueue };
}

afterEach(() => { jest.restoreAllMocks(); });

describe("ScheduleImpactProvider.findAffected", () => {
    it("should consider every future consultation (no window) when the working hours change", async () => {
        const { provider } = setup();
        const candidates = jest.spyOn(repo, "listAffectedCandidates").mockResolvedValue([]);
        await expect(provider.findAffected(ctx({ kind: "working_hours" }), trx)).resolves.toEqual([]);
        expect(candidates).toHaveBeenCalledWith(202, NOW, null, trx);
    });

    it("should limit the candidates to the doctor-local days of a created exception", async () => {
        const { provider } = setup();
        const candidates = jest.spyOn(repo, "listAffectedCandidates").mockResolvedValue([]);
        await provider.findAffected(ctx({ kind: "schedule_exception_created", fromDate: "2030-01-10", toDate: "2030-01-12" }), trx);
        expect(candidates).toHaveBeenCalledWith(202, NOW, { fromMs: localInstant("2030-01-10", 0, TZ, "start"), toMs: localInstant("2030-01-12", 1440, TZ, "end") }, trx);
    });

    it("should limit the candidates to the single doctor-local day of a deleted exception", async () => {
        const { provider } = setup();
        const candidates = jest.spyOn(repo, "listAffectedCandidates").mockResolvedValue([]);
        await provider.findAffected(ctx({ kind: "schedule_exception_deleted", date: "2030-01-10" }), trx);
        expect(candidates).toHaveBeenCalledWith(202, NOW, { fromMs: localInstant("2030-01-10", 0, TZ, "start"), toMs: localInstant("2030-01-10", 1440, TZ, "end") }, trx);
    });

    it("should read no schedule when there is no candidate", async () => {
        const { provider, resolveOpenDays } = setup();
        jest.spyOn(repo, "listAffectedCandidates").mockResolvedValue([]);
        await provider.findAffected(ctx({ kind: "working_hours" }), trx);
        expect(resolveOpenDays).not.toHaveBeenCalled();
    });

    it("should resolve the open days through the transaction with a one day margin on each side", async () => {
        const { provider, resolveOpenDays } = setup();
        jest.spyOn(repo, "listAffectedCandidates").mockResolvedValue([candidate(1, "2030-01-10T10:00:00Z"), candidate(2, "2030-01-12T10:00:00Z")]);
        await provider.findAffected(ctx({ kind: "working_hours" }), trx);
        expect(resolveOpenDays).toHaveBeenCalledWith(9, TZ, "2030-01-09", "2030-01-13", trx);
    });

    it("should report, in ascending id order, only the consultations not contained in one open interval", async () => {
        const { provider, resolveOpenDays } = setup();
        jest.spyOn(repo, "listAffectedCandidates").mockResolvedValue([
            candidate(1, "2030-01-10T10:00:00Z"), // inside
            candidate(2, "2030-01-10T13:45:00Z"), // ends 14:15, past the 14:00 close
            candidate(3, "2030-01-10T05:00:00Z"), // before the shift
            candidate(4, "2030-01-11T10:00:00Z"), // no open day
            candidate(5, "2030-01-10T13:30:00Z"), // ends exactly at close: inside
        ]);
        resolveOpenDays.mockResolvedValue([day("2030-01-10", "2030-01-10T06:00:00Z", "2030-01-10T14:00:00Z")]);
        await expect(provider.findAffected(ctx({ kind: "working_hours" }), trx)).resolves.toEqual([2, 3, 4]);
    });

    it("should not re-check the slot grid, so a booking off the grid but inside an interval is not affected", async () => {
        const { provider, resolveOpenDays } = setup();
        jest.spyOn(repo, "listAffectedCandidates").mockResolvedValue([candidate(1, "2030-01-10T10:07:00Z")]);
        resolveOpenDays.mockResolvedValue([day("2030-01-10", "2030-01-10T06:00:00Z", "2030-01-10T14:00:00Z")]);
        await expect(provider.findAffected(ctx({ kind: "working_hours" }), trx)).resolves.toEqual([]);
    });

    it("should not treat a consultation spanning two split intervals as covered", async () => {
        const { provider, resolveOpenDays } = setup();
        jest.spyOn(repo, "listAffectedCandidates").mockResolvedValue([candidate(1, "2030-01-10T09:45:00Z")]);
        resolveOpenDays.mockResolvedValue([{ date: "2030-01-10", intervals: [
            { startMs: Date.parse("2030-01-10T06:00:00Z"), endMs: Date.parse("2030-01-10T10:00:00Z") },
            { startMs: Date.parse("2030-01-10T10:00:00Z"), endMs: Date.parse("2030-01-10T14:00:00Z") },
        ] }]);
        await expect(provider.findAffected(ctx({ kind: "working_hours" }), trx)).resolves.toEqual([1]);
    });

    it("should evaluate 200 consultations over a 60 day span in under 20 ms of in-memory work", async () => {
        const { provider, resolveOpenDays } = setup();
        const days: OpenDay[] = [];
        const rows = [];
        for (let offset = 0; offset < 60; offset += 1) {
            const date = new Date(Date.UTC(2030, 0, 2 + offset));
            const iso = date.toISOString().slice(0, 10);
            days.push(day(iso, `${iso}T06:00:00Z`, `${iso}T14:00:00Z`));
            for (let slot = 0; slot < 4 && rows.length < 200; slot += 1) rows.push(candidate(rows.length + 1, `${iso}T${String(7 + slot * 2).padStart(2, "0")}:00:00Z`));
        }
        jest.spyOn(repo, "listAffectedCandidates").mockResolvedValue(rows);
        resolveOpenDays.mockResolvedValue(days);
        const started = performance.now();
        const affected = await provider.findAffected(ctx({ kind: "working_hours" }), trx);
        const elapsed = performance.now() - started;
        expect(rows).toHaveLength(200);
        expect(affected).toEqual([]);
        expect(elapsed).toBeLessThan(20);
    });
});

describe("ScheduleImpactProvider.flagAffected", () => {
    it("should flag the ids as schedule_blocked in the transaction and queue one schedule_blocked message per patient", async () => {
        const { provider, enqueue } = setup();
        const flag = jest.spyOn(repo, "flagConsultations").mockResolvedValue([
            { id: 1, patient_user_id: 101, starts_at: new Date("2030-01-10T10:00:00Z"), ends_at: new Date("2030-01-10T10:30:00Z") },
            { id: 2, patient_user_id: 102, starts_at: new Date("2030-01-10T11:00:00Z"), ends_at: new Date("2030-01-10T11:30:00Z") },
        ]);
        await provider.flagAffected(ctx({ kind: "working_hours" }), [1, 2], trx);
        expect(flag).toHaveBeenCalledWith([1, 2], 202, "schedule_blocked", trx);
        expect(enqueue).toHaveBeenCalledWith(trx, [
            { kind: "schedule_blocked", consultationId: 1, recipientUserId: 101, payload: { startsAt: "2030-01-10T10:00:00.000Z", endsAt: "2030-01-10T10:30:00.000Z", recipientRole: "patient" } },
            { kind: "schedule_blocked", consultationId: 2, recipientUserId: 102, payload: { startsAt: "2030-01-10T11:00:00.000Z", endsAt: "2030-01-10T11:30:00.000Z", recipientRole: "patient" } },
        ]);
    });

    it("should queue nothing for a row that left a non-terminal status before the flag", async () => {
        const { provider, enqueue } = setup();
        jest.spyOn(repo, "flagConsultations").mockResolvedValue([]);
        await provider.flagAffected(ctx({ kind: "working_hours" }), [1], trx);
        expect(enqueue).toHaveBeenCalledWith(trx, []);
    });
});

describe("ConsultationSuspensionImpactProvider", () => {
    const suspension = { doctorProfileId: 9, doctorUserId: 202, now: NOW };

    it("should flag the future consultations doctor_suspended and return their ids", async () => {
        const flag = jest.spyOn(repo, "flagFutureForDoctor").mockResolvedValue([
            { id: 3, patient_user_id: 101, starts_at: NOW, ends_at: NOW }, { id: 8, patient_user_id: 102, starts_at: NOW, ends_at: NOW },
        ]);
        await expect(new ConsultationSuspensionImpactProvider().flagFutureConsultations(suspension, trx)).resolves.toEqual([3, 8]);
        expect(flag).toHaveBeenCalledWith(202, NOW, "doctor_suspended", trx);
    });

    it("should list the consultations already flagged doctor_suspended", async () => {
        const conn = { id: "db" } as unknown as Knex;
        const list = jest.spyOn(repo, "listFlaggedIds").mockResolvedValue([3, 8]);
        await expect(new ConsultationSuspensionImpactProvider().listFlaggedConsultations(suspension, conn)).resolves.toEqual([3, 8]);
        expect(list).toHaveBeenCalledWith(202, "doctor_suspended", NOW, conn);
    });
});
