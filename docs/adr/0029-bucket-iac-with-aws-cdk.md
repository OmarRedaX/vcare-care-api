---
title: "ADR 0029: care's bucket and its IAM policies are declared as AWS CDK in infra/"
owner: care-team
service: care-service
status: accepted
date: 2026-11-13
diataxis: explanation
last_verified: 2026-11-13
tags: [adr, decision, iac, cdk, object-storage, iam, security]
related: [file-handling, infrastructure, adr-0013-verified-direct-upload-lifecycle, adr-0015-aws-sdk-storage-adapter, adr-0022-upload-intents-module, hub-adr-0007-managed-container-platform, hub-adr-0011-object-storage-host]
---

# ADR 0029 — care's bucket and its IAM policies are declared as AWS CDK in `infra/`

- **Status:** Accepted • **Date:** 2026-11-13 • **Deciders:** owner (location), care-team (shape)

## Context
Hub ADR 0011 and the hub TODO decided the bucket rules (private, Block Public Access, TLS-only, SSE-S3, CORS `POST` from the web
origin only, `quarantine/*` expiry, infrequent-access transition, task-role permissions) but no infrastructure code existed in any
repo. The reference platform is AWS (hub ADR 0007). Hub ADR 0011 says each bucket belongs to exactly one service.

## Decision
- The bucket and two IAM **managed policies** (`care-api`, `care-worker`) are an AWS CDK (TypeScript) app in `infra/`, with its own
  `package.json`, lockfile and tests. Nothing in `infra/` is part of the service package, the Docker image or `npm test`
  (root `eslint` and `tsc` ignore it), so the "new runtime dependency needs an ADR" rule is satisfied by this ADR and the service
  dependency list does not change.
- The stack publishes policies, not roles: the ECS task roles belong to the future compute stack, which attaches
  `ApiPolicyArn` and `WorkerPolicyArn`.
- The stack is `terminationProtection: true`, the bucket `RemovalPolicy.RETAIN`, and `webOrigin` is a required, validated context value
  (one exact `https` origin, `http` only for `localhost`, never a wildcard).
- A synth test (`infra/test`) pins every rule above; `cdk synth --strict` is the CI gate.

## Differences from the hub TODO wording (deliberate, tested)
- **`CopyObject` is not an IAM action.** Promotion needs `s3:GetObject` on the quarantine source **and** `s3:PutObject` on the final
  destination, so `care-api` also gets `PutObject` on `verification-documents/*` and `record-attachments/*`. `PutObject` on
  `quarantine/*` stays for the presigned POST.
- **`s3:ListBucket` for `care-api`**, prefix-conditioned to the three prefixes: without it S3 answers `403` instead of `404` to a `HEAD`
  on a missing key, which would turn "the upload never landed" into an authorization-looking error at `complete`.
- `care-worker` is exactly as specified: `DeleteObject` and a prefix-conditioned `ListBucket` on `quarantine/*`.

## Consequences
- ➕ The bucket rules are reviewable code with a test; the web-origin and CORS rules cannot drift silently.
- ➕ Region, account and origin are parameters, so staging and production are the same code.
- ➖ A second package (`infra/package.json`) to keep patched; `cdk-nag` and S3 server-access logging are not added yet (follow-up).
- ➖ Not deployed from this repo: someone with AWS credentials must run `cdk deploy` and wire the policy ARNs into the task roles.

## Alternatives considered
- **A separate platform infra repo** — better once edge and compute IaC exist; not creatable now. The app moves with `git mv` later.
- **Terraform** — equivalent; CDK chosen because the service is TypeScript and the stack is unit-testable with the same toolchain.
- **IAM roles in this stack** — would invent the ECS task roles ahead of the compute stack.
