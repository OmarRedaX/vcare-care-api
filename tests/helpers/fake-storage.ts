import { StorageError } from "../../src/lib/storage/storage-error";
import type { DownloadUrl, ObjectHead, UploadPolicy } from "../../src/lib/storage/types";
import type { FakeStorage, StorageCall } from "./types";

/** Shared route-test fake. It records calls and supports absent, oversized, and failed-copy scenarios. */
export class InMemoryObjectStorage implements FakeStorage {
    readonly calls: StorageCall[] = [];
    private readonly objects = new Map<string, Uint8Array>();
    private readonly headSizes = new Map<string, number>();
    private copyShouldFail = false;

    seed(key: string, bytes: Uint8Array): void {
        this.objects.set(key, bytes.slice());
    }

    has(key: string): boolean {
        return this.objects.has(key);
    }

    setHeadSize(key: string, sizeBytes: number): void {
        this.headSizes.set(key, sizeBytes);
    }

    failNextCopy(): void {
        this.copyShouldFail = true;
    }

    clear(): void {
        this.objects.clear();
        this.headSizes.clear();
        this.calls.length = 0;
        this.copyShouldFail = false;
    }

    createUploadPolicy(key: string, maxBytes: number, ttlSeconds: number): Promise<UploadPolicy> {
        this.calls.push({ operation: "createUploadPolicy", args: [key, maxBytes, ttlSeconds] });
        return Promise.resolve({ url: "https://storage.test/upload", fields: { key, "x-amz-server-side-encryption": "AES256" } });
    }

    headObject(key: string): Promise<ObjectHead | null> {
        this.calls.push({ operation: "headObject", args: [key] });
        const bytes = this.objects.get(key);
        return Promise.resolve(bytes === undefined ? null : { sizeBytes: this.headSizes.get(key) ?? bytes.length });
    }

    readHead(key: string, byteCount: number): Promise<Uint8Array | null> {
        this.calls.push({ operation: "readHead", args: [key, byteCount] });
        return Promise.resolve(this.objects.get(key)?.slice(0, byteCount) ?? null);
    }

    promote(fromKey: string, toKey: string): Promise<void> {
        this.calls.push({ operation: "promote", args: [fromKey, toKey] });
        if (this.copyShouldFail) {
            this.copyShouldFail = false;
            return Promise.reject(new StorageError("copy"));
        }
        const bytes = this.objects.get(fromKey);
        if (bytes === undefined) return Promise.reject(new StorageError("copy"));
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
