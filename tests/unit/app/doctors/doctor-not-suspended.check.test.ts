import { doctorNotSuspendedCheck } from "../../../../src/app/doctors/checks";
import type { AuthContext } from "../../../../src/lib/types/types";

const auth: AuthContext = { userId: 202, role: "doctor", status: "active", emailVerified: true };

describe("doctorNotSuspendedCheck", () => {
    it.each([false, true])("should return %s for the suspension lookup", async (suspended) => {
        const lookup = jest.fn().mockResolvedValue(suspended);
        const check = doctorNotSuspendedCheck({ isLocallySuspended: lookup });
        expect(await check.run({ auth, params: {} })).toBe(suspended ? "deny-forbidden" : "allow");
        expect(lookup).toHaveBeenCalledWith(202);
    });
});
