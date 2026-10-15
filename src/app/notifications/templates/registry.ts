import { DEFAULT_LOCALE, GREETING_NAME_MAX_CODE_POINTS } from "../constants";
import type { OutboxKind, RecipientRole } from "../enums";
import type { LocaleTemplates, RenderedEmail, RenderInput, SupportedLocale } from "../types";
import { EN_TEMPLATES } from "./en";
import { formatLocal } from "./format-time";

/** Adding a locale = one file and one entry here. */
const TEMPLATES: Readonly<Record<SupportedLocale, LocaleTemplates>> = { en: EN_TEMPLATES };

/** Primary language subtag, lower-cased (`en-US` -> `en`); an unknown or malformed tag falls back to `en`. */
export function resolveLocale(tag: string): SupportedLocale {
    const primary = tag.trim().split(/[-_]/)[0]?.toLowerCase() ?? "";
    return Object.prototype.hasOwnProperty.call(TEMPLATES, primary) ? (primary as SupportedLocale) : DEFAULT_LOCALE;
}

/** Control characters removed, trimmed, clamped to 80 code points; used only in the body. */
function greetingName(name: string): string {
    const printable = [...name].filter((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code > 0x1f && (code < 0x7f || code > 0x9f);
    });
    return [...printable.join("").trim()].slice(0, GREETING_NAME_MAX_CODE_POINTS).join("").trim();
}

/** Pure. `undefined` = no template for (kind, role): the caller marks the row `template_missing`. */
export function render(input: RenderInput): RenderedEmail | undefined {
    const template = TEMPLATES[resolveLocale(input.locale)][input.kind]?.[input.role];
    if (template === undefined) return undefined;
    const name = greetingName(input.recipientName);
    return template({
        greeting: name === "" ? "Hello," : `Hello ${name},`,
        when: formatLocal(input.startsAtMs, input.timezone),
        previous: input.previousStartsAtMs === undefined ? undefined : formatLocal(input.previousStartsAtMs, input.timezone),
        byRole: input.byRole,
    });
}

/** Whether a template exists for (kind, role); the delivery re-check uses it before any contact lookup. */
export function hasTemplate(kind: OutboxKind, role: RecipientRole): boolean {
    return TEMPLATES[DEFAULT_LOCALE][kind]?.[role] !== undefined;
}
