import { inject, injectable } from "tsyringe";
import { createSingleFlight } from "../../../lib/async/single-flight";
import { yieldToEventLoop } from "../../../lib/async/yield-to-event-loop";
import { TOKENS } from "../../../lib/di/tokens";
import { computeSlots } from "../../../pkg/slots/compute";
import { baseBucketOf, FREE_MAP_BUCKETS, FREE_MAP_BUCKET_MS, toFreeMap } from "../../../pkg/slots/free-map";
import type { IndexDoctor } from "../../doctors/types";
import { NONE_SCORE } from "../constants";
import type { ComputedEntry, ComputeResult, DoctorOutcome, RefreshResult, SlotWindow } from "../types";
import { NextAvailableIndex } from "./next-available.index";
import { SlotInputsLoader } from "./slot-inputs.loader";

const YIELD_EVERY = 10;

/**
 * Computes the rank-index entry (earliest free start of the shortest active type, plus the free-map) of a batch of doctors and writes it
 * back version-guarded. Shared by the API's inline path, `availability-refresh` and `availability-sweep` (availability spec 12.2.4):
 * loader batch -> `computeSlots` -> guarded write.
 */
@injectable()
export class NextAvailableComputer {
    private readonly flight = createSingleFlight<number, DoctorOutcome>();

    constructor(
        @inject(TOKENS.SlotInputsLoader) private readonly loader: SlotInputsLoader,
        @inject(TOKENS.NextAvailableIndex) private readonly index: NextAvailableIndex,
    ) {}

    /**
     * The window an index entry covers: `[now + 1 ms, (baseBucket + 1344) * 15 min)`, about 14 days (AV-R19). Concurrent calls for one doctor
     * share one computation within this process; a batch registers one promise per doctor and recomputes only those not already in flight.
     */
    async compute(doctors: readonly IndexDoctor[], nowMs: number): Promise<ComputeResult> {
        const own: IndexDoctor[] = [];
        let release!: () => void;
        const ready = new Promise<void>((resolve) => { release = resolve; });
        let batch: Promise<Map<number, DoctorOutcome>> = Promise.resolve(new Map<number, DoctorOutcome>());
        const pending = doctors.map((doctor) => this.flight.run(doctor.userId, async () => {
            own.push(doctor);
            await ready;
            return (await batch).get(doctor.userId) ?? null;
        }));
        batch = own.length === 0 ? Promise.resolve(new Map<number, DoctorOutcome>()) : this.computeBatch(own, nowMs);
        release();
        const outcomes = await Promise.all(pending);
        const entries: ComputedEntry[] = [];
        const removed: number[] = [];
        outcomes.forEach((outcome, position) => {
            const doctor = doctors[position];
            if (outcome !== null) entries.push(outcome);
            else if (doctor !== undefined) removed.push(doctor.userId);
        });
        return { entries, removed };
    }

    /**
     * Writes the entries version-guarded. Entries whose version snapshot is unknown (Redis was unreachable) and entries whose command failed
     * are `failed`; a guard rejection is neither stored nor failed (the invalidation that won already queued the doctor for refresh).
     */
    async write(entries: readonly ComputedEntry[]): Promise<{ stored: number; failed: number[] }> {
        const writable = entries.filter((entry) => entry.ver !== null);
        const failed = entries.filter((entry) => entry.ver === null).map((entry) => entry.userId);
        const verdicts = await this.index.writeEntries(writable);
        if (verdicts === undefined) return { stored: 0, failed: [...failed, ...writable.map((entry) => entry.userId)] };
        let stored = 0;
        verdicts.forEach((verdict, position) => {
            const entry = writable[position];
            if (verdict === "stored") stored += 1;
            else if (verdict === "failed" && entry !== undefined) failed.push(entry.userId);
        });
        return { stored, failed };
    }

    /** Compute, write, and drop doctors that lost their only active type from the index. */
    async refresh(doctors: readonly IndexDoctor[], nowMs: number): Promise<RefreshResult> {
        const computed = await this.compute(doctors, nowMs);
        const written = await this.write(computed.entries);
        if (computed.removed.length > 0) await this.index.remove(computed.removed);
        return { entries: computed.entries, removed: computed.removed, stored: written.stored, failed: written.failed };
    }

    private async computeBatch(doctors: readonly IndexDoctor[], nowMs: number): Promise<Map<number, DoctorOutcome>> {
        const baseBucket = baseBucketOf(nowMs);
        const window: SlotWindow = { fromMs: nowMs + 1, toMs: (baseBucket + FREE_MAP_BUCKETS) * FREE_MAP_BUCKET_MS };
        const versions = await this.index.versions(doctors.map((doctor) => doctor.userId));
        const inputs = await this.loader.loadShortestType(doctors, window);
        const outcomes = new Map<number, DoctorOutcome>();
        let processed = 0;
        for (const doctor of doctors) {
            const input = inputs.get(doctor.userId);
            if (input === undefined) { outcomes.set(doctor.userId, null); continue; }
            const starts = computeSlots({ timezone: input.timezone, weekly: input.weekly, exceptions: input.exceptions, busy: input.busy,
                durationMinutes: input.durationMinutes, bounds: window }).map((slot) => slot.startMs);
            outcomes.set(doctor.userId, { userId: doctor.userId, score: starts[0] ?? NONE_SCORE, map: toFreeMap(starts, baseBucket), ver: versions?.get(doctor.userId) ?? null });
            processed += 1;
            if (processed % YIELD_EVERY === 0) await yieldToEventLoop();
        }
        return outcomes;
    }
}
