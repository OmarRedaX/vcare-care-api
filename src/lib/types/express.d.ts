import type { AuthContext, ServiceContext } from "./types";
import type { Logger } from "../logger/logger";

declare global {
    namespace Express {
        interface Request {
            /** Always set by `requestId()`, which is mounted first on both listeners. */
            requestId: string;
            /** Root logger bound to this request's id. */
            log: Logger;
            /** Set by `lib/auth`'s user guard; absent on unauthenticated routes. */
            auth?: AuthContext;
            /** Set by `lib/auth`'s service guard on `/internal/*` routes. */
            service?: ServiceContext;
        }
    }
}

export {};
