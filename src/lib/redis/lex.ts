/** The highest code point: its UTF-8 encoding (`F4 8F BF BF`) sorts above every other valid string continuation. */
const HIGHEST_CODE_POINT = "\u{10FFFF}";

/**
 * The `[min, max]` bounds for `ZRANGEBYLEX` that select every member of a lexicographic sorted set (all scores equal) that starts with `prefix`.
 * Both bounds are inclusive (`[`); Redis compares bytes, and a member continuing the prefix with any character sorts below `prefix + U+10FFFF`.
 */
export function prefixRange(prefix: string): [string, string] {
    return [`[${prefix}`, `[${prefix}${HIGHEST_CODE_POINT}`];
}
