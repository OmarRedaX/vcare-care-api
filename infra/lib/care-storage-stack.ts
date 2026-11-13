import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Effect, ManagedPolicy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { BlockPublicAccess, Bucket, BucketEncryption, HttpMethods, ObjectOwnership, StorageClass } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import {
    CORS_MAX_AGE_SECONDS,
    FINAL_PREFIXES,
    INFREQUENT_ACCESS_AFTER_DAYS,
    QUARANTINE_EXPIRY_DAYS,
    QUARANTINE_PREFIX,
} from "./constants";
import type { CareStorageStackProps } from "./types";

/**
 * care-service's private bucket plus the two IAM managed policies that the platform attaches to the `care-api` and
 * `care-worker` task roles (hub TODO "bucket IaC", hub ADR 0011, care ADRs 0013 to 0015 and 0029).
 *
 * The task roles themselves belong to the compute stack, so this stack only publishes least-privilege policies.
 */
export class CareStorageStack extends Stack {
    public readonly bucket: Bucket;
    public readonly apiPolicy: ManagedPolicy;
    public readonly workerPolicy: ManagedPolicy;

    public constructor(scope: Construct, id: string, props: CareStorageStackProps) {
        super(scope, id, { ...props, terminationProtection: true });

        if (props.webOrigin === "*" || !/^https:\/\/[^/*\s]+$/.test(props.webOrigin) && !/^http:\/\/localhost(:\d+)?$/.test(props.webOrigin)) {
            throw new Error("webOrigin must be one exact https origin (http only for localhost), with no path and no wildcard");
        }

        this.bucket = new Bucket(this, "PrivateBucket", {
            bucketName: props.bucketName,
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            encryption: BucketEncryption.S3_MANAGED,
            objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
            // Clinical and credentialing documents: never deleted by a stack deletion or a replacement.
            removalPolicy: RemovalPolicy.RETAIN,
            cors: [
                {
                    allowedOrigins: [props.webOrigin],
                    allowedMethods: [HttpMethods.POST],
                    allowedHeaders: ["*"],
                    maxAge: CORS_MAX_AGE_SECONDS,
                },
            ],
            lifecycleRules: [
                {
                    id: "expire-quarantine",
                    prefix: QUARANTINE_PREFIX,
                    expiration: Duration.days(QUARANTINE_EXPIRY_DAYS),
                    abortIncompleteMultipartUploadAfter: Duration.days(QUARANTINE_EXPIRY_DAYS),
                },
                ...FINAL_PREFIXES.map((prefix) => ({
                    id: `infrequent-access-${prefix.replace("/", "")}`,
                    prefix,
                    transitions: [{ storageClass: StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(INFREQUENT_ACCESS_AFTER_DAYS) }],
                })),
            ],
        });

        const objectsIn = (prefixes: readonly string[]): string[] => prefixes.map((prefix) => this.bucket.arnForObjects(`${prefix}*`));
        const quarantine = [QUARANTINE_PREFIX];
        const everyPrefix = [QUARANTINE_PREFIX, ...FINAL_PREFIXES];

        this.apiPolicy = new ManagedPolicy(this, "ApiPolicy", {
            description: "care-api task role: presigned POST into quarantine, verify and promote, presigned GET, rollback cleanup",
            statements: [
                // Presigned POST is signed with the task role, so the role needs PutObject on the quarantine keys it signs for.
                new PolicyStatement({ sid: "PresignedPostIntoQuarantine", effect: Effect.ALLOW, actions: ["s3:PutObject"], resources: objectsIn(quarantine) }),
                // CopyObject has no IAM action of its own: it needs GetObject on the source and PutObject on the destination.
                // HeadObject, the byte-range read and presigned GET are all s3:GetObject.
                new PolicyStatement({ sid: "ReadQuarantineAndFinal", effect: Effect.ALLOW, actions: ["s3:GetObject"], resources: objectsIn(everyPrefix) }),
                new PolicyStatement({ sid: "PromoteIntoFinal", effect: Effect.ALLOW, actions: ["s3:PutObject"], resources: objectsIn(FINAL_PREFIXES) }),
                new PolicyStatement({ sid: "DeleteQuarantineAndRollback", effect: Effect.ALLOW, actions: ["s3:DeleteObject"], resources: objectsIn(everyPrefix) }),
                // Without ListBucket S3 answers 403, not 404, for a HEAD on a missing key; prefix-scoped so it lists nothing else.
                new PolicyStatement({
                    sid: "ListForMissingKeySemantics",
                    effect: Effect.ALLOW,
                    actions: ["s3:ListBucket"],
                    resources: [this.bucket.bucketArn],
                    conditions: { StringLike: { "s3:prefix": everyPrefix.map((prefix) => `${prefix}*`) } },
                }),
            ],
        });

        this.workerPolicy = new ManagedPolicy(this, "WorkerPolicy", {
            description: "care-worker task role: upload-intent purge of quarantine only",
            statements: [
                new PolicyStatement({ sid: "DeleteQuarantine", effect: Effect.ALLOW, actions: ["s3:DeleteObject"], resources: objectsIn(quarantine) }),
                new PolicyStatement({
                    sid: "ListQuarantine",
                    effect: Effect.ALLOW,
                    actions: ["s3:ListBucket"],
                    resources: [this.bucket.bucketArn],
                    conditions: { StringLike: { "s3:prefix": [`${QUARANTINE_PREFIX}*`] } },
                }),
            ],
        });

        new CfnOutput(this, "BucketName", { value: this.bucket.bucketName, description: "STORAGE_BUCKET for care-api and care-worker" });
        new CfnOutput(this, "BucketRegionalDomainName", { value: this.bucket.bucketRegionalDomainName, description: "Bucket host for the web app CSP (form-action / connect-src), if a web app is ever added" });
        new CfnOutput(this, "ApiPolicyArn", { value: this.apiPolicy.managedPolicyArn, description: "Attach to the care-api task role" });
        new CfnOutput(this, "WorkerPolicyArn", { value: this.workerPolicy.managedPolicyArn, description: "Attach to the care-worker task role" });
    }
}
