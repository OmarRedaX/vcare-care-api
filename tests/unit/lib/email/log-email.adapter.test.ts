import { LogEmailAdapter } from "../../../../src/lib/email/log-email.adapter";
import type { EmailPort } from "../../../../src/lib/email/types";
import { fakeLogger } from "../../../helpers/fake-logger";

describe("LogEmailAdapter", () => {
    it("should log exactly the outbox id, kind and recipient user id and answer sent", async () => {
        const log = fakeLogger();
        const port: EmailPort = new LogEmailAdapter(log.logger);
        const result = await port.send(
            { to: "synthetic.person@example.test", subject: "Synthetic subject line", text: "Synthetic body text", meta: { outboxId: 7, kind: "booking_confirmed", recipientUserId: 42 } },
            new AbortController().signal,
        );
        expect(result).toEqual({ outcome: "sent" });
        expect(log.info).toHaveBeenCalledTimes(1);
        expect(log.info).toHaveBeenCalledWith("email_log_adapter_send", { outboxId: 7, kind: "booking_confirmed", recipientUserId: 42 });
        expect(log.text()).not.toContain("synthetic.person");
        expect(log.text()).not.toContain("Synthetic subject");
        expect(log.text()).not.toContain("Synthetic body");
    });
});
