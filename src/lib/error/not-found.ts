import type { RequestHandler } from "express";
import { NotFound } from "./errors";

/**
 * Terminal handler for unmatched paths on either listener. An unmatched method on a known path is also
 * a 404 — no 405 code exists in the contract.
 */
export const notFound: RequestHandler = (_req, _res, next) => {
    next(NotFound);
};
