import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { CareStorageStack } from "../lib/care-storage-stack";

const ORIGIN = "https://app.example.test";

function synth(webOrigin = ORIGIN): Template {
    const app = new App();
    return Template.fromStack(new CareStorageStack(app, "CareStorage", { webOrigin, env: { account: "111111111111", region: "eu-west-1" } }));
}

interface Statement {
    Sid: string;
    Action: string | string[];
    Resource: unknown;
}

function statementsOf(template: Template, logicalIdPrefix: string): Statement[] {
    const policies = template.findResources("AWS::IAM::ManagedPolicy");
    const key = Object.keys(policies).find((k) => k.startsWith(logicalIdPrefix));
    expect(key).toBeDefined();
    return (policies[key as string] as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement;
}

function actionsOf(statements: Statement[]): string[] {
    return statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
}

describe("CareStorageStack", () => {
    it("should keep the bucket private with every public-access block on, SSE-S3 and owner-enforced ownership", () => {
        const t = synth();
        t.hasResourceProperties("AWS::S3::Bucket", {
            PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
            BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
            OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
        });
    });

    it("should deny every non-TLS request with a bucket policy", () => {
        synth().hasResourceProperties("AWS::S3::BucketPolicy", {
            PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: "Deny", Action: "s3:*", Condition: { Bool: { "aws:SecureTransport": "false" } } })]) },
        });
    });

    it("should allow CORS POST from the one web origin only, without credentials", () => {
        const rules = Object.values(synth().findResources("AWS::S3::Bucket"))[0]?.Properties.CorsConfiguration.CorsRules as Array<Record<string, unknown>>;
        expect(rules).toHaveLength(1);
        expect(rules[0]).toMatchObject({ AllowedOrigins: [ORIGIN], AllowedMethods: ["POST"], MaxAge: 600 });
        expect(rules[0]).not.toHaveProperty("ExposedHeaders");
    });

    it("should expire quarantine after one day and move both final prefixes to infrequent access after 90 days", () => {
        const rules = Object.values(synth().findResources("AWS::S3::Bucket"))[0]?.Properties.LifecycleConfiguration.Rules as Array<Record<string, unknown>>;
        expect(rules).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ Prefix: "quarantine/", ExpirationInDays: 1, Status: "Enabled" }),
                expect.objectContaining({ Prefix: "verification-documents/", Transitions: [{ StorageClass: "STANDARD_IA", TransitionInDays: 90 }] }),
                expect.objectContaining({ Prefix: "record-attachments/", Transitions: [{ StorageClass: "STANDARD_IA", TransitionInDays: 90 }] }),
            ]),
        );
    });

    it("should retain the bucket on stack deletion and protect the stack from termination", () => {
        const t = synth();
        t.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
        const app = new App();
        expect(new CareStorageStack(app, "S", { webOrigin: ORIGIN }).terminationProtection).toBe(true);
    });

    it("should give care-api no wildcard action, PutObject on quarantine and the final prefixes only, and Delete on those prefixes", () => {
        const statements = statementsOf(synth(), "ApiPolicy");
        const actions = actionsOf(statements);
        expect(actions.every((a) => !a.includes("*"))).toBe(true);
        expect(actions.sort()).toEqual(["s3:DeleteObject", "s3:GetObject", "s3:ListBucket", "s3:PutObject", "s3:PutObject"]);
        const serialized = JSON.stringify(statements);
        expect(serialized).not.toContain('\\"/*\\"'); // no whole-bucket object ARN: every wildcard follows a prefix
        expect(serialized).toContain("quarantine/*");
        expect(serialized).toContain("verification-documents/*");
        expect(serialized).toContain("record-attachments/*");
    });

    it("should scope care-api ListBucket to the three prefixes with an s3:prefix condition", () => {
        const list = statementsOf(synth(), "ApiPolicy").find((s) => s.Sid === "ListForMissingKeySemantics") as unknown as { Condition: { StringLike: { "s3:prefix": string[] } } };
        expect(list.Condition.StringLike["s3:prefix"].sort()).toEqual(["quarantine/*", "record-attachments/*", "verification-documents/*"]);
    });

    it("should give care-worker only DeleteObject and a prefix-conditioned ListBucket on quarantine", () => {
        const statements = statementsOf(synth(), "WorkerPolicy");
        expect(actionsOf(statements).sort()).toEqual(["s3:DeleteObject", "s3:ListBucket"]);
        const serialized = JSON.stringify(statements);
        expect(serialized).toContain("quarantine/*");
        expect(serialized).not.toContain("verification-documents");
        expect(serialized).not.toContain("record-attachments");
    });

    it.each(["*", "http://app.example.test", "https://app.example.test/path", "https://*.example.test", ""])("should refuse the web origin %p", (origin) => {
        expect(() => synth(origin)).toThrow(/webOrigin must be one exact https origin/);
    });

    it("should accept http only for localhost", () => {
        expect(() => synth("http://localhost:5173")).not.toThrow();
    });
});
