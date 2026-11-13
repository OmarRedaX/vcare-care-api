# care storage infrastructure (AWS CDK)

Declares care-service's private bucket and the two IAM managed policies for the `care-api` and `care-worker` task roles.
Decision and rules: [care ADR 0029](../docs/adr/0029-bucket-iac-with-aws-cdk.md), hub ADR 0011,
[file-handling](../docs/architecture/file-handling.md). Not part of the service package or image.

```bash
cd infra
npm ci
npm run typecheck && npm test                              # 14 synth assertions, no AWS access needed
npx cdk synth --strict -c webOrigin=https://app.example.com
npx cdk diff   -c webOrigin=https://app.example.com        # needs AWS credentials; ALWAYS diff before deploy
npx cdk deploy -c webOrigin=https://app.example.com [-c bucketName=<unique-name>]
```

After deploy, set `STORAGE_BUCKET` from the `BucketName` output and attach `ApiPolicyArn` to the `care-api` task role and
`WorkerPolicyArn` to the `care-worker` task role. Never use `--hotswap` or `--express` against this stack. The bucket is `RETAIN`:
deleting the stack leaves the data, by design.
