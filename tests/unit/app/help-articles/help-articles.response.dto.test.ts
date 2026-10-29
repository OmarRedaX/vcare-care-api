import { HelpArticleResponseDto, HelpArticleSummaryResponseDto } from "../../../../src/app/help-articles/dto/help-articles.response.dto";
import { HelpArticle, HelpArticleSummary } from "../../../../src/app/help-articles/entity/help-articles.entity";
import { HelpArticleAudience, HelpArticleCategory } from "../../../../src/app/help-articles/enums";
import { inlineLists, schemaBlock } from "../../../helpers/contract";

describe("help-articles response DTOs", () => {
    const article = new HelpArticle({
        id: 7,
        title: "Synthetic Article 001",
        body: "SYNTHETIC-HELP-BODY-7731",
        category: HelpArticleCategory.HowItWorks,
        audience: HelpArticleAudience.Patient,
        isPublished: true,
        publishedAt: new Date("2026-02-03T04:05:06.789Z"),
        createdAt: new Date("2026-01-02T03:04:05.678Z"),
        updatedAt: new Date("2026-03-04T05:06:07.890Z"),
    });
    const summary = new HelpArticleSummary({
        id: 7,
        title: "Synthetic Article 001",
        category: HelpArticleCategory.HowItWorks,
        audience: HelpArticleAudience.Patient,
        isPublished: false,
        publishedAt: null,
        updatedAt: new Date("2026-03-04T05:06:07.890Z"),
    });

    it("should copy every field and render dates with toISOString when mapping an article", () => {
        expect({ ...HelpArticleResponseDto.from(article) }).toEqual({
            id: 7,
            title: "Synthetic Article 001",
            body: "SYNTHETIC-HELP-BODY-7731",
            category: "how-it-works",
            audience: "patient",
            isPublished: true,
            publishedAt: "2026-02-03T04:05:06.789Z",
            createdAt: "2026-01-02T03:04:05.678Z",
            updatedAt: "2026-03-04T05:06:07.890Z",
        });
    });

    it("should render publishedAt as null when the article was never published", () => {
        expect(HelpArticleResponseDto.from(new HelpArticle({ ...article, publishedAt: null })).publishedAt).toBeNull();
        expect(HelpArticleSummaryResponseDto.from(summary).publishedAt).toBeNull();
    });

    it("should produce exactly the contract HelpArticle required keys", () => {
        const [required = []] = inlineLists(schemaBlock("HelpArticle"), "required");
        expect(Object.keys(HelpArticleResponseDto.from(article)).sort()).toEqual([...required].sort());
    });

    it("should produce exactly the contract HelpArticleSummary required keys with no body or createdAt (HA-R18)", () => {
        const [required = []] = inlineLists(schemaBlock("HelpArticleSummary"), "required");
        const keys = Object.keys(HelpArticleSummaryResponseDto.from(summary));
        expect(keys.sort()).toEqual([...required].sort());
        expect(keys).not.toContain("body");
        expect(keys).not.toContain("createdAt");
    });

    it("should not leak a body even when a summary entity is built from a full article", () => {
        const leaky = new HelpArticleSummary(article);
        expect(Object.keys(HelpArticleSummaryResponseDto.from(leaky))).not.toContain("body");
        expect(JSON.stringify(HelpArticleSummaryResponseDto.from(leaky))).not.toContain("SYNTHETIC-HELP-BODY-7731");
    });

    it("should never expose created_by or updated_by members", () => {
        const text = JSON.stringify([HelpArticleResponseDto.from(article), HelpArticleSummaryResponseDto.from(summary)]);
        expect(text).not.toMatch(/created_?by|updated_?by|deleted_?at/i);
    });
});
