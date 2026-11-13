import type { StackProps } from "aws-cdk-lib";

/** Inputs of the care storage stack. Nothing is read from the environment inside the stack. */
export interface CareStorageStackProps extends StackProps {
    /** The one browser origin allowed to POST to the bucket, e.g. `https://app.example.com` (hub ADR 0011). No wildcard. */
    readonly webOrigin: string;
    /** Optional fixed bucket name; omit to let CloudFormation generate a unique one. */
    readonly bucketName?: string;
}
