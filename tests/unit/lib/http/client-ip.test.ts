import type { Request } from "express";
import { clientIp } from "../../../../src/lib/http/client-ip";

function fakeReq(remoteAddress: string | undefined, forwardedFor?: string | string[]): Request {
    return {
        headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
        socket: { remoteAddress },
    } as unknown as Request;
}

describe("lib/http/clientIp", () => {
    it("should return the socket address when TRUST_PROXY_HOPS is 0 even if X-Forwarded-For is set", () => {
        expect(clientIp(fakeReq("10.0.0.5", "203.0.113.9"), 0)).toBe("10.0.0.5");
    });

    it("should use env TRUST_PROXY_HOPS when no hops argument is passed", () => {
        // .env.test leaves TRUST_PROXY_HOPS at its default of 0.
        expect(clientIp(fakeReq("10.0.0.5", "203.0.113.9"))).toBe("10.0.0.5");
    });

    it("should return the n-th entry from the right when hops is n", () => {
        const req = fakeReq("10.0.0.5", "198.51.100.1, 203.0.113.9, 192.0.2.44");
        expect(clientIp(req, 1)).toBe("192.0.2.44");
        expect(clientIp(req, 2)).toBe("203.0.113.9");
        expect(clientIp(req, 3)).toBe("198.51.100.1");
    });

    it("should join repeated X-Forwarded-For headers when the header is an array", () => {
        expect(clientIp(fakeReq("10.0.0.5", ["198.51.100.1", "203.0.113.9"]), 2)).toBe("198.51.100.1");
    });

    it("should fall back to the socket address when X-Forwarded-For has fewer entries than hops", () => {
        expect(clientIp(fakeReq("10.0.0.5", "203.0.113.9"), 2)).toBe("10.0.0.5");
        expect(clientIp(fakeReq("10.0.0.5"), 1)).toBe("10.0.0.5");
        expect(clientIp(fakeReq("10.0.0.5", " , "), 1)).toBe("10.0.0.5");
    });

    it("should normalise an IPv4-mapped IPv6 address", () => {
        expect(clientIp(fakeReq("::ffff:127.0.0.1"), 0)).toBe("127.0.0.1");
        expect(clientIp(fakeReq("10.0.0.5", "::FFFF:203.0.113.9"), 1)).toBe("203.0.113.9");
        expect(clientIp(fakeReq("::1"), 0)).toBe("::1");
    });

    it('should return "unknown" when there is no socket address', () => {
        expect(clientIp(fakeReq(undefined), 0)).toBe("unknown");
    });
});
