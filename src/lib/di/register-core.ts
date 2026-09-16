import type { Env } from "../config/types";
import { db } from "../knex/knex";
import { InFlightCounter } from "../lifecycle/in-flight";
import { ShutdownState } from "../lifecycle/shutdown-state";
import { logger } from "../logger/logger";
import { redis } from "../redis/redis";
import { container } from "./container";
import { TOKENS } from "./tokens";

/** Registers the shared infrastructure singletons. Module classes are registered in `src/bootstrap.ts`. */
export function registerCore(env: Env): void {
    container.registerInstance(TOKENS.Env, env);
    container.registerInstance(TOKENS.Logger, logger);
    container.registerInstance(TOKENS.Db, db);
    container.registerInstance(TOKENS.Redis, redis);
    container.registerInstance(TOKENS.ShutdownState, new ShutdownState());
    container.registerInstance(TOKENS.InFlightCounter, new InFlightCounter());
}
