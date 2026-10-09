import { NoopSuspensionImpactProvider } from "../../../../src/app/admin-doctors/service/noop-suspension-impact.provider";

describe("NoopSuspensionImpactProvider", () => {
    const provider = new NoopSuspensionImpactProvider();

    it("should flag nothing and return an empty id list", async () => {
        await expect(provider.flagFutureConsultations()).resolves.toEqual([]);
    });

    it("should list no flagged consultations", async () => {
        await expect(provider.listFlaggedConsultations()).resolves.toEqual([]);
    });
});
