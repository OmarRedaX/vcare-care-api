import type { Env } from "../config/types";
import { FakeVideoProvider } from "./fake-video.adapter";
import type { VideoRoomProvider } from "./types";

/** Selects the adapter for `VIDEO_PROVIDER`. The fake is refused in production (sessions S-D1, SS-R22): the boot fails, not a request. */
export function createVideoProvider(env: Pick<Env, "NODE_ENV" | "VIDEO_PROVIDER" | "VIDEO_PROVIDER_KEY">): VideoRoomProvider {
    switch (env.VIDEO_PROVIDER) {
        case "fake":
            if (env.NODE_ENV === "production") throw new Error("video_provider_fake_not_allowed_in_production");
            return new FakeVideoProvider(env.VIDEO_PROVIDER_KEY);
    }
}
