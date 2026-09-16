import type { Express } from "express";
import type { InjectionToken } from "tsyringe";
import type { MountedRouter } from "../../src/lib/http/types";

export interface BuildTestAppsOptions {
    publicRouters?: MountedRouter[];
    internalRouters?: MountedRouter[];
}

export interface TestApps {
    publicApp: Express;
    internalApp: Express;
}

export interface ContainerOverride {
    token: InjectionToken<unknown>;
    value: unknown;
}

export type FakeServerMode = "normal" | "slow" | "fail";

export interface FakeServerModeOptions {
    delayMs?: number;
    status?: number;
}

export interface FakeRoute {
    method: string;
    path: string;
    status: number;
    body?: unknown;
}

export interface RecordedRequest {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}

export interface FakeHttpServer {
    url: string;
    requests: RecordedRequest[];
    setMode(mode: FakeServerMode, options?: FakeServerModeOptions): void;
    close(): Promise<void>;
}

export interface LogCapture {
    lines(): Record<string, unknown>[];
    text(): string;
    restore(): void;
}
