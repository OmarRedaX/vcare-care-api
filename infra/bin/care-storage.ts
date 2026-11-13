import { App } from "aws-cdk-lib";
import { CareStorageStack } from "../lib/care-storage-stack";

const app = new App();
const webOrigin = app.node.tryGetContext("webOrigin") as string | undefined;
if (webOrigin === undefined) {
    throw new Error("Pass the browser origin: cdk synth -c webOrigin=https://app.example.com");
}

new CareStorageStack(app, "CareStorage", {
    webOrigin,
    bucketName: app.node.tryGetContext("bucketName") as string | undefined,
    // Account and region come from the CLI credentials; commit cdk.context.json if lookups are ever added.
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
