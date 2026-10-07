import type { Env } from "../config/types";
import type { S3Client } from "@aws-sdk/client-s3";
import type { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import type { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface UploadPolicy {
    url: string;
    fields: Record<string, string>;
}

export interface ObjectHead {
    sizeBytes: number;
}

export interface DownloadUrl {
    url: string;
    expiresAt: string;
}

export interface ObjectStorage {
    createUploadPolicy(key: string, maxBytes: number, ttlSeconds: number): Promise<UploadPolicy>;
    headObject(key: string): Promise<ObjectHead | null>;
    readHead(key: string, byteCount: number): Promise<Uint8Array | null>;
    /** Copy only. The caller deletes the quarantine key after a successful copy. */
    promote(fromKey: string, toKey: string): Promise<void>;
    delete(key: string): Promise<void>;
    presignDownload(key: string, contentType: string, ttlSeconds: number): Promise<DownloadUrl>;
}

export interface StorageConfig {
    bucket: Env["STORAGE_BUCKET"];
    region: Env["STORAGE_REGION"];
    endpoint?: Env["STORAGE_ENDPOINT"];
    accessKeyId?: Env["STORAGE_ACCESS_KEY_ID"];
    secretAccessKey?: Env["STORAGE_SECRET_ACCESS_KEY"];
    forcePathStyle: Env["STORAGE_FORCE_PATH_STYLE"];
}

export interface S3AdapterOptions {
    client?: S3Client;
    now?: () => Date;
    /** Test seam: the SDK presigners need a fully configured client, so unit tests inject doubles. */
    presignPost?: typeof createPresignedPost;
    presignGet?: typeof getSignedUrl;
}
