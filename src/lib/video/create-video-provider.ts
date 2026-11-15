import type { Env } from "../config/types";
import { FakeVideoProvider } from "./fake-video.adapter";
import { LiveKitVideoProvider } from "./livekit-video.adapter";
import type { VideoRoomProvider } from "./types";

/** `ws://host` becomes `http://host` and `wss://host` becomes `https://host`: LiveKit serves its API on the same host and port. */
function deriveApiUrl(url: string): string {
    return url.replace(/^ws(s?):\/\//, "http$1://");
}

/**
 * Selects the adapter for `VIDEO_PROVIDER`. The fake is refused in production (sessions S-D1, SS-R22): the boot fails, not a request.
 * `env.ts` already requires the LiveKit key id and URL and `wss`/`https` in production; the checks here guard a hand-built `Env`.
 */
export function createVideoProvider(env: Pick<Env, "NODE_ENV" | "VIDEO_PROVIDER" | "VIDEO_PROVIDER_KEY" | "VIDEO_PROVIDER_KEY_ID" | "VIDEO_PROVIDER_URL" | "VIDEO_PROVIDER_API_URL">): VideoRoomProvider {
    switch (env.VIDEO_PROVIDER) {
        case "fake":
            if (env.NODE_ENV === "production") throw new Error("video_provider_fake_not_allowed_in_production");
            return new FakeVideoProvider(env.VIDEO_PROVIDER_KEY);
        case "livekit": {
            if (env.VIDEO_PROVIDER_KEY_ID === undefined || env.VIDEO_PROVIDER_URL === undefined) throw new Error("video_provider_livekit_not_configured");
            const apiUrl = (env.VIDEO_PROVIDER_API_URL ?? deriveApiUrl(env.VIDEO_PROVIDER_URL)).replace(/\/+$/, "");
            return new LiveKitVideoProvider({ keyId: env.VIDEO_PROVIDER_KEY_ID, apiSecret: env.VIDEO_PROVIDER_KEY, url: env.VIDEO_PROVIDER_URL, apiUrl });
        }
    }
}
