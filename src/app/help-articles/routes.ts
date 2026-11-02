import { Router } from "express";
import { userGuard } from "../../lib/auth/user-guard";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { sealRouter } from "../../lib/http/route-pattern";
import { idempotency } from "../../lib/idempotency/idempotency";
import { rateLimit } from "../../lib/rate-limit/rate-limit";
import { byUser } from "../../lib/rate-limit/subjects";
import { authorize } from "../../lib/rbac/authorize";
import {
    HELP_ARTICLES_RATE_WINDOW_MS,
    HELP_ARTICLES_READ_RATE_NAME,
    HELP_ARTICLES_READ_USER_LIMIT,
    HELP_ARTICLES_WRITE_RATE_NAME,
    HELP_ARTICLES_WRITE_USER_LIMIT,
} from "./constants";
import type { HelpArticlesController } from "./controller/help-articles.controller";
import { HELP_ARTICLES_POLICIES } from "./policies";

export function buildHelpArticlesRouter(): Router {
    const router = Router();
    const controller = container.resolve<HelpArticlesController>(TOKENS.HelpArticlesController);
    const p = HELP_ARTICLES_POLICIES;
    const readLimit = () => rateLimit({ name: HELP_ARTICLES_READ_RATE_NAME, limit: HELP_ARTICLES_READ_USER_LIMIT, windowMs: HELP_ARTICLES_RATE_WINDOW_MS, subject: byUser });
    // One named bucket shared by the three writes (admin-doctors precedent). The limiter runs after authorize, so it only ever sees admins.
    const writeLimit = () => rateLimit({ name: HELP_ARTICLES_WRITE_RATE_NAME, limit: HELP_ARTICLES_WRITE_USER_LIMIT, windowMs: HELP_ARTICLES_RATE_WINDOW_MS, subject: byUser });

    router.get("/help-articles", userGuard(), authorize(p.list), readLimit(), controller.list);
    router.get("/help-articles/:id", userGuard(), authorize(p.get), readLimit(), controller.get);
    router.post("/help-articles", userGuard(), authorize(p.create), writeLimit(), idempotency({ required: false }), controller.create);
    router.patch("/help-articles/:id", userGuard(), authorize(p.update), writeLimit(), controller.update);
    router.delete("/help-articles/:id", userGuard(), authorize(p.remove), writeLimit(), controller.remove);

    return sealRouter(router);
}
