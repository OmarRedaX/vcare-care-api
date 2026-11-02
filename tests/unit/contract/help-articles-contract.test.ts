import "reflect-metadata";
import { HELP_ARTICLE_BODY_MAX_LENGTH, HELP_ARTICLE_BODY_MIN_LENGTH, HELP_ARTICLE_TITLE_MAX_LENGTH, HELP_ARTICLE_TITLE_MIN_LENGTH } from "../../../src/app/help-articles/constants";
import { HelpArticleAudience, HelpArticleAuditAction, HelpArticleCategory } from "../../../src/app/help-articles/enums";
import * as errors from "../../../src/app/help-articles/errors";
import { contractErrorCodes, contractOperationBlock, contractResponseCodes, headerBlock, idempotentOperations, inlineLists, responseBlock, schemaBlock } from "../../helpers/contract";

type Method = "get" | "post" | "patch" | "delete";
/** [operationId, path, method, roles, response codes, audit actions] */
const OPERATIONS: Array<[string, string, Method, string[], string[], string[]]> = [
    ["listHelpArticles", "/api/help-articles", "get", ["patient", "doctor", "admin"], ["200", "400", "401", "403", "429", "500"], []],
    ["getHelpArticle", "/api/help-articles/{id}", "get", ["patient", "doctor", "admin"], ["200", "401", "403", "404", "429", "500"], []],
    ["createHelpArticle", "/api/help-articles", "post", ["admin"], ["201", "400", "401", "403", "409", "422", "429", "500"], ["help_article.created"]],
    ["updateHelpArticle", "/api/help-articles/{id}", "patch", ["admin"], ["200", "400", "401", "403", "404", "409", "429", "500"], ["help_article.updated"]],
    ["deleteHelpArticle", "/api/help-articles/{id}", "delete", ["admin"], ["204", "401", "403", "404", "429", "500"], ["help_article.deleted"]],
];

function propertyNames(block: string): string[] {
    const lines = block.split(/\r?\n/);
    const start = lines.findIndex((line) => line === "      properties:");
    if (start < 0) throw new Error("no properties block");
    const names: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (line.trim().length > 0 && !line.startsWith("        ")) break;
        const match = /^ {8}([A-Za-z]+):\s*$/.exec(line);
        if (match?.[1] !== undefined) names.push(match[1]);
    }
    return names;
}

describe("help-articles contract", () => {
    it.each(OPERATIONS)("should declare %s with its roles, no ownership, audit class and exact response set", (operationId, path, method, roles, codes, actions) => {
        const block = contractOperationBlock(path, method);
        expect(block).toContain(`operationId: ${operationId}`);
        expect(block).toContain("bearerUser");
        expect(inlineLists(block, "x-roles")).toEqual([roles]);
        expect(block).toContain("x-ownership: none");
        expect([...contractResponseCodes(path, method)].sort()).toEqual([...codes].sort());
        if (actions.length === 0) {
            expect(block).not.toContain("x-audit:");
        } else {
            expect(block).toContain("x-audit: admin-action");
            expect(inlineLists(block, "x-audit-actions")).toEqual([actions]);
        }
    });

    it("should declare HelpArticleSummary with exactly the seven required members and no body or createdAt", () => {
        const block = schemaBlock("HelpArticleSummary");
        expect(inlineLists(block, "required")[0]).toEqual(["id", "title", "category", "audience", "isPublished", "publishedAt", "updatedAt"]);
        expect(propertyNames(block)).toEqual(["id", "title", "category", "audience", "isPublished", "publishedAt", "updatedAt"]);
        expect(propertyNames(block)).not.toContain("body");
    });

    it("should reference HelpArticleSummary from the list items and HelpArticle from the detail responses", () => {
        expect(contractOperationBlock("/api/help-articles", "get")).toContain("$ref: '#/components/schemas/HelpArticleSummary'");
        expect(responseBlock("HelpArticleOk")).toContain("$ref: '#/components/schemas/HelpArticle'");
        expect(responseBlock("HelpArticleCreated")).toContain("$ref: '#/components/schemas/HelpArticle'");
    });

    it("should carry x-account-state on the two read operations and not on the writes", () => {
        const state = "x-account-state: 'doctor status in (pending, active, rejected); patient and admin active'";
        expect(contractOperationBlock("/api/help-articles", "get")).toContain(state);
        expect(contractOperationBlock("/api/help-articles/{id}", "get")).toContain(state);
        for (const [, path, method] of OPERATIONS.slice(2)) expect(contractOperationBlock(path, method)).not.toContain("x-account-state");
    });

    it("should declare the Cache-Control private, no-cache header on the list 200, HelpArticleOk and HelpArticleCreated", () => {
        expect(headerBlock("CacheControlPrivateNoCache")).toContain("const: private, no-cache");
        expect(contractOperationBlock("/api/help-articles", "get")).toContain("CacheControlPrivateNoCache");
        expect(responseBlock("HelpArticleOk")).toContain("CacheControlPrivateNoCache");
        expect(responseBlock("HelpArticleCreated")).toContain("CacheControlPrivateNoCache");
    });

    it("should declare the optional Idempotency-Key on POST only, with a Conflict 409 and IdempotencyConflict 422", () => {
        const operations = idempotentOperations().filter((op) => op.path.startsWith("/api/help-articles"));
        expect(operations).toEqual([expect.objectContaining({ method: "POST", path: "/api/help-articles", conflictResponse: "Conflict" })]);
        expect(contractOperationBlock("/api/help-articles", "post")).toContain("components/parameters/IdempotencyKeyOptional");
        expect(contractOperationBlock("/api/help-articles", "post")).toContain("'422':");
    });

    it("should bound the create and update bodies exactly as the request DTOs do", () => {
        for (const name of ["HelpArticleCreate", "HelpArticleUpdate"]) {
            const block = schemaBlock(name);
            expect(block).toContain("additionalProperties: false");
            expect(block).toContain(`minLength: ${HELP_ARTICLE_TITLE_MIN_LENGTH}`);
            expect(block).toContain(`maxLength: ${HELP_ARTICLE_TITLE_MAX_LENGTH}`);
            expect(block).toContain(`minLength: ${HELP_ARTICLE_BODY_MIN_LENGTH}`);
            expect(block).toContain(`maxLength: ${HELP_ARTICLE_BODY_MAX_LENGTH}`);
        }
        expect(inlineLists(schemaBlock("HelpArticleCreate"), "required")[0]).toEqual(["title", "body", "category", "audience", "isPublished"]);
        expect(schemaBlock("HelpArticleUpdate")).toContain("minProperties: 1");
        expect(propertyNames(schemaBlock("HelpArticleCreate"))).toEqual(["title", "body", "category", "audience", "isPublished"]);
        expect(propertyNames(schemaBlock("HelpArticleUpdate"))).toEqual(["title", "body", "category", "audience", "isPublished"]);
    });

    it("should declare the category and audience enums exactly as the module enums do", () => {
        expect(inlineLists(schemaBlock("HelpArticleCategory"), "enum")[0]).toEqual(Object.values(HelpArticleCategory));
        expect(inlineLists(schemaBlock("HelpArticleAudience"), "enum")[0]).toEqual(Object.values(HelpArticleAudience));
    });

    it("should use the audit action names the contract lists", () => {
        expect(Object.values(HelpArticleAuditAction).sort()).toEqual(["help_article.created", "help_article.deleted", "help_article.updated"]);
    });

    it("should declare every error code owned by the module in the ErrorCode enum with the contract status", () => {
        const declared = contractErrorCodes();
        for (const value of Object.values(errors)) {
            const code = (value as { code?: string }).code;
            if (code !== undefined) expect(declared).toContain(code);
        }
        expect([errors.HelpArticleTitleTaken.code, errors.HelpArticleTitleTaken.status]).toEqual(["Conflict", 409]);
        expect([errors.EmptyHelpArticleUpdate.code, errors.EmptyHelpArticleUpdate.status]).toEqual(["ValidationFailed", 400]);
    });

    it("should tell clients the body is verbatim Markdown that must be sanitised and not rendered as raw HTML", () => {
        const block = schemaBlock("HelpArticle").replace(/\s+/g, " ");
        expect(block).toContain("stored and returned verbatim");
        expect(block).toContain("must not render raw HTML");
    });
});
