import { FakeVideoProvider } from "../../src/lib/video/fake-video.adapter";
import type { EnsureRoomInput, JoinTokenInput, VideoJoinToken, VideoRoom, VideoRoomProvider } from "../../src/lib/video/types";
import { VideoProviderError } from "../../src/lib/video/video-error";

/**
 * The video room provider is system-external (CLAUDE.md → Testing policy), so integration suites bind this stub in its place: the
 * deterministic fake adapter plus call recording and failing/slow modes. It carries no state of the code under test.
 */
export class StubVideoProvider implements VideoRoomProvider {
    readonly ensureCalls: EnsureRoomInput[] = [];
    readonly tokenCalls: JoinTokenInput[] = [];
    /** `true` fails every call of that kind with a safe code; a number fails that many calls, then recovers. */
    failEnsure: boolean | number = false;
    failIssue: boolean | number = false;
    /** Milliseconds each call waits before answering (a slow provider). */
    delayMs = 0;
    private readonly inner: FakeVideoProvider;

    constructor(readonly secret: string) {
        this.inner = new FakeVideoProvider(secret);
    }

    reset(): void {
        this.ensureCalls.length = 0;
        this.tokenCalls.length = 0;
        this.failEnsure = false;
        this.failIssue = false;
        this.delayMs = 0;
    }

    async ensureRoom(input: EnsureRoomInput): Promise<VideoRoom> {
        this.ensureCalls.push(input);
        await this.pause();
        if (this.consume("failEnsure")) throw new VideoProviderError("stub_ensure_failed");
        return this.inner.ensureRoom(input);
    }

    async issueJoinToken(input: JoinTokenInput): Promise<VideoJoinToken> {
        this.tokenCalls.push(input);
        await this.pause();
        if (this.consume("failIssue")) throw new VideoProviderError("stub_issue_failed");
        return this.inner.issueJoinToken(input);
    }

    private consume(mode: "failEnsure" | "failIssue"): boolean {
        const value = this[mode];
        if (value === true) return true;
        if (typeof value === "number" && value > 0) {
            this[mode] = value - 1;
            return true;
        }
        return false;
    }

    private pause(): Promise<void> {
        return this.delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, this.delayMs)) : Promise.resolve();
    }
}
