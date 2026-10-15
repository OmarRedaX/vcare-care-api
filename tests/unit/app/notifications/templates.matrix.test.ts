import { OutboxKind, RecipientRole } from "../../../../src/app/notifications/enums";
import { hasTemplate, render } from "../../../../src/app/notifications/templates/registry";
import type { RenderInput } from "../../../../src/app/notifications/types";

const START = Date.parse("2030-03-31T00:30:00Z");
const PREVIOUS = Date.parse("2030-03-30T09:00:00Z");
const LOCALES = ["en", "en-US", "EN_gb", "ar", "ar-EG", "fr", "???", ""];
const base = (changes: Partial<RenderInput>): RenderInput => ({
    kind: OutboxKind.BookingConfirmed, role: RecipientRole.Patient, locale: "en", recipientName: "Sam Synthetic", timezone: "UTC", startsAtMs: START, ...changes,
});

describe("templates: kind x role x locale", () => {
    const combos = Object.values(OutboxKind).flatMap((kind) => Object.values(RecipientRole).map((role) => [kind, role] as const));

    it.each(combos)("should render %s for the %s identically in every locale, falling back to English", (kind, role) => {
        const reference = render(base({ kind, role, previousStartsAtMs: PREVIOUS, byRole: "admin" }));
        for (const locale of LOCALES) {
            expect(render(base({ kind, role, locale, previousStartsAtMs: PREVIOUS, byRole: "admin" }))).toEqual(reference);
        }
        // hasTemplate agrees with render: a missing template is `undefined`, never an empty message.
        expect(reference === undefined).toBe(!hasTemplate(kind, role));
        if (reference !== undefined) {
            expect(reference.subject.length).toBeGreaterThan(0);
            expect(reference.text.startsWith("Hello Sam Synthetic,\n\n")).toBe(true);
            expect(reference.text.endsWith("\n\nThe Vcare team")).toBe(true);
        }
    });

    it.each(combos)("should render %s for the %s with the in-progress variant only for doctor_suspended", (kind, role) => {
        const live = render(base({ kind, role, previousStartsAtMs: PREVIOUS, byRole: "admin", inProgress: true }));
        const normal = render(base({ kind, role, previousStartsAtMs: PREVIOUS, byRole: "admin" }));
        if (kind === OutboxKind.DoctorSuspended && role === RecipientRole.Patient) {
            expect(live?.text).not.toEqual(normal?.text);
            expect(live?.text).not.toMatch(/scheduled for|not been cancelled/);
        } else {
            expect(live).toEqual(normal);
        }
    });

    it("should have a template for exactly the documented (kind, role) pairs", () => {
        const present = combos.filter(([kind, role]) => hasTemplate(kind, role)).map(([kind, role]) => `${kind}:${role}`).sort();
        expect(present).toEqual([
            "booking_confirmed:doctor", "booking_confirmed:patient", "cancelled:doctor", "cancelled:patient", "doctor_joined:patient", "doctor_suspended:patient",
            "reminder_1h:doctor", "reminder_1h:patient", "reminder_24h:doctor", "reminder_24h:patient", "rescheduled:doctor", "rescheduled:patient", "schedule_blocked:patient",
        ]);
    });
});

describe("templates: recipient timezone across a DST change", () => {
    // 2030-03-31 00:30Z is 00:30 in London (GMT), the instant before the 01:00Z spring-forward.
    it.each([
        [RecipientRole.Patient, "America/New_York", "Saturday 30 March 2030, 20:30 (America/New_York)"],
        [RecipientRole.Doctor, "Europe/London", "Sunday 31 March 2030, 00:30 (Europe/London)"],
        [RecipientRole.Doctor, "Africa/Cairo", "Sunday 31 March 2030, 02:30 (Africa/Cairo)"],
    ])("should print the start for the %s in %s", (role, timezone, expected) => {
        const mail = render(base({ kind: OutboxKind.Reminder1h, role, timezone }));
        expect(mail?.text).toContain(expected);
    });

    it("should show the previous and the new time on either side of a DST change in the recipient zone", () => {
        const mail = render(base({
            kind: OutboxKind.Rescheduled, timezone: "Europe/London", startsAtMs: Date.parse("2030-03-31T01:30:00Z"), previousStartsAtMs: Date.parse("2030-03-30T23:30:00Z"), byRole: "patient",
        }));
        expect(mail?.text).toContain("Previous time: Saturday 30 March 2030, 23:30 (Europe/London)\nNew time: Sunday 31 March 2030, 02:30 (Europe/London)");
    });

    it("should print the same instant differently for the patient and the doctor when their zones differ", () => {
        const patient = render(base({ role: RecipientRole.Patient, timezone: "America/New_York" }))?.text;
        const doctor = render(base({ role: RecipientRole.Doctor, timezone: "Africa/Cairo" }))?.text;
        expect(patient).toContain("(America/New_York)");
        expect(doctor).toContain("(Africa/Cairo)");
        expect(patient).not.toContain("(Africa/Cairo)");
    });
});

describe("templates: no reason, PII or counterpart in any copy (N-R16)", () => {
    it("should never contain a reason, complaint, counterpart name, email address or URL in any rendered message", () => {
        for (const kind of Object.values(OutboxKind)) {
            for (const role of Object.values(RecipientRole)) {
                for (const byRole of ["patient", "doctor", "admin", undefined] as const) {
                    for (const inProgress of [false, true]) {
                        const mail = render(base({ kind, role, previousStartsAtMs: PREVIOUS, inProgress, ...(byRole === undefined ? {} : { byRole }) }));
                        if (mail === undefined) continue;
                        const body = mail.text.replace("Hello Sam Synthetic,", "");
                        expect(`${mail.subject}
${body}`).not.toMatch(/reason|complaint|diagnos|allerg|suspend|@|https?:|Synthetic/i);
                    }
                }
            }
        }
    });
});
