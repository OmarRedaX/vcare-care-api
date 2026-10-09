import "reflect-metadata";
import type { Knex } from "knex";
import { AuditLog } from "../../../../src/app/audit/entity/audit-log.entity";
import type * as RepoModule from "../../../../src/app/audit/repository/audit.repo";
import { AuditService } from "../../../../src/app/audit/service/audit.service";
import type { AuditCursorPayload } from "../../../../src/app/audit/types";
import type { Env } from "../../../../src/lib/config/types";
import { encodeSignedCursor } from "../../../../src/lib/http/pagination/signed-cursor";

// The repository is this unit's collaborator: its exported function is replaced on the real module object, which the
// service reads at call time.
const repo = jest.requireActual<typeof RepoModule>("../../../../src/app/audit/repository/audit.repo");
const listMock = jest.spyOn(repo, "listAuditLogs");

const SECRET = "unit-test-secret";
const NOW = Date.parse("2026-04-15T12:00:00.000Z");
const FROZEN_TO = "2026-04-15T12:00:00.000Z";

const entry = (id: number, createdAt = "2026-04-15T11:00:00.123Z"): AuditLog =>
    new AuditLog({ id, actorUserId: 303, actorRole: "admin", action: "doctor.approved", entityType: "doctor_profile", entityId: 21, requestId: null, metadata: {}, createdAt: new Date(createdAt) });
const row = (id: number, cursorTimestamp = "2026-04-15T11:00:00.123456Z"): { entry: AuditLog; cursorTimestamp: string } => ({ entry: entry(id), cursorTimestamp });

function setup() {
    const transaction = jest.fn();
    const db = { transaction } as unknown as Knex;
    const now = jest.fn(() => NOW);
    const service = new AuditService(db, { SERVICE_CLIENT_SECRET: SECRET } as Env, { now });
    return { service, db, transaction, now };
}

const cursor = (payload: unknown, secret = SECRET): string => encodeSignedCursor(payload as object, secret);
const goodPayload: AuditCursorPayload = { t: "2026-04-10T10:00:00.123456Z", id: 77, to: FROZEN_TO };
const decode = (value: string | null): AuditCursorPayload => JSON.parse(Buffer.from((value ?? "").split(".")[0] ?? "", "base64url").toString("utf8")) as AuditCursorPayload;
const failure = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);
const CURSOR_INVALID = { code: "ValidationFailed", status: 400, details: [{ field: "cursor", issue: "is invalid" }] };

describe("AuditService.list", () => {
    beforeEach(() => {
        listMock.mockReset();
        listMock.mockResolvedValue([]);
    });

    it("should call the repository once with limit + 1 and the default window on the first page", async () => {
        const { service, now } = setup();
        await service.list({});
        expect(listMock).toHaveBeenCalledTimes(1);
        const [params] = listMock.mock.calls[0] ?? [];
        expect(params).toMatchObject({ fetchLimit: 21 });
        expect(params?.from.toISOString()).toBe("2026-03-16T12:00:00.000Z");
        expect(params?.to.toISOString()).toBe(FROZEN_TO);
        expect(params?.after).toBeUndefined();
        expect(now).toHaveBeenCalledTimes(1);
    });

    it("should request limit + 1 rows for an explicit limit", async () => {
        const { service } = setup();
        await service.list({ limit: 5 });
        expect(listMock.mock.calls[0]?.[0].fetchLimit).toBe(6);
    });

    it("should pass the filters through untouched", async () => {
        const { service } = setup();
        await service.list({ actorUserId: 303, action: "doctor.approved", entityType: "doctor_profile", entityId: 21, from: "2026-04-01T00:00:00Z", to: "2026-04-10T00:00:00+02:00" });
        const [params] = listMock.mock.calls[0] ?? [];
        expect(params).toMatchObject({ actorUserId: 303, action: "doctor.approved", entityType: "doctor_profile", entityId: 21 });
        expect(params?.from.toISOString()).toBe("2026-04-01T00:00:00.000Z");
        expect(params?.to.toISOString()).toBe("2026-04-09T22:00:00.000Z");
    });

    it("should not read the clock when the cursor and an explicit to are both present", async () => {
        const { service, now } = setup();
        await service.list({ cursor: cursor(goodPayload), to: "2026-04-12T00:00:00Z" });
        expect(now).not.toHaveBeenCalled();
        expect(listMock.mock.calls[0]?.[0].to.toISOString()).toBe("2026-04-12T00:00:00.000Z");
    });

    it("should not read the clock when only the cursor carries the window", async () => {
        const { service, now } = setup();
        await service.list({ cursor: cursor(goodPayload) });
        expect(now).not.toHaveBeenCalled();
        expect(listMock.mock.calls[0]?.[0].to.toISOString()).toBe(FROZEN_TO);
    });

    it("should hand the cursor position to the repository as after", async () => {
        const { service } = setup();
        await service.list({ cursor: cursor(goodPayload) });
        expect(listMock.mock.calls[0]?.[0].after).toEqual({ t: goodPayload.t, id: 77 });
    });

    it("should return all rows with no cursor when the page is not full", async () => {
        const { service } = setup();
        listMock.mockResolvedValue([row(3), row(2)]);
        const page = await service.list({ limit: 2 });
        expect(page.items.map((item) => item.id)).toEqual([3, 2]);
        expect(page.meta).toEqual({ nextCursor: null, hasMore: false, count: 2 });
    });

    it("should set nextCursor from the last returned row only when hasMore", async () => {
        const { service } = setup();
        listMock.mockResolvedValue([row(3, "2026-04-15T11:00:03.000003Z"), row(2, "2026-04-15T11:00:02.000002Z"), row(1, "2026-04-15T11:00:01.000001Z")]);
        const page = await service.list({ limit: 2 });
        expect(page.items.map((item) => item.id)).toEqual([3, 2]);
        expect(page.meta).toMatchObject({ hasMore: true, count: 2 });
        expect(decode(page.meta.nextCursor)).toEqual({ t: "2026-04-15T11:00:02.000002Z", id: 2, to: FROZEN_TO });
    });

    it("should freeze the effective to into the cursor when the request had none", async () => {
        const { service } = setup();
        listMock.mockResolvedValue([row(2), row(1)]);
        const page = await service.list({ limit: 1 });
        expect(decode(page.meta.nextCursor).to).toBe(FROZEN_TO);
    });

    it("should freeze an explicit to (normalised to UTC milliseconds) into the cursor", async () => {
        const { service } = setup();
        listMock.mockResolvedValue([row(2), row(1)]);
        const page = await service.list({ limit: 1, to: "2026-04-15T14:00:00.9999+02:00" });
        expect(decode(page.meta.nextCursor).to).toBe("2026-04-15T12:00:00.999Z");
    });

    it("should carry the cursor's frozen to into the next cursor on later pages", async () => {
        const { service, now } = setup();
        listMock.mockResolvedValue([row(2), row(1)]);
        const page = await service.list({ limit: 1, cursor: cursor({ ...goodPayload, to: "2026-03-01T00:00:00.000Z" }) });
        expect(decode(page.meta.nextCursor).to).toBe("2026-03-01T00:00:00.000Z");
        expect(now).not.toHaveBeenCalled();
    });

    it("should sign the next cursor so a following request accepts it", async () => {
        const { service } = setup();
        listMock.mockResolvedValue([row(2), row(1)]);
        const first = await service.list({ limit: 1 });
        listMock.mockResolvedValue([]);
        await expect(service.list({ limit: 1, cursor: first.meta.nextCursor ?? "" })).resolves.toMatchObject({ meta: { hasMore: false } });
    });

    it("should not call the repository when from equals to and answer an empty page", async () => {
        const { service } = setup();
        const page = await service.list({ from: "2026-04-01T00:00:00Z", to: "2026-04-01T02:00:00+02:00" });
        expect(page).toEqual({ items: [], meta: { nextCursor: null, hasMore: false, count: 0 } });
        expect(listMock).not.toHaveBeenCalled();
    });

    it("should answer 400 on the field from and not call the repository when from is later than to", async () => {
        const { service } = setup();
        expect(await failure(service.list({ from: "2026-04-02T00:00:00Z", to: "2026-04-01T00:00:00Z" }))).toMatchObject({
            code: "ValidationFailed", status: 400, details: [{ field: "from", issue: "must not be later than to" }],
        });
        expect(listMock).not.toHaveBeenCalled();
    });

    it("should answer 400 on the field entityType when entityId has no entityType", async () => {
        const { service } = setup();
        expect(await failure(service.list({ entityId: 5 }))).toMatchObject({
            code: "ValidationFailed", status: 400, details: [{ field: "entityType", issue: "is required when entityId is given" }],
        });
        expect(listMock).not.toHaveBeenCalled();
    });

    it("should accept entityType alone and entityType with entityId", async () => {
        const { service } = setup();
        await service.list({ entityType: "consultation" });
        await service.list({ entityType: "consultation", entityId: 5 });
        expect(listMock).toHaveBeenCalledTimes(2);
    });

    it("should neither open a transaction nor touch anything but the repository (no audit row for a read)", async () => {
        const { service, transaction } = setup();
        listMock.mockResolvedValue([row(1)]);
        await service.list({});
        expect(transaction).not.toHaveBeenCalled();
        expect(listMock).toHaveBeenCalledTimes(1);
    });

    it("should rethrow a repository failure untouched", async () => {
        const { service } = setup();
        const boom = new Error("synthetic_db_down");
        listMock.mockRejectedValue(boom);
        await expect(service.list({})).rejects.toBe(boom);
    });

    describe("cursor", () => {
        const good = cursor(goodPayload);
        const flip = (value: string, index: number): string => `${value.slice(0, index)}${value[index] === "A" ? "B" : "A"}${value.slice(index + 1)}`;
        const macStart = good.indexOf(".") + 1;

        it("should round-trip { t, id, to } through a returned cursor", async () => {
            const { service } = setup();
            listMock.mockResolvedValue([{ entry: entry(77), cursorTimestamp: goodPayload.t }, row(1)]);
            const page = await service.list({ limit: 1 });
            expect(decode(page.meta.nextCursor)).toEqual({ ...goodPayload, to: FROZEN_TO });
        });

        it.each<[string, () => string]>([
            ["not base64 and no MAC", () => "not-a-cursor"],
            ["an empty MAC", () => `${good.split(".")[0] ?? ""}.`],
            ["an empty body", () => `.${good.split(".")[1] ?? ""}`],
            ["a body only (valid base64 JSON without a MAC)", () => good.split(".")[0] ?? ""],
            ["a flipped MAC byte", () => flip(good, macStart + 3)],
            ["a flipped payload byte", () => flip(good, 5)],
            ["an edited payload under the old MAC", () => `${Buffer.from(JSON.stringify({ ...goodPayload, id: 1 })).toString("base64url")}.${good.split(".")[1] ?? ""}`],
            ["a verification-queue cursor (validly signed, other payload shape)", () => cursor({ s: "submitted", t: "2026-04-10T10:00:00.123Z", id: 4 })],
            ["a cursor signed with a rotated secret", () => cursor(goodPayload, "another-secret")],
            ["t with three fraction digits", () => cursor({ ...goodPayload, t: "2026-04-10T10:00:00.123Z" })],
            ["t without the Z", () => cursor({ ...goodPayload, t: "2026-04-10T10:00:00.123456" })],
            ["t that is not a string", () => cursor({ ...goodPayload, t: 1776254400000 })],
            ["id 0", () => cursor({ ...goodPayload, id: 0 })],
            ["a negative id", () => cursor({ ...goodPayload, id: -3 })],
            ["a float id", () => cursor({ ...goodPayload, id: 1.5 })],
            ["a string id", () => cursor({ ...goodPayload, id: "77" })],
            ["an unsafe integer id", () => cursor({ ...goodPayload, id: 2 ** 53 })],
            ["a missing to", () => cursor({ t: goodPayload.t, id: 77 })],
            ["a missing id", () => cursor({ t: goodPayload.t, to: FROZEN_TO })],
            ["a missing t", () => cursor({ id: 77, to: FROZEN_TO })],
            ["a to without milliseconds", () => cursor({ ...goodPayload, to: "2026-04-15T12:00:00Z" })],
            ["a to that is not a valid instant", () => cursor({ ...goodPayload, to: "2026-13-45T00:00:00.000Z" })],
            ["a to before 1970", () => cursor({ ...goodPayload, to: "1969-12-31T23:59:59.999Z" })],
            ["a null payload", () => cursor(null)],
            ["an array payload", () => cursor([goodPayload])],
        ])("should answer 400 on the field cursor and not call the repository for %s", async (_label, build) => {
            const { service } = setup();
            expect(await failure(service.list({ cursor: build() }))).toMatchObject(CURSOR_INVALID);
            expect(listMock).not.toHaveBeenCalled();
        });

    });
});
