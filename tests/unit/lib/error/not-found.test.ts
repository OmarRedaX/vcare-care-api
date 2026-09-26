import type { Request, Response } from "express";
import { NotFound } from "../../../../src/lib/error/errors";
import { notFound } from "../../../../src/lib/error/not-found";

describe("lib/error/notFound", () => {
    it("should forward NotFound when no route matched", () => {
        const next = jest.fn();
        void notFound({} as Request, {} as Response, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(next).toHaveBeenCalledWith(NotFound);
    });
});
