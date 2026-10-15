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

/** Controls, format characters (bidi overrides and isolates, zero-width, BOM, soft hyphen) and line or paragraph separators. */
const UNSAFE_NAME_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
/** A scheme URL (`scheme://...`) or a `www.` host, up to the next space: a link inside a trusted mail is a phishing vector. */
const URL_LIKE = /[^\s]*:\/\/[^\s]*|www\.[^\s]*/giu;

/** Unsafe characters and URLs removed, whitespace collapsed, trimmed, clamped to 80 code points; used only in the body. */
function greetingName(name: string): string {
    const cleaned = name.replace(UNSAFE_NAME_CHARACTERS, "").replace(URL_LIKE, " ").replace(/\s+/gu, " ").trim();
    return [...cleaned].slice(0, GREETING_NAME_MAX_CODE_POINTS).join("").trim();
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
