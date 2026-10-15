import { hydrateUsersOrEmpty } from "../../../../src/lib/identity-client/hydrate";
import type { HydratedUser } from "../../../../src/lib/identity-client/types";
import { fakeLogger } from "../../../helpers/fake-logger";

const user: HydratedUser = { displayName: "Synthetic Person", avatarUrl: null, status: "active" };

describe("lib/identity-client/hydrate hydrateUsersOrEmpty", () => {
    it("should make one batched call for the distinct ids when ids repeat", async () => {
        const getUsersBatch = jest.fn().mockResolvedValue({ users: new Map([[5, user]]), degraded: false });
        const log = fakeLogger();
        const users = await hydrateUsersOrEmpty({ getUsersBatch }, log.logger, [5, 5, 6]);
        expect(getUsersBatch).toHaveBeenCalledTimes(1);
        expect(getUsersBatch.mock.calls[0]?.[0]).toEqual([5, 6]);
        expect(users.get(5)).toEqual(user);
    });

    it("should not call Identity when there are no ids", async () => {
        const getUsersBatch = jest.fn();
        expect((await hydrateUsersOrEmpty({ getUsersBatch }, fakeLogger().logger, [])).size).toBe(0);
        expect(getUsersBatch).not.toHaveBeenCalled();
    });

    it("should return an empty map and warn without data when the client throws", async () => {
        const getUsersBatch = jest.fn().mockRejectedValue(new Error("Synthetic Person unreachable"));
        const log = fakeLogger();
        expect((await hydrateUsersOrEmpty({ getUsersBatch }, log.logger, [5])).size).toBe(0);
        expect(log.messages("warn")).toEqual(["identity_hydration_failed"]);
        expect(log.text()).not.toContain("Synthetic Person");
    });
});
