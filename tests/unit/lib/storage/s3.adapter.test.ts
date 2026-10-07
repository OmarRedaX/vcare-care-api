import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { S3Adapter } from "../../../../src/lib/storage/s3.adapter";
import { StorageError } from "../../../../src/lib/storage/storage-error";

const createPresignedPost = jest.fn();
const getSignedUrl = jest.fn();

const config = {
    bucket: "private-bucket",
    region: "us-east-1",
    endpoint: "http://localhost:9003",
    accessKeyId: "sensitive-access",
    secretAccessKey: "sensitive-secret",
    forcePathStyle: true,
};

function makeAdapter() {
    const send = jest.fn();
    const adapter = new S3Adapter(config, { client: { send } as unknown as S3Client, now: () => new Date("2026-01-01T00:00:00.000Z"), presignPost: createPresignedPost as never, presignGet: getSignedUrl as never });
    return { adapter, send };
}

describe("S3Adapter", () => {
    beforeEach(() => jest.clearAllMocks());

    it("signs an exact-key encrypted POST with the size range", async () => {
        const { adapter } = makeAdapter();
        createPresignedPost.mockResolvedValue({ url: "https://storage.test", fields: { key: "q/a" } });
        await expect(adapter.createUploadPolicy("q/a", 10, 300)).resolves.toEqual({ url: "https://storage.test", fields: { key: "q/a" } });
        expect(createPresignedPost.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
            Bucket: config.bucket,
            Key: "q/a",
            Expires: 300,
            Fields: { "x-amz-server-side-encryption": "AES256" },
            Conditions: [["eq", "$key", "q/a"], ["content-length-range", 1, 10], ["eq", "$x-amz-server-side-encryption", "AES256"]],
        }));
    });

    it("maps missing head and range reads to null", async () => {
        const { adapter, send } = makeAdapter();
        send.mockRejectedValueOnce({ name: "NotFound" }).mockRejectedValueOnce({ name: "NoSuchKey" });
        await expect(adapter.headObject("missing")).resolves.toBeNull();
        await expect(adapter.readHead("missing", 16)).resolves.toBeNull();
    });

    it("uses bounded HEAD and range calls, returning the range bytes", async () => {
        const { adapter, send } = makeAdapter();
        send.mockResolvedValueOnce({ ContentLength: 12 }).mockResolvedValueOnce({ Body: { transformToByteArray: () => Promise.resolve(Uint8Array.from([1, 2])) } });
        await expect(adapter.headObject("q/a")).resolves.toEqual({ sizeBytes: 12 });
        await expect(adapter.readHead("q/a", 16)).resolves.toEqual(Uint8Array.from([1, 2]));
        expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
        expect(send.mock.calls[0]?.[1].abortSignal).toBeInstanceOf(AbortSignal);
        expect(send.mock.calls[1]?.[0]).toBeInstanceOf(GetObjectCommand);
        expect(send.mock.calls[1]?.[0].input.Range).toBe("bytes=0-15");
        expect(send.mock.calls[1]?.[1].abortSignal).toBeInstanceOf(AbortSignal);
    });

    it("copies with an encoded source and encryption, leaving source deletion to the caller", async () => {
        const { adapter, send } = makeAdapter();
        send.mockResolvedValueOnce({ Body: { transformToByteArray: () => Promise.resolve(Uint8Array.from(Buffer.from("%PDF-1.7"))) } }).mockResolvedValueOnce({});
        await adapter.promote("quarantine/a b+#?%.pdf", "final/x");
        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[1]?.[0]).toBeInstanceOf(CopyObjectCommand);
        expect(send.mock.calls[1]?.[0].input).toEqual(expect.objectContaining({
            CopySource: "private-bucket/quarantine/a%20b%2B%23%3F%25.pdf",
            ServerSideEncryption: "AES256",
            MetadataDirective: "REPLACE",
            ContentType: "application/pdf",
            Key: "final/x",
        }));
        expect(send.mock.calls[1]?.[1].abortSignal).toBeInstanceOf(AbortSignal);
    });

    it("deletes idempotently and signs an attachment download", async () => {
        const { adapter, send } = makeAdapter();
        send.mockResolvedValue({});
        getSignedUrl.mockResolvedValue("https://storage.test/download");
        await adapter.delete("missing");
        expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteObjectCommand);
        await expect(adapter.presignDownload("final/x", "image/png", 60)).resolves.toEqual({
            url: "https://storage.test/download", expiresAt: "2026-01-01T00:01:00.000Z",
        });
        expect(getSignedUrl.mock.calls[0]?.[1].input).toEqual(expect.objectContaining({
            ResponseContentDisposition: "attachment", ResponseContentType: "image/png",
        }));
    });

    it("configures two SDK attempts and operation-specific abort deadlines", async () => {
        const real = new S3Adapter(config);
        const client = Reflect.get(real, "client") as S3Client;
        expect(await client.config.maxAttempts()).toBe(2);

        const timeout = jest.spyOn(AbortSignal, "timeout");
        const { adapter, send } = makeAdapter();
        send.mockResolvedValueOnce({ ContentLength: 1 })
            .mockResolvedValueOnce({ Body: { transformToByteArray: () => Promise.resolve(Uint8Array.from(Buffer.from("%PDF-1.7"))) } })
            .mockResolvedValueOnce({});
        try {
            await adapter.headObject("q/a");
            await adapter.promote("q/a", "final/a");
            expect(timeout).toHaveBeenNthCalledWith(1, 2_000);
            expect(timeout).toHaveBeenNthCalledWith(2, 2_000);
            expect(timeout).toHaveBeenNthCalledWith(3, 10_000);
        } finally {
            timeout.mockRestore();
            client.destroy();
        }
    });

    it("refuses to copy unrecognized source bytes", async () => {
        const { adapter, send } = makeAdapter();
        send.mockResolvedValue({ Body: { transformToByteArray: () => Promise.resolve(Uint8Array.from([1, 2, 3])) } });
        await expect(adapter.promote("quarantine/bad", "final/bad")).rejects.toBeInstanceOf(StorageError);
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
    });

    it("wraps SDK failures without keys, bucket, URL, or credentials", async () => {
        const { adapter, send } = makeAdapter();
        send.mockRejectedValue(new Error("secret= sensitive-secret key=q/sensitive bucket=private-bucket http://localhost:9003"));
        for (const action of [() => adapter.headObject("q/sensitive"), () => adapter.readHead("q/sensitive", 16), () => adapter.promote("q/sensitive", "x"), () => adapter.delete("q/sensitive")]) {
            await expect(action()).rejects.toBeInstanceOf(StorageError);
            await expect(action()).rejects.toThrow(/^Object storage [a-z ]+ failed$/);
        }
    });
});
