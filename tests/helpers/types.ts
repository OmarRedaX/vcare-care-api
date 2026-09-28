import type { Socket } from "node:net";
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

/** An operation that takes `Idempotency-Key`, and the component response it declares for 409. */
export interface IdempotentOperation {
    method: string;
    path: string;
    conflictResponse: string | undefined;
}

/** One proxied socket pair; `holed` pairs drop every byte in both directions (spec §9.4 round 2). */
export interface ProxiedConnection {
    client: Socket;
    upstream: Socket;
    holed: boolean;
}

export interface BlackHoleProxy {
    /** `postgres://…@127.0.0.1:<proxyPort>/…` — the target URL with host and port replaced. */
    url: string;
    /** Sockets accepted since the proxy started. */
    acceptedCount(): number;
    /** Every socket open NOW goes silent forever (no RST, no FIN); sockets accepted later are forwarded normally. */
    blackHoleEstablished(): void;
    close(): Promise<void>;
}
