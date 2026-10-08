import { createHash } from "node:crypto";
import { StorageError } from "../../src/lib/storage/storage-error";
import type { DownloadUrl, ObjectHead, PromoteExpectation, UploadPolicy } from "../../src/lib/storage/types";
import type { FakeStorage, StorageCall } from "./types";

function etagOf(bytes: Uint8Array): string {
    return `"${createHash("md5").update(bytes).digest("hex")}"`;
}

/** Shared route-test fake. It records calls and supports absent, oversized, and failed-copy scenarios. */
export class InMemoryObjectStorage implements FakeStorage {
    readonly calls: StorageCall[] = [];
    private readonly objects = new Map<string, Uint8Array>();
    private readonly headSizes = new Map<string, number>();
    private copyShouldFail = false;
    private replaceAfterHead: { key: string; bytes: Uint8Array } | null = null;

    seed(key: string, bytes: Uint8Array): void {
        this.objects.set(key, bytes.slice());
    }

    has(key: string): boolean {
        return this.objects.has(key);
    }

    setHeadSize(key: string, sizeBytes: number): void {
        this.headSizes.set(key, sizeBytes);
    }

    /** Simulates a re-POST to the same key right after the next successful HEAD of it (TOCTOU). */
    replaceAfterNextHead(key: string, bytes: Uint8Array): void {
        this.replaceAfterHead = { key, bytes: bytes.slice() };
    }

    failNextCopy(): void {
        this.copyShouldFail = true;
    }

    clear(): void {
        this.objects.clear();
        this.headSizes.clear();
        this.calls.length = 0;
        this.copyShouldFail = false;
        this.replaceAfterHead = null;
    }

    createUploadPolicy(key: string, maxBytes: number, ttlSeconds: number): Promise<UploadPolicy> {
        this.calls.push({ operation: "createUploadPolicy", args: [key, maxBytes, ttlSeconds] });
        return Promise.resolve({ url: "https://storage.test/upload", fields: { key, "x-amz-server-side-encryption": "AES256" } });
    }

    headObject(key: string): Promise<ObjectHead | null> {
        this.calls.push({ operation: "headObject", args: [key] });
        const bytes = this.objects.get(key);
        if (bytes === undefined) return Promise.resolve(null);
        const head: ObjectHead = { sizeBytes: this.headSizes.get(key) ?? bytes.length, etag: etagOf(bytes) };
        if (this.replaceAfterHead?.key === key) {
            this.objects.set(key, this.replaceAfterHead.bytes);
            this.replaceAfterHead = null;
        }
        return Promise.resolve(head);
    }

    readHead(key: string, byteCount: number): Promise<Uint8Array | null> {
        this.calls.push({ operation: "readHead", args: [key, byteCount] });
        return Promise.resolve(this.objects.get(key)?.slice(0, byteCount) ?? null);
    }

    promote(fromKey: string, toKey: string, expected: PromoteExpectation): Promise<void> {
        this.calls.push({ operation: "promote", args: [fromKey, toKey] });
        if (this.copyShouldFail) {
            this.copyShouldFail = false;
            return Promise.reject(new StorageError("copy"));
        }
        const bytes = this.objects.get(fromKey);
        if (bytes === undefined || etagOf(bytes) !== expected.etag) return Promise.reject(new StorageError("copy"));
        this.objects.set(toKey, bytes.slice());
        return Promise.resolve();
    }

    delete(key: string): Promise<void> {
        this.calls.push({ operation: "delete", args: [key] });
        this.objects.delete(key);
        this.headSizes.delete(key);
        return Promise.resolve();
    }

    presignDownload(key: string, contentType: string, ttlSeconds: number): Promise<DownloadUrl> {
        this.calls.push({ operation: "presignDownload", args: [key, contentType, ttlSeconds] });
        return Promise.resolve({ url: "https://storage.test/download", expiresAt: new Date(Date.now() + ttlSeconds * 1_000).toISOString() });
    }
}
