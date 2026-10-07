import { randomUUID } from "node:crypto";
import { getEnv } from "../../src/lib/config/env";
import { S3Adapter } from "../../src/lib/storage/s3.adapter";

const env = getEnv();
const storage = new S3Adapter({
    bucket: env.STORAGE_BUCKET,
    region: env.STORAGE_REGION,
    endpoint: env.STORAGE_ENDPOINT,
    accessKeyId: env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
    forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
});

const pdfBytes = Uint8Array.from(Buffer.from("%PDF-1.7\nsynthetic storage test\n"));
const keys = new Set<string>();

function uniqueKey(prefix = "quarantine"): string {
    const key = `${prefix}/${randomUUID()}`;
    keys.add(key);
    return key;
}

async function postFile(url: string, fields: Record<string, string>, bytes: Uint8Array): Promise<Response> {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    // MinIO requires the file part last. A filename must be supplied, even for synthetic bytes.
    form.set("file", new Blob([Buffer.from(bytes)], { type: "application/octet-stream" }), "synthetic.pdf");
    return fetch(url, { method: "POST", body: form });
}

afterAll(async () => {
    for (const key of keys) await storage.delete(key);
});

describe("S3Adapter against real MinIO", () => {
    it("enforces exact key and size, then supports HEAD, range, copy, delete and signed GET", async () => {
        const source = uniqueKey();
        const final = uniqueKey("verification-documents");
        const policy = await storage.createUploadPolicy(source, pdfBytes.length, 300);

        const wrongKey = await postFile(policy.url, { ...policy.fields, key: uniqueKey() }, pdfBytes);
        expect(wrongKey.status).toBe(403);
        expect(await wrongKey.text()).toContain("AccessDenied");

        const oversize = await postFile(policy.url, policy.fields, Uint8Array.from([...pdfBytes, 0]));
        expect(oversize.status).toBe(400);
        expect(await oversize.text()).toContain("EntityTooLarge");

        const uploaded = await postFile(policy.url, policy.fields, pdfBytes);
        expect(uploaded.status).toBe(204);
        expect(await storage.headObject(source)).toEqual({ sizeBytes: pdfBytes.length });
        expect(await storage.readHead(source, 16)).toEqual(pdfBytes.slice(0, 16));

        await storage.promote(source, final);
        expect(await storage.headObject(final)).toEqual({ sizeBytes: pdfBytes.length });
        expect(await storage.headObject(source)).not.toBeNull();
        await storage.delete(source);
        await storage.delete(source);
        expect(await storage.headObject(source)).toBeNull();
        expect(await storage.readHead(source, 16)).toBeNull();

        const download = await storage.presignDownload(final, "application/pdf", 1);
        const fetched = await fetch(download.url);
        expect(fetched.status).toBe(200);
        expect(fetched.headers.get("content-disposition")).toBe("attachment");
        expect(fetched.headers.get("content-type")).toBe("application/pdf");
        expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(pdfBytes);
        await new Promise((resolve) => setTimeout(resolve, 2_200));
        expect((await fetch(download.url)).status).toBe(403);
    });

    it("rejects an expired POST policy", async () => {
        const key = uniqueKey();
        const policy = await storage.createUploadPolicy(key, pdfBytes.length, 1);
        await new Promise((resolve) => setTimeout(resolve, 2_200));
        const response = await postFile(policy.url, policy.fields, pdfBytes);
        expect(response.status).toBe(403);
        expect(await storage.headObject(key)).toBeNull();
    });
});
