import http from "node:http";
import type { AddressInfo } from "node:net";
import type * as ConstantsModule from "../../../../src/lib/email/constants";
import type * as AdapterModule from "../../../../src/lib/email/resend-email.adapter";
import type { EmailMessage } from "../../../../src/lib/email/types";
import { fakeLogger } from "../../../helpers/fake-logger";

/**
 * The real budget is 5 s (asserted below against the real constant); this suite loads the adapter in an isolated module
 * registry with a 300 ms budget so the timeout case stays fast. Every other constant is the real one. The "provider" is a
 * local HTTP server: a system-external dependency, so faking it is allowed in a unit test.
 */
let ResendEmailAdapter: typeof AdapterModule.ResendEmailAdapter;
let realConstants: typeof ConstantsModule;
jest.isolateModules(() => {
    realConstants = jest.requireActual<typeof ConstantsModule>("../../../../src/lib/email/constants");
    jest.doMock("../../../../src/lib/email/constants", () => ({ ...realConstants, RESEND_REQUEST_TIMEOUT_MS: 300 }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ResendEmailAdapter = (require("../../../../src/lib/email/resend-email.adapter") as typeof AdapterModule).ResendEmailAdapter;
});

const API_KEY = "synthetic-resend-key-0001";
const ADDRESS = "synthetic.person@example.test";
const SUBJECT = "Synthetic subject line";
const TEXT = "Synthetic body text";
const message: EmailMessage = { to: ADDRESS, subject: SUBJECT, text: TEXT, meta: { outboxId: 7, kind: "booking_confirmed", recipientUserId: 42 } };

interface Seen { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }

describe("ResendEmailAdapter", () => {
    let server: http.Server;
    let baseUrl: string;
    let seen: Seen[];
    let respond: (res: http.ServerResponse) => void;

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => {
                seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
                respond(res);
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    beforeEach(() => {
        seen = [];
        // The provider echoes the message back, as a real one might: the adapter must never read or log this body.
        respond = (res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "synthetic-id", echo: `${ADDRESS} ${SUBJECT} ${TEXT}` })); };
    });

    const adapter = (url = baseUrl) => {
        const log = fakeLogger();
        return { log, port: new ResendEmailAdapter({ apiKey: API_KEY, from: "care@example.test", baseUrl: url }, log.logger) };
    };
    const status = (code: number) => { respond = (res) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify({ message: `${ADDRESS} ${TEXT}` })); }; };

    it("should keep the real request budget at 5 seconds", () => {
        expect(realConstants.RESEND_REQUEST_TIMEOUT_MS).toBe(5000);
    });

    it("should POST one JSON message to /emails with the bearer key and an outbox idempotency key and answer sent", async () => {
        const { port } = adapter();
        await expect(port.send(message, new AbortController().signal)).resolves.toEqual({ outcome: "sent" });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ method: "POST", url: "/emails" });
        expect(seen[0]?.headers).toMatchObject({ authorization: `Bearer ${API_KEY}`, "content-type": "application/json", "idempotency-key": "care-outbox-7" });
        expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ from: "care@example.test", to: [ADDRESS], subject: SUBJECT, text: TEXT });
    });

    it("should use the same idempotency key for a retry of the same outbox row and a new one for another row", async () => {
        const { port } = adapter();
        await port.send(message, new AbortController().signal);
        await port.send(message, new AbortController().signal);
        await port.send({ ...message, meta: { ...message.meta, outboxId: 8 } }, new AbortController().signal);
        expect(seen.map((s) => s.headers["idempotency-key"])).toEqual(["care-outbox-7", "care-outbox-7", "care-outbox-8"]);
    });

    it.each([
        [429, "transient", "email_provider_throttled"],
        [401, "transient", "email_provider_auth"],
        [403, "transient", "email_provider_auth"],
        [409, "transient", "email_provider_unavailable"],
        [500, "transient", "email_provider_unavailable"],
        [503, "transient", "email_provider_unavailable"],
        [400, "permanent", "email_rejected"],
        [404, "permanent", "email_rejected"],
        [422, "permanent", "email_rejected"],
    ])("should map HTTP %i to %s with the fixed code %s", async (code, outcome, errorCode) => {
        status(code);
        const { port, log } = adapter();
        await expect(port.send(message, new AbortController().signal)).resolves.toEqual({ outcome, errorCode });
        expect(log.warn).toHaveBeenCalledWith("email_provider_failed", { outboxId: 7, kind: "booking_confirmed", errorCode, status: code });
    });

    it("should answer a transient email_timeout when the provider does not answer within the budget", async () => {
        respond = () => undefined;
        const { port, log } = adapter();
        await expect(port.send(message, new AbortController().signal)).resolves.toEqual({ outcome: "transient", errorCode: "email_timeout" });
        expect(log.warn).toHaveBeenCalledWith("email_provider_failed", { outboxId: 7, kind: "booking_confirmed", errorCode: "email_timeout" });
    });

    it("should answer a transient network error when nothing listens at the base URL", async () => {
        const { port } = adapter("http://127.0.0.1:1");
        await expect(port.send(message, new AbortController().signal)).resolves.toEqual({ outcome: "transient", errorCode: "email_network_error" });
    });

    it("should answer a transient network error and send nothing more when the caller aborts", async () => {
        respond = () => undefined;
        const controller = new AbortController();
        const { port } = adapter();
        const pending = port.send(message, controller.signal);
        setTimeout(() => controller.abort(), 50);
        await expect(pending).resolves.toEqual({ outcome: "transient", errorCode: "email_network_error" });
    });

    it("should never log the address, subject, text, API key or provider body, on success or failure", async () => {
        const { port, log } = adapter();
        await port.send(message, new AbortController().signal);
        status(500);
        await port.send(message, new AbortController().signal);
        status(422);
        await port.send(message, new AbortController().signal);
        const logged = log.text();
        for (const secret of [ADDRESS, SUBJECT, TEXT, API_KEY, "synthetic-id", "Bearer"]) expect(logged).not.toContain(secret);
    });
});
