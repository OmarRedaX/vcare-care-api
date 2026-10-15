import { OutboxKind, RecipientRole } from "../../../../src/app/notifications/enums";
import { formatLocal } from "../../../../src/app/notifications/templates/format-time";
import { hasTemplate, render, resolveLocale } from "../../../../src/app/notifications/templates/registry";
import type { RenderInput } from "../../../../src/app/notifications/types";

const START = Date.parse("2030-10-14T12:30:00Z");
const PREVIOUS = Date.parse("2030-10-13T09:00:00Z");
const base = (changes: Partial<RenderInput>): RenderInput => ({
    kind: OutboxKind.BookingConfirmed, role: RecipientRole.Patient, locale: "en", recipientName: "Sam Synthetic", timezone: "UTC", startsAtMs: START, ...changes,
});

describe("formatLocal", () => {
    it("should format the instant in the zone with the IANA id", () => {
        expect(formatLocal(START, "Africa/Cairo")).toBe("Monday 14 October 2030, 15:30 (Africa/Cairo)");
        expect(formatLocal(START, "UTC")).toBe("Monday 14 October 2030, 12:30 (UTC)");
    });

    it("should fall back to UTC when the zone is invalid", () => {
        expect(formatLocal(START, "Not/AZone")).toBe("Monday 14 October 2030, 12:30 (UTC)");
    });

    it.each([
        ["Europe/London", "2030-03-31T00:30:00Z", "Sunday 31 March 2030, 00:30 (Europe/London)"],
        ["Europe/London", "2030-03-31T01:30:00Z", "Sunday 31 March 2030, 02:30 (Europe/London)"],
        ["America/New_York", "2030-03-10T06:59:00Z", "Sunday 10 March 2030, 01:59 (America/New_York)"],
        ["America/New_York", "2030-03-10T07:00:00Z", "Sunday 10 March 2030, 03:00 (America/New_York)"],
        ["America/New_York", "2030-11-03T05:30:00Z", "Sunday 3 November 2030, 01:30 (America/New_York)"],
        ["America/New_York", "2030-11-03T06:30:00Z", "Sunday 3 November 2030, 01:30 (America/New_York)"],
        ["Africa/Cairo", "2030-04-25T21:59:00Z", "Thursday 25 April 2030, 23:59 (Africa/Cairo)"],
        ["Africa/Cairo", "2030-04-25T22:00:00Z", "Friday 26 April 2030, 01:00 (Africa/Cairo)"],
        ["Africa/Cairo", "2030-10-31T20:59:00Z", "Thursday 31 October 2030, 23:59 (Africa/Cairo)"],
        ["Africa/Cairo", "2030-10-31T21:00:00Z", "Thursday 31 October 2030, 23:00 (Africa/Cairo)"],
    ])("should be DST correct in %s at %s", (zone, iso, expected) => {
        expect(formatLocal(Date.parse(iso), zone)).toBe(expected);
    });
});

describe("resolveLocale", () => {
    it.each(["en", "en-US", "EN_gb", " en ", "ar", "ar-EG", "", "???", "toString", "__proto__"])("should resolve %j to en", (tag) => {
        expect(resolveLocale(tag)).toBe("en");
    });
});

describe("render", () => {
    it("should render every (kind, role) copy of the table", () => {
        const when = "Monday 14 October 2030, 12:30 (UTC)";
        const cases: Array<[OutboxKind, RecipientRole, string, string]> = [
            [OutboxKind.BookingConfirmed, RecipientRole.Patient, "Your consultation is booked", `Your consultation is booked for ${when}. You can review it in your Vcare account.`],
            [OutboxKind.BookingConfirmed, RecipientRole.Doctor, "New consultation booked", `A patient has booked a consultation with you for ${when}. Open your Vcare schedule to see the details.`],
            [OutboxKind.Reminder24h, RecipientRole.Patient, "Reminder: your consultation is within 24 hours", `Your consultation starts on ${when}.`],
            [OutboxKind.Reminder24h, RecipientRole.Doctor, "Reminder: a consultation is within 24 hours", `You have a consultation starting on ${when}.`],
            [OutboxKind.Reminder1h, RecipientRole.Patient, "Reminder: your consultation starts within 1 hour", `Your consultation starts at ${when}. Please be ready a few minutes before the start.`],
            [OutboxKind.Reminder1h, RecipientRole.Doctor, "Reminder: a consultation starts within 1 hour", `You have a consultation starting at ${when}. Please be ready a few minutes before the start.`],
            [OutboxKind.ScheduleBlocked, RecipientRole.Patient, "Your consultation needs follow-up", `Your doctor's schedule has changed and your consultation on ${when} may be affected. It has not been cancelled. Vcare support will contact you to confirm the next steps.`],
            [OutboxKind.DoctorSuspended, RecipientRole.Patient, "We need to follow up on your consultation", `Your consultation scheduled for ${when} needs follow-up. It has not been cancelled. A Vcare administrator will be in touch with you about the next steps.`],
            [OutboxKind.DoctorJoined, RecipientRole.Patient, "Your doctor has joined", `Your doctor has joined the consultation scheduled for ${when}. Open your Vcare account to join.`],
        ];
        for (const [kind, role, subject, body] of cases) {
            expect(render(base({ kind, role }))).toEqual({ subject, text: `Hello Sam Synthetic,\n\n${body}\n\nThe Vcare team` });
        }
    });

    it("should render nothing for the doctor role of patient-only kinds", () => {
        for (const kind of [OutboxKind.ScheduleBlocked, OutboxKind.DoctorSuspended, OutboxKind.DoctorJoined]) {
            expect(render(base({ kind, role: RecipientRole.Doctor }))).toBeUndefined();
            expect(hasTemplate(kind, RecipientRole.Doctor)).toBe(false);
            expect(hasTemplate(kind, RecipientRole.Patient)).toBe(true);
        }
    });

    it.each([
        [RecipientRole.Patient, "patient", "You rescheduled your consultation."],
        [RecipientRole.Patient, "doctor", "Your doctor rescheduled your consultation."],
        [RecipientRole.Patient, "admin", "Vcare support rescheduled your consultation."],
        [RecipientRole.Patient, undefined, "Your consultation was rescheduled."],
        [RecipientRole.Doctor, "patient", "The patient rescheduled a consultation with you."],
        [RecipientRole.Doctor, "doctor", "You rescheduled a consultation with you."],
        [RecipientRole.Doctor, "admin", "Vcare support rescheduled a consultation with you."],
        [RecipientRole.Doctor, undefined, "A consultation with you was rescheduled."],
    ] as const)("should phrase a reschedule for %s by %s", (role, byRole, sentence) => {
        const mail = render(base({ kind: OutboxKind.Rescheduled, role, previousStartsAtMs: PREVIOUS, ...(byRole === undefined ? {} : { byRole }) }));
        expect(mail?.text).toContain(`\n\n${sentence}\nPrevious time: Sunday 13 October 2030, 09:00 (UTC)\nNew time: Monday 14 October 2030, 12:30 (UTC)\n\n`);
    });

    it("should omit the previous time line when the payload has none", () => {
        const mail = render(base({ kind: OutboxKind.Rescheduled, byRole: "admin" }));
        expect(mail?.text).not.toContain("Previous time");
        expect(mail?.text).toContain("Vcare support rescheduled your consultation.\nNew time: ");
    });

    it.each([
        [RecipientRole.Patient, "patient", "You cancelled your consultation scheduled for"],
        [RecipientRole.Patient, "doctor", "Your doctor cancelled your consultation scheduled for"],
        [RecipientRole.Patient, "admin", "Vcare support cancelled your consultation scheduled for"],
        [RecipientRole.Doctor, "patient", "The patient cancelled the consultation scheduled for"],
        [RecipientRole.Doctor, "doctor", "You cancelled the consultation scheduled for"],
        [RecipientRole.Doctor, "admin", "Vcare support cancelled the consultation scheduled for"],
    ] as const)("should phrase a cancel for %s by %s", (role, byRole, start) => {
        expect(render(base({ kind: OutboxKind.Cancelled, role, byRole }))?.text).toContain(`\n\n${start} Monday 14 October 2030, 12:30 (UTC).`);
    });

    it("should use the passive form of a cancel when the actor is unknown", () => {
        expect(render(base({ kind: OutboxKind.Cancelled, role: RecipientRole.Doctor }))?.text).toContain("The consultation scheduled for Monday 14 October 2030, 12:30 (UTC) was cancelled.");
    });

    it("should render the time in the recipient timezone", () => {
        expect(render(base({ timezone: "Africa/Cairo" }))?.text).toContain("Monday 14 October 2030, 15:30 (Africa/Cairo)");
    });

    it("should sanitise the greeting name and keep it out of the subject", () => {
        const mail = render(base({ recipientName: `  Sam\r\nBcc: x\u0007${"a".repeat(200)}  ` }));
        const greeting = mail?.text.split("\n")[0] ?? "";
        expect(greeting.startsWith("Hello SamBcc: x")).toBe(true);
        expect([...greeting.slice("Hello ".length, -1)].length).toBeLessThanOrEqual(80);
        expect(mail?.subject).not.toContain("Sam");
        expect(greeting).not.toContain("\u0007");
    });

    it("should greet without a name when the name is blank", () => {
        expect(render(base({ recipientName: " \n " }))?.text.startsWith("Hello,\n\n")).toBe(true);
    });

    it("should fall back to English for an unsupported locale", () => {
        expect(render(base({ locale: "ar-EG" }))?.subject).toBe("Your consultation is booked");
    });

    it("should never mention a reason or a counterpart name (N-R16)", () => {
        for (const kind of Object.values(OutboxKind)) {
            for (const role of Object.values(RecipientRole)) {
                const mail = render(base({ kind, role, previousStartsAtMs: PREVIOUS, byRole: "admin" }));
                if (mail === undefined) continue;
                expect(`${mail.subject}\n${mail.text}`).not.toMatch(/reason|complaint|because|Dr\./i);
            }
        }
    });
});
