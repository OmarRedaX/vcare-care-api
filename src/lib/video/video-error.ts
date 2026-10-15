/** A provider failure. Carries a safe `code` only — never the provider body, a token or a URL. */
export class VideoProviderError extends Error {
    constructor(readonly code: string) {
        super(`video_provider_error:${code}`);
        this.name = "VideoProviderError";
    }
}
