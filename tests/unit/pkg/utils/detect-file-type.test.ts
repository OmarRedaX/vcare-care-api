import { detectFileType } from "../../../../src/pkg/utils/detect-file-type";

describe("detectFileType", () => {
    it.each([
        [[0x25, 0x50, 0x44, 0x46, 0x2d], "application/pdf"],
        [[0xff, 0xd8, 0xff], "image/jpeg"],
        [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"],
    ])("recognizes %j", (signature, expected) => {
        expect(detectFileType(Uint8Array.from(signature))).toBe(expected);
    });

    it.each([{ bytes: [] }, { bytes: [0x25, 0x50, 0x44, 0x46] }, { bytes: [0xff, 0xd8] }, { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a] }])(
        "rejects short input $bytes", ({ bytes }) => {
            expect(detectFileType(Uint8Array.from(bytes))).toBeNull();
        },
    );

    it.each([{ bytes: [0x25, 0x50, 0x44, 0x46, 0x00] }, { bytes: [0xff, 0xd8, 0x00] }, { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00] }])(
        "rejects near miss $bytes", ({ bytes }) => {
            expect(detectFileType(Uint8Array.from(bytes))).toBeNull();
        },
    );
});
