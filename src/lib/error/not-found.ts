import type { RequestHandler } from "express";
import { markPreAuth } from "../rbac/markers";
import { NotFound } from "./errors";

/**
 * Terminal handler for unmatched paths on either listener. An unmatched method on a known path is also
 * a 404 — no 405 code exists in the contract.
 */
export const notFound: RequestHandler = (_req, _res, next) => {
    next(NotFound);
};

/**
 * Mounted after the dev-only CORS middleware (which answers allowed preflights) and before every router. Without it
 * Express 5's router answers `OPTIONS` on a known path itself (`200 text/plain`, `Allow: GET, HEAD`), bypassing the one
 * error envelope and revealing route shapes to anonymous callers.
 */
export const optionsNotFound: RequestHandler = markPreAuth((req, _res, next) => {
    next(req.method === "OPTIONS" ? NotFound : undefined);
});
