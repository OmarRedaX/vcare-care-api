import { OutboxKind, RecipientRole } from "../enums";
import type { LocaleTemplates, RenderedEmail, TemplateParts } from "../types";

const SIGNATURE = "\n\nThe Vcare team";

function mail(subject: string, parts: TemplateParts, body: string): RenderedEmail {
    return { subject, text: `${parts.greeting}\n\n${body}${SIGNATURE}` };
}

/** Subject of the sentence for `rescheduled` / `cancelled`; `undefined` = passive form. */
function actorFor(role: RecipientRole, byRole: TemplateParts["byRole"]): string | undefined {
    if (byRole === "admin") return "Vcare support";
    if (role === RecipientRole.Patient) {
        if (byRole === "patient") return "You";
        if (byRole === "doctor") return "Your doctor";
        return undefined;
    }
    if (byRole === "patient") return "The patient";
    if (byRole === "doctor") return "You";
    return undefined;
}

function rescheduled(role: RecipientRole, parts: TemplateParts): RenderedEmail {
    const actor = actorFor(role, parts.byRole);
    const mine = role === RecipientRole.Patient ? "your consultation" : "a consultation with you";
    const sentence = actor === undefined
        ? (role === RecipientRole.Patient ? "Your consultation was rescheduled." : "A consultation with you was rescheduled.")
        : `${actor} rescheduled ${mine}.`;
    const previous = parts.previous === undefined ? "" : `\nPrevious time: ${parts.previous}`;
    return mail(role === RecipientRole.Patient ? "Your consultation was rescheduled" : "A consultation was rescheduled", parts,
        `${sentence}${previous}\nNew time: ${parts.when}`);
}

function cancelled(role: RecipientRole, parts: TemplateParts): RenderedEmail {
    const actor = actorFor(role, parts.byRole);
    const subject = role === RecipientRole.Patient ? "Your consultation was cancelled" : "A consultation was cancelled";
    const target = role === RecipientRole.Patient ? "your consultation" : "the consultation";
    const body = actor === undefined
        ? `${role === RecipientRole.Patient ? "Your consultation" : "The consultation"} scheduled for ${parts.when} was cancelled.`
        : `${actor} cancelled ${target} scheduled for ${parts.when}.`;
    return mail(subject, parts, body);
}

export const EN_TEMPLATES: LocaleTemplates = {
    [OutboxKind.BookingConfirmed]: {
        [RecipientRole.Patient]: (parts) => mail("Your consultation is booked", parts,
            `Your consultation is booked for ${parts.when}. You can review it in your Vcare account.`),
        [RecipientRole.Doctor]: (parts) => mail("New consultation booked", parts,
            `A patient has booked a consultation with you for ${parts.when}. Open your Vcare schedule to see the details.`),
    },
    [OutboxKind.Reminder24h]: {
        [RecipientRole.Patient]: (parts) => mail("Reminder: your consultation is within 24 hours", parts, `Your consultation starts on ${parts.when}.`),
        [RecipientRole.Doctor]: (parts) => mail("Reminder: a consultation is within 24 hours", parts, `You have a consultation starting on ${parts.when}.`),
    },
    [OutboxKind.Reminder1h]: {
        [RecipientRole.Patient]: (parts) => mail("Reminder: your consultation starts within 1 hour", parts,
            `Your consultation starts at ${parts.when}. Please be ready a few minutes before the start.`),
        [RecipientRole.Doctor]: (parts) => mail("Reminder: a consultation starts within 1 hour", parts,
            `You have a consultation starting at ${parts.when}. Please be ready a few minutes before the start.`),
    },
    [OutboxKind.Rescheduled]: {
        [RecipientRole.Patient]: (parts) => rescheduled(RecipientRole.Patient, parts),
        [RecipientRole.Doctor]: (parts) => rescheduled(RecipientRole.Doctor, parts),
    },
    [OutboxKind.Cancelled]: {
        [RecipientRole.Patient]: (parts) => cancelled(RecipientRole.Patient, parts),
        [RecipientRole.Doctor]: (parts) => cancelled(RecipientRole.Doctor, parts),
    },
    [OutboxKind.ScheduleBlocked]: {
        [RecipientRole.Patient]: (parts) => mail("Your consultation needs follow-up", parts,
            `Your doctor's schedule has changed and your consultation on ${parts.when} may be affected. It has not been cancelled. Vcare support will contact you to confirm the next steps.`),
    },
    [OutboxKind.DoctorSuspended]: {
        [RecipientRole.Patient]: (parts) => mail("We need to follow up on your consultation", parts,
            `Your consultation scheduled for ${parts.when} needs follow-up. It has not been cancelled. A Vcare administrator will be in touch with you about the next steps.`),
    },
    [OutboxKind.DoctorJoined]: {
        [RecipientRole.Patient]: (parts) => mail("Your doctor has joined", parts,
            `Your doctor has joined the consultation scheduled for ${parts.when}. Open your Vcare account to join.`),
    },
};
