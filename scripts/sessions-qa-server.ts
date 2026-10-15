/**
 * DEV-ONLY manual-QA harness for the sessions module. Serves the REAL public app (all real routes, guards and services) but rebinds
 * `TOKENS.VideoProvider` to a wrapper around the fake provider whose failure mode is read from a file before every call, so
 * scripts/curl-test-sessions.sh can inject a provider outage over real HTTP without touching product code. Refuses NODE_ENV=production.
 * `scripts/` is excluded from the Docker image.
 *
 *   VIDEO_FAULT_FILE=<path> npx tsx scripts/sessions-qa-server.ts
 *
 * File contents (one word, missing file = ok): ok | fail-room | fail-token | slow-room | slow-token.
 * A slow call takes 3 s, which is longer than the service's 2 s provider bound.
 */
import "reflect-metadata";
import { readFileSync } from "node:fs";
import { createPublicApp } from "../src/app";
import { registerDependencies } from "../src/bootstrap";
import type { JwksCache } from "../src/lib/auth/jwks-cache";
import { getEnv } from "../src/lib/config/env";
import { container } from "../src/lib/di/container";
import { TOKENS } from "../src/lib/di/tokens";
import { runMain } from "../src/lib/lifecycle/run-main";
import { logger } from "../src/lib/logger/logger";
import { redis } from "../src/lib/redis/redis";
import { FakeVideoProvider } from "../src/lib/video/fake-video.adapter";
import type { EnsureRoomInput, JoinTokenInput, VideoJoinToken, VideoRoom, VideoRoomProvider } from "../src/lib/video/types";
import { VideoProviderError } from "../src/lib/video/video-error";

const SLOW_MS = 3000;

class FaultInjectingProvider implements VideoRoomProvider {
    constructor(private readonly inner: VideoRoomProvider, private readonly faultFile: string | undefined) {}

    private mode(): string {
        if (this.faultFile === undefined) return "ok";
        try {
            return readFileSync(this.faultFile, "utf8").trim() || "ok";
        } catch {
            return "ok";
        }
    }

    async ensureRoom(input: EnsureRoomInput): Promise<VideoRoom> {
        const mode = this.mode();
        if (mode === "fail-room") throw new VideoProviderError("qa_injected");
        if (mode === "slow-room") await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
        return this.inner.ensureRoom(input);
    }

    async issueJoinToken(input: JoinTokenInput): Promise<VideoJoinToken> {
        const mode = this.mode();
        if (mode === "fail-token") throw new VideoProviderError("qa_injected");
        if (mode === "slow-token") await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
        return this.inner.issueJoinToken(input);
    }
}

function main(): void {
    const env = getEnv();
    if (env.NODE_ENV === "production") {
        logger.error("sessions_qa_server_refused", { reason: "NODE_ENV is production" });
        process.exit(1);
    }
    registerDependencies(env);
    container.register(TOKENS.VideoProvider, { useValue: new FaultInjectingProvider(new FakeVideoProvider(env.VIDEO_PROVIDER_KEY), process.env.VIDEO_FAULT_FILE) });
    container.resolve<JwksCache>(TOKENS.JwksCache).start();
    redis.connect().catch(() => {
        logger.warn("redis_unavailable");
    });
    createPublicApp().listen(env.PORT, "127.0.0.1", () => {
        logger.info("sessions_qa_server_started", { port: env.PORT });
    });
}

runMain(main);
