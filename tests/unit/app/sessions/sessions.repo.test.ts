import "reflect-metadata";
import knex from "knex";
import type { Knex } from "knex";
import { ConsultationRowsService } from "../../../../src/app/consultations/service/consultation-rows.service";
import { Consultation } from "../../../../src/app/consultations/entity/consultation.entity";
import { listCalendarQuery, listWaitingRoomQuery, setRoomIfAbsent } from "../../../../src/app/consultations/repository/consultations.repo";
import { fakeLogger } from "../../../helpers/fake-logger";

const NOW = Date.parse("2030-01-01T10:00:00Z");
const MINUTE = 60_000;
const dry = knex({ client: "pg" });
afterAll(async () => { await dry.destroy(); });

describe("consultations.repo session queries", () => {
    it("should select the doctor's live booked and waiting rows whose half-open window contains now, ordered by start then id", () => {
        const { sql, bindings } = listWaitingRoomQuery({ doctorUserId: 202, nowMs: NOW, openMinutes: 10, overrunMinutes: 15, limit: 100 }, dry).toSQL().toNative();
        expect(sql).toContain('"consultations"."doctor_user_id" = $1');
        expect(sql).toContain('"consultations"."status" in ($2, $3)');
        expect(sql).toContain('"consultations"."deleted_at" is null');
        expect(sql).toMatch(/consultations\.starts_at <= \$4::timestamptz AND consultations\.starts_at >= \$5::timestamptz AND consultations\.ends_at > \$6::timestamptz/);
        expect(sql).toContain("order by consultations.starts_at ASC, consultations.id ASC");
        expect(sql).toMatch(/limit \$7$/);
        expect(bindings).toEqual([202, "booked", "waiting", new Date(NOW + 10 * MINUTE).toISOString(), new Date(NOW - (240 + 15) * MINUTE).toISOString(),
            new Date(NOW - 15 * MINUTE).toISOString(), 100]);
        expect(sql).not.toContain("complaint_text");
        expect(sql).not.toContain("select *");
    });

    it("should select every status overlapping the calendar window for the doctor, without clinical text", () => {
        const from = NOW;
        const to = NOW + 24 * 60 * MINUTE;
        const { sql, bindings } = listCalendarQuery({ doctorUserId: 202, fromMs: from, toMs: to, limit: 1000 }, dry).toSQL().toNative();
        expect(sql).toContain('"consultations"."doctor_user_id" = $1');
        expect(sql).not.toContain(".status\" in");
        expect(sql).toMatch(/consultations\.starts_at < \$2::timestamptz AND consultations\.ends_at > \$3::timestamptz AND consultations\.starts_at >= \$4::timestamptz/);
        expect(sql).toContain("order by consultations.starts_at ASC, consultations.id ASC");
        expect(bindings).toEqual([202, new Date(to).toISOString(), new Date(from).toISOString(), new Date(from - 240 * MINUTE).toISOString(), 1000]);
        expect(sql).not.toContain("complaint_text");
    });

    it("should write the room only while none is stored on a live non-terminal row, without touching updated_at", async () => {
        const calls: Array<[string, unknown[]]> = [];
        const chain: Record<string, unknown> = {};
        for (const name of ["where", "whereNull", "whereIn"]) chain[name] = (...args: unknown[]) => { calls.push([name, args]); return chain; };
        chain.update = (values: unknown) => { calls.push(["update", [values]]); return Promise.resolve(1); };
        const conn = (() => chain) as unknown as Knex;
        expect(await setRoomIfAbsent(7, "room-7", conn)).toBe(true);
        expect(calls).toEqual([
            ["where", ["id", 7]], ["whereNull", ["room_id"]], ["whereIn", ["status", ["booked", "waiting", "in_progress"]]], ["whereNull", ["deleted_at"]],
            ["update", [{ room_id: "room-7" }]],
        ]);
        chain.update = () => Promise.resolve(0);
        expect(await setRoomIfAbsent(7, "room-7", conn)).toBe(false);
    });
});

describe("ConsultationRowsService.notifyChanged", () => {
    const consultation = new Consultation({ id: 7, doctorUserId: 202 });

    it("should pass the kind, doctor and consultation id to the listener", async () => {
        const listener = { onConsultationChanged: jest.fn().mockResolvedValue(undefined) };
        const service = new ConsultationRowsService({} as Knex, fakeLogger().logger, listener);
        await service.notifyChanged("no_show" as never, consultation);
        expect(listener.onConsultationChanged).toHaveBeenCalledWith({ kind: "no_show", doctorUserId: 202, consultationId: 7 });
    });

    it("should swallow a listener failure and log without data", async () => {
        const log = fakeLogger();
        const listener = { onConsultationChanged: jest.fn().mockRejectedValue(new Error("SYNTHETIC-SECRET-1")) };
        const service = new ConsultationRowsService({} as Knex, log.logger, listener);
        await expect(service.notifyChanged("completed" as never, consultation)).resolves.toBeUndefined();
        expect(log.messages("error")).toEqual(["consultation_change_listener_failed"]);
        expect(log.text()).not.toContain("SYNTHETIC-SECRET-1");
    });
});
