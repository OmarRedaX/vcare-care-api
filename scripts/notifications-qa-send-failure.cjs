"use strict";
// Test-only driver for scripts/curl-test-notifications.sh (NOT part of src/, never shipped): runs the REAL compiled
// OutboxDeliveryService (dist/) against the disposable database and the fake Identity, but with a scripted EmailPort and a fake
// clock, so the paths the log-only adapter can never produce (transient failure, thrown error, timeout, permanent rejection)
// and the template output can be observed end to end. Needs `npm run build`, the worker env (DATABASE_URL, IDENTITY_*, SERVICE_*)
// and the fake Identity. Refuses a database whose name does not end in _test or contain _qa.
//
//   node scripts/notifications-qa-send-failure.cjs walk <transient|throw|timeout|permanent> <outboxId>
//        one JSON line per attempt: {n, attempts, status, lastErrorCode, delaySeconds}; the clock jumps to each row's next_attempt_at
//   node scripts/notifications-qa-send-failure.cjs render
//        one tick over every due pending row with a capturing port; prints per message ONLY booleans/ids (never address, name or text)
require("reflect-metadata");
const path = require("node:path");
const dist = (p) => require(path.join(__dirname, "..", "dist", p));

const qa = (o) => console.log("QA " + JSON.stringify(o));
const mode = process.argv[2] === "walk" ? process.argv[3] : process.argv[2];
const arg = process.argv[2] === "walk" ? process.argv[4] : process.argv[3];
const url = process.env.DATABASE_URL ?? "";
if (!/\/[^/?]*(_test|_qa[a-z_]*)($|\?)/.test(url)) { console.error("Refusing non-disposable database"); process.exit(2); }

const keepAlive = [];
async function main() {
  const { getEnv } = dist("lib/config/env.js");
  const { createKnex } = dist("lib/knex/knex.js");
  const { logger } = dist("lib/logger/logger.js");
  const { IdentityClient } = dist("lib/identity-client/identity-client.js");
  const { OutboxDeliveryService } = dist("app/notifications/service/outbox-delivery.service.js");
  const { ConsultationReminderService } = dist("app/consultations/service/consultation-reminder.service.js");
  const env = getEnv();
  const db = createKnex({ url: env.DATABASE_URL, poolMax: 4, statementTimeoutMs: 5000, applicationName: "care-worker-qa" });
  const identity = new IdentityClient({ env });
  let clock = Date.now();
  const timing = { now: () => clock, random: () => 0.5 }; // 0.5 => jitter factor exactly 1.0
  const captured = [];
  const port = {
    send: async (message) => {
      if (mode === "render") { captured.push(message); return { outcome: "sent" }; }
      if (mode === "throw") throw new Error("QA-SECRET-PROVIDER-MESSAGE-5521");
      if (mode === "permanent") return { outcome: "permanent", errorCode: "provider_rejected" };
      // A provider that never answers (ignores the abort signal): the service's own bound must cut it. The ref'd interval keeps this driver alive meanwhile.
      if (mode === "timeout") return new Promise(() => { keepAlive.push(setInterval(() => {}, 1000)); });
      return { outcome: "transient", errorCode: "provider_busy_QA" };
    },
  };
  const svc = new OutboxDeliveryService(db, identity, port, new ConsultationReminderService(), env, logger, timing);
  try {
    if (mode === "render") {
      const rows = await db("notification_outbox").where({ status: "pending" }).select("id", "kind", "recipient_user_id", "consultation_id");
      await svc.tick(new AbortController().signal);
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const m of captured) {
        const row = byId.get(m.meta.outboxId);
        const ctx = await db("consultations as c").leftJoin("doctor_profiles as d", "d.user_id", "c.doctor_user_id")
          .where("c.id", row.consultation_id).first("c.patient_user_id", "c.doctor_user_id", "c.patient_timezone", "d.timezone as doctor_timezone");
        const isPatient = row.recipient_user_id === Number(ctx.patient_user_id);
        const tz = isPatient ? ctx.patient_timezone : ctx.doctor_timezone;
        qa(({
          outboxId: m.meta.outboxId, kind: m.meta.kind, role: isPatient ? "patient" : "doctor",
          toIsRecipientFixture: m.to === `qa-fixture-${row.recipient_user_id}@example.invalid`,
          greetsByName: m.text.startsWith(`Hello QA Fixture Person ${row.recipient_user_id},`),
          nameInSubject: m.subject.includes("QA Fixture"), addressInBody: m.text.includes("@example.invalid"),
          bodyHasRecipientZone: m.text.includes(`(${tz})`), signed: m.text.endsWith("The Vcare team"),
          noReasonOrComplaint: !/QA-(COMPLAINT|REASON)-MARKER/.test(m.subject + m.text), subjectLen: m.subject.length,
        }));
      }
      qa(({ messages: captured.length }));
      return;
    }
    const id = Number(arg);
    if (!Number.isSafeInteger(id)) throw new Error("outbox id required");
    for (let n = 1; n <= 10; n++) {
      await svc.tick(new AbortController().signal);
      const row = await db("notification_outbox").where({ id }).first("attempts", "status", "last_error_code", "next_attempt_at");
      const delay = row.status === "pending" ? Math.round((new Date(row.next_attempt_at).getTime() - clock) / 1000) : null;
      qa(({ n, attempts: row.attempts, status: row.status, lastErrorCode: row.last_error_code, delaySeconds: delay }));
      if (row.status !== "pending") break;
      clock = new Date(row.next_attempt_at).getTime() + 1000;
    }
  } finally {
    keepAlive.forEach(clearInterval);
    await identity.close();
    await db.destroy();
  }
}
main().catch((error) => { console.error("driver failed:", error?.name ?? "Error", process.env.QA_DEBUG ? error?.stack : ""); process.exit(1); });
