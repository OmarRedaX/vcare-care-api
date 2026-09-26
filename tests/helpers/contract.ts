import fs from "node:fs";
import path from "node:path";

/**
 * Contract conformance (CLAUDE.md → Testing policy): status codes, error codes, and shapes asserted here are
 * READ FROM contracts/openapi.yaml, so drift between the code and the contract fails a test instead of being
 * silently accepted. Only the facts the foundation needs are extracted, with plain string parsing — no YAML or
 * JSON-Schema dependency is added (a new devDependency would need an ADR). Mirrors identity-service's helper.
 */
const CONTRACT = fs.readFileSync(path.resolve(__dirname, "..", "..", "contracts", "openapi.yaml"), "utf8");
const LINES = CONTRACT.split(/\r?\n/);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lines indented deeper than `indent` that follow the line equal to `header`. */
function blockAfter(header: string, indent: number): string {
    const start = LINES.indexOf(header);
    if (start < 0) {
        throw new Error(`"${header.trim()}" is missing from contracts/openapi.yaml`);
    }
    const rest = LINES.slice(start + 1);
    const end = rest.findIndex((line) => line.trim().length > 0 && !line.startsWith(" ".repeat(indent + 1)));
    return rest.slice(0, end < 0 ? rest.length : end).join("\n");
}

/** The body of `components.schemas.<name>` (or any 4-space component key). */
export function schemaBlock(name: string): string {
    const schemasStart = LINES.indexOf("  schemas:");
    const index = LINES.findIndex((line, position) => position > schemasStart && line === `    ${name}:`);
    if (schemasStart < 0 || index < 0) {
        throw new Error(`schema ${name} is missing from contracts/openapi.yaml`);
    }
    return blockAfter(LINES[index] ?? "", 4);
}

/** The body of `components.responses.<name>`. */
export function responseBlock(name: string): string {
    const responsesStart = LINES.indexOf("  responses:");
    const schemasStart = LINES.indexOf("  schemas:");
    const index = LINES.findIndex(
        (line, position) => position > responsesStart && position < schemasStart && line === `    ${name}:`,
    );
    if (index < 0) {
        throw new Error(`response ${name} is missing from contracts/openapi.yaml`);
    }
    return blockAfter(LINES[index] ?? "", 4);
}

/** Every `key: [a, b]` inline list in the block, in file order. */
export function inlineLists(block: string, key: string): string[][] {
    return [...block.matchAll(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`, "g"))].map((match) =>
        (match[1] ?? "")
            .split(",")
            .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
            .filter((entry) => entry.length > 0),
    );
}

function firstInlineList(block: string, key: string): string[] {
    const [list] = inlineLists(block, key);
    if (list === undefined) {
        throw new Error(`inline list ${key} not found`);
    }
    return list;
}

/** `key:` followed by `- value` lines. */
function blockList(block: string, key: string): string[] {
    const lines = block.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim() === `${key}:`);
    if (start < 0) {
        throw new Error(`block list ${key} not found`);
    }
    const values: string[] = [];
    for (const line of lines.slice(start + 1)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("- ")) {
            values.push(trimmed.slice(2).trim());
            continue;
        }
        if (trimmed.length > 0) {
            break;
        }
    }
    return values;
}

/** The `enum: [...]` declared directly under `<property>:` inside the block. */
function propertyEnum(block: string, property: string): string[] {
    const lines = block.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim() === `${property}:`);
    if (start < 0) {
        throw new Error(`property ${property} not found`);
    }
    const indent = (lines[start] ?? "").search(/\S/);
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (line.trim().length > 0 && line.search(/\S/) <= indent) {
            break;
        }
        body.push(line);
    }
    return firstInlineList(body.join("\n"), "enum");
}

export function contractErrorCodes(): string[] {
    return blockList(schemaBlock("ErrorCode"), "enum");
}

/** The response status codes (`'200'`, `'503'`, …) declared for `<method> <path>`. */
export function contractResponseCodes(apiPath: string, method: "get" | "post" | "patch" | "put" | "delete"): string[] {
    const pathBlock = blockAfter(`  ${apiPath}:`, 2);
    const lines = pathBlock.split(/\r?\n/);
    const start = lines.findIndex((line) => line === `    ${method}:`);
    if (start < 0) {
        throw new Error(`${method.toUpperCase()} ${apiPath} is missing from contracts/openapi.yaml`);
    }
    const operation: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (line.trim().length > 0 && !line.startsWith("     ")) {
            break;
        }
        operation.push(line);
    }
    return [...operation.join("\n").matchAll(/^ {8}'(\d{3})':/gm)].map((match) => match[1] ?? "");
}

/** Asserts the one error envelope (CLAUDE.md → API conventions) against `ErrorEnvelope` + `ErrorCode`. */
export function expectErrorEnvelope(body: unknown, expectedCode: string, requestId?: string): void {
    const envelope = body as {
        success: boolean;
        error: { code: string; message: string; details: unknown; requestId: string };
    };

    // ErrorEnvelope declares `required` twice: the envelope first, then the nested error object.
    const [envelopeRequired = [], errorRequired = []] = inlineLists(schemaBlock("ErrorEnvelope"), "required");
    expect(envelopeRequired.length).toBeGreaterThan(0);
    for (const key of envelopeRequired) {
        expect(Object.keys(envelope)).toContain(key);
    }
    expect(envelope.success).toBe(false);
    for (const key of errorRequired) {
        expect(Object.keys(envelope.error)).toContain(key);
    }
    expect(contractErrorCodes()).toContain(envelope.error.code);
    expect(envelope.error.code).toBe(expectedCode);
    expect(typeof envelope.error.message).toBe("string");
    // Spec §1.4 (parity with identity): `details` is always present, an empty array when there are none.
    expect(Array.isArray(envelope.error.details)).toBe(true);
    for (const detail of envelope.error.details as Array<Record<string, unknown>>) {
        expect(Object.keys(detail).sort()).toEqual([...firstInlineList(schemaBlock("ErrorDetail"), "required")].sort());
    }
    expect(envelope.error.requestId).toMatch(UUID);
    if (requestId !== undefined) {
        expect(envelope.error.requestId).toBe(requestId);
    }
}

/** Asserts a liveness body against `HealthLive` (`additionalProperties: false`, `status: const ok`). */
export function expectHealthLiveBody(body: unknown): void {
    const block = schemaBlock("HealthLive");
    expect(block).toContain("additionalProperties: false");
    const constMatch = /const:\s*([A-Za-z]+)/.exec(block);
    expect(constMatch?.[1]).toBeDefined();
    expect(Object.keys(body as object).sort()).toEqual([...firstInlineList(block, "required")].sort());
    expect((body as { status: unknown }).status).toBe(constMatch?.[1]);
}

/** Asserts a readiness body against `HealthStatus`; `down` must coincide with 503 (spec §3.1). */
export function expectHealthStatusBody(body: unknown, httpStatus: number): void {
    const block = schemaBlock("HealthStatus");
    const parsed = body as { status: string; checks: Record<string, string> };
    const [topRequired = [], checksRequired = []] = inlineLists(block, "required");

    expect(block).toContain("additionalProperties: false");
    expect(Object.keys(parsed).sort()).toEqual([...topRequired].sort());
    expect(propertyEnum(block, "status")).toContain(parsed.status);
    for (const key of checksRequired) {
        expect(Object.keys(parsed.checks)).toContain(key);
    }
    expect(propertyEnum(block, "database")).toContain(parsed.checks.database);
    expect(propertyEnum(block, "redis")).toContain(parsed.checks.redis);
    expect(parsed.status === "down").toBe(httpStatus === 503);
}

/** The `const:` value of `components.headers.CacheControlNoStore`. */
export function contractNoStoreValue(): string {
    const block = blockAfter("    CacheControlNoStore:", 4);
    const match = /const:\s*(\S+)/.exec(block);
    if (match?.[1] === undefined) {
        throw new Error("CacheControlNoStore const not found");
    }
    return match[1];
}

/** Asserts the success envelope and returns `data`. */
export function expectSuccessEnvelope(body: unknown): unknown {
    const envelope = body as { success: boolean; data: unknown };
    expect(envelope.success).toBe(true);
    expect(Object.keys(envelope)).toContain("data");
    return envelope.data;
}

/** Asserts `meta` against `PaginationMeta` (required keys, types). */
export function expectPaginationMeta(meta: unknown): { nextCursor: string | null; hasMore: boolean; count: number } {
    const parsed = meta as { nextCursor: string | null; hasMore: boolean; count: number };
    for (const key of firstInlineList(schemaBlock("PaginationMeta"), "required")) {
        expect(Object.keys(parsed)).toContain(key);
    }
    expect(parsed.nextCursor === null || typeof parsed.nextCursor === "string").toBe(true);
    expect(typeof parsed.hasMore).toBe("boolean");
    expect(Number.isInteger(parsed.count) && parsed.count >= 0).toBe(true);
    return parsed;
}
