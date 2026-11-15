---
title: "ADR 0031: video sessions run on self-hosted LiveKit behind the room-provider port"
owner: care-team
service: care-service
status: accepted
date: 2026-11-15
diataxis: explanation
last_verified: 2026-11-15
tags: [adr, decision, sessions, video, livekit, security, undici]
related: [sessions-spec, infrastructure, runbook, adr-0030-resend-email-adapter, adr-0029-bucket-iac-with-aws-cdk, hub-adr-0007-managed-container-platform]
---

# ADR 0031 — video sessions run on self-hosted LiveKit behind the room-provider port

- **Status:** Accepted • **Date:** 2026-11-15 • **Deciders:** owner (free provider, LiveKit), care-team (shape)

## Context
Sessions shipped with a deterministic fake adapter behind `lib/video` (sessions S-D1). The fake is refused when
`NODE_ENV=production`, so `care-api` could not boot in production, and it gave a client nothing to connect to. The owner wants
video that works without a paid provider. CLAUDE.md puts the video infrastructure itself out of scope: Care only issues
rooms and short-lived, per-participant join tokens.

## Decision
- **LiveKit, self-hosted** (Apache-2.0), is the provider: one container locally (`docker-compose.yml`, image pinned to
  `livekit/livekit-server:v1.13.10`), a hosted instance later. LiveKit Cloud's free tier stays available because the adapter only
  needs a URL, a key id and a secret.
- `LiveKitVideoProvider` in `src/lib/video`:
  - `ensureRoom`: one `CreateRoom` on LiveKit's RoomService with `undici` (already a dependency: **no new dependency**), idempotent
    per name `care-<consultationId>`, capped at **2 participants**, closed 1 h after nobody joined and 10 min after the last
    participant left (a dropped call can reconnect). Bounded to 1.8 s (the sessions service bounds the whole call at 2 s).
  - `issueJoinToken`: a LiveKit access token, an **HS256 JWT signed locally** with `node:crypto` (no network call, no `jose`,
    which stays confined to `lib/auth`): bound to one room and one identity (`user-<id>`, role in metadata), grants
    `roomJoin/canPublish/canSubscribe/canPublishData` only (never `roomAdmin`, `roomCreate`, recording), expiry
    `min(300 s, window close)` rounded down to the second.
  - Failures carry a fixed code (`timeout`, `network`, `provider_auth`, `provider_throttled`, `provider_unavailable`,
    `provider_rejected`); the response body, the secret and every token are never read, logged or returned.
- **Contract:** the join/start response (`SessionJoin`) gains `videoServerUrl`, the `ws(s)://` address a client connects to with
  `joinToken` (`null` for the fake). Not a secret. A client needs it to connect and should not hard-code the provider.
- **Env:** `VIDEO_PROVIDER` is `fake` or `livekit`. `livekit` requires `VIDEO_PROVIDER_KEY` (the API secret, >= 32 chars, no default),
  `VIDEO_PROVIDER_KEY_ID` and `VIDEO_PROVIDER_URL`; `VIDEO_PROVIDER_API_URL` is optional (derived from the URL: `wss` to `https`,
  `ws` to `http`). **In production the fake stays refused and `livekit` must use `wss://` and `https://`.**
- `undici` stays lint-restricted; the allowlist gains exactly `src/lib/video/livekit-video.adapter.ts`.

## Consequences
- ➕ Free, open-source video that Care's existing port, token window and 2 s budget already fit; the fake remains for tests.
- ➕ A real `care-api` can boot in production once LiveKit runs behind `wss`; sessions no longer needs a paid vendor.
- ➕ Verified live against LiveKit v1.13.10 (`scripts/video-livekit-smoke.ts`): idempotent `CreateRoom`, cap of two, tokens accepted
  by the server's own `/rtc/validate`, tampered, expired and wrong-secret tokens refused.
- ➖ Care does not host LiveKit: production needs the server reachable over `wss`, its UDP/TCP media ports, and a TURN service for
  restrictive networks (platform work, not built). Recording, egress and webhooks are not used.
- ➖ A room recreated by LiveKit after it closed (auto-create) loses the 2-participant cap; the token remains the gate, and
  tokens are only ever issued to the two parties inside the session window.
- ➖ There is no Care client yet; the join response is verified by contract and by the live smoke, not by a browser.

## Alternatives considered
- **Jitsi Meet, self-hosted** — also free, but four containers and an iframe-centric model; heavier to run than one LiveKit container.
- **Public meet.jit.si** — no access control: anyone with the room URL joins. Rejected for medical consultations.
- **Daily, Whereby, Twilio** — managed and easy, but vendor lock-in and cost at scale.
- **Keep only the fake** — blocks production boot and gives clients nothing to connect to.
