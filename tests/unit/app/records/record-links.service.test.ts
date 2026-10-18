import "reflect-metadata";
import type { Knex } from "knex";
import * as recordsRepo from "../../../../src/app/records/repository/medical-records.repo";
import { RecordLinksService } from "../../../../src/app/records/service/record-links.service";

const db = { id: "db" } as unknown as Knex;
const trx = { id: "trx" } as unknown as Knex;

afterEach(() => { jest.restoreAllMocks(); });

describe("RecordLinksService.recordedConsultationIds", () => {
    it("should return an empty set without a query for an empty input", async () => {
        const spy = jest.spyOn(recordsRepo, "listConsultationIdsWithRecord");
        expect(await new RecordLinksService(db).recordedConsultationIds([])).toEqual(new Set());
        expect(spy).not.toHaveBeenCalled();
    });

    it("should ask the repository once for the whole list and return the ids that have a live record as a set", async () => {
        const spy = jest.spyOn(recordsRepo, "listConsultationIdsWithRecord").mockResolvedValue([3, 8]);
        const result = await new RecordLinksService(db).recordedConsultationIds([3, 5, 8]);
        expect(result).toEqual(new Set([3, 8]));
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith([3, 5, 8], db);
    });

    it("should use the connection it is given (a transaction) in place of its own pool", async () => {
        const spy = jest.spyOn(recordsRepo, "listConsultationIdsWithRecord").mockResolvedValue([]);
        await new RecordLinksService(db).recordedConsultationIds([1], trx);
        expect(spy).toHaveBeenCalledWith([1], trx);
    });

    it("should let a database error propagate (a hasRecord failure is a plain read failure, no degrade)", async () => {
        jest.spyOn(recordsRepo, "listConsultationIdsWithRecord").mockRejectedValue(new Error("connection reset"));
        await expect(new RecordLinksService(db).recordedConsultationIds([1])).rejects.toThrow("connection reset");
    });
});

describe("RecordLinksService.isFollowUpTarget", () => {
    it("should pass the record, patient and doctor ids to the repository and return its verdict", async () => {
        const spy = jest.spyOn(recordsRepo, "isFollowUpTarget").mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const links = new RecordLinksService(db);
        expect(await links.isFollowUpTarget(9, 101, 202)).toBe(true);
        expect(await links.isFollowUpTarget(9, 102, 202, trx)).toBe(false);
        expect(spy.mock.calls).toEqual([[9, 101, 202, db], [9, 102, 202, trx]]);
    });
});

describe("RecordLinksService.findAccessRow", () => {
    it("should return the access row without clinical text and undefined for an absent record", async () => {
        const spy = jest.spyOn(recordsRepo, "findAccessRow").mockResolvedValueOnce({ id: 9, patientUserId: 101, doctorUserId: 202 }).mockResolvedValueOnce(undefined);
        const links = new RecordLinksService(db);
        expect(await links.findAccessRow(9)).toEqual({ id: 9, patientUserId: 101, doctorUserId: 202 });
        expect(await links.findAccessRow(10, trx)).toBeUndefined();
        expect(spy.mock.calls).toEqual([[9, db], [10, trx]]);
    });
});
