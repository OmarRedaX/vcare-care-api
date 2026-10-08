import {
    CopyObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorage } from "./object-storage";
import { StorageError } from "./storage-error";
import type { DownloadUrl, ObjectHead, PromoteExpectation, S3AdapterOptions, StorageConfig, UploadPolicy } from "./types";

const STANDARD_TIMEOUT_MS = 2_000;
const COPY_TIMEOUT_MS = 10_000;

function isMissing(error: unknown): boolean {
    if (typeof error !== "object" || error === null || !("name" in error)) {
        return false;
    }
    return error.name === "NotFound" || error.name === "NoSuchKey";
}

/** S3-backed implementation. promote copies only; the caller deletes quarantine after a successful copy. */
export class S3Adapter implements ObjectStorage {
    private readonly client: S3Client;
    private readonly now: () => Date;
    private readonly presignPost: typeof createPresignedPost;
    private readonly presignGet: typeof getSignedUrl;

    constructor(private readonly config: StorageConfig, options: S3AdapterOptions = {}) {
        this.client = options.client ?? new S3Client({
            region: config.region,
            ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
            forcePathStyle: config.forcePathStyle,
            ...(config.accessKeyId === undefined || config.secretAccessKey === undefined
                ? {}
                : { credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } }),
            maxAttempts: 2,
        });
        this.now = options.now ?? (() => new Date());
        this.presignPost = options.presignPost ?? createPresignedPost;
        this.presignGet = options.presignGet ?? getSignedUrl;
    }

    async createUploadPolicy(key: string, maxBytes: number, ttlSeconds: number): Promise<UploadPolicy> {
        try {
            const result = await this.withTimeout(
                this.presignPost(this.client, {
                    Bucket: this.config.bucket,
                    Key: key,
                    Expires: ttlSeconds,
                    Fields: { "x-amz-server-side-encryption": "AES256" },
                    Conditions: [
                        ["eq", "$key", key],
                        ["content-length-range", 1, maxBytes],
                        ["eq", "$x-amz-server-side-encryption", "AES256"],
                    ],
                }),
                STANDARD_TIMEOUT_MS,
            );
            return { url: result.url, fields: result.fields };
        } catch {
            throw new StorageError("upload policy creation");
        }
    }

    async headObject(key: string): Promise<ObjectHead | null> {
        try {
            const result = await this.client.send(
                new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
                { abortSignal: AbortSignal.timeout(STANDARD_TIMEOUT_MS) },
            );
            if (result.ContentLength === undefined || result.ETag === undefined) {
                throw new StorageError("head");
            }
            return { sizeBytes: result.ContentLength, etag: result.ETag };
        } catch (error) {
            if (isMissing(error)) return null;
            throw new StorageError("head");
        }
    }

    async readHead(key: string, byteCount: number): Promise<Uint8Array | null> {
        if (!Number.isSafeInteger(byteCount) || byteCount < 1) {
            throw new StorageError("range read");
        }
        try {
            const result = await this.client.send(
                new GetObjectCommand({ Bucket: this.config.bucket, Key: key, Range: `bytes=0-${byteCount - 1}` }),
                { abortSignal: AbortSignal.timeout(STANDARD_TIMEOUT_MS) },
            );
            if (result.Body === undefined) {
                throw new StorageError("range read");
            }
            return await this.withTimeout(result.Body.transformToByteArray(), STANDARD_TIMEOUT_MS);
        } catch (error) {
            if (isMissing(error)) return null;
            throw new StorageError("range read");
        }
    }

    async promote(fromKey: string, toKey: string, expected: PromoteExpectation): Promise<void> {
        try {
            // S3 expects one encoded path, not a URL; encode each segment to preserve literal slashes in keys.
            const copySource = `${encodeURIComponent(this.config.bucket)}/${fromKey.split("/").map(encodeURIComponent).join("/")}`;
            await this.client.send(
                new CopyObjectCommand({
                    Bucket: this.config.bucket,
                    Key: toKey,
                    CopySource: copySource,
                    // Bind the copy to the object that was inspected: a re-POST to the quarantine key changes the ETag.
                    CopySourceIfMatch: expected.etag,
                    ServerSideEncryption: "AES256",
                    MetadataDirective: "REPLACE",
                    ContentType: expected.contentType,
                }),
                { abortSignal: AbortSignal.timeout(COPY_TIMEOUT_MS) },
            );
        } catch {
            throw new StorageError("copy");
        }
    }

    async delete(key: string): Promise<void> {
        try {
            await this.client.send(
                new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
                { abortSignal: AbortSignal.timeout(STANDARD_TIMEOUT_MS) },
            );
        } catch {
            throw new StorageError("delete");
        }
    }

    async presignDownload(key: string, contentType: string, ttlSeconds: number): Promise<DownloadUrl> {
        try {
            const url = await this.withTimeout(
                this.presignGet(this.client, new GetObjectCommand({
                    Bucket: this.config.bucket,
                    Key: key,
                    ResponseContentDisposition: "attachment",
                    ResponseContentType: contentType,
                }), { expiresIn: ttlSeconds }),
                STANDARD_TIMEOUT_MS,
            );
            return { url, expiresAt: new Date(this.now().getTime() + ttlSeconds * 1_000).toISOString() };
        } catch {
            throw new StorageError("download signing");
        }
    }

    private async withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                work,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new StorageError("timeout")), timeoutMs);
                    timer.unref();
                }),
            ]);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }
}
