import type { LogCapture } from "./types";

/** Captures everything written to stdout/stderr so tests can assert on log CONTENT and on what is absent. */
export function captureLogs(): LogCapture {
    const chunks: string[] = [];
    const originalStdout = process.stdout.write.bind(process.stdout);
    const originalStderr = process.stderr.write.bind(process.stderr);

    const collect = (chunk: unknown): boolean => {
        chunks.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
    };

    process.stdout.write = collect;
    process.stderr.write = collect;

    return {
        lines(): Record<string, unknown>[] {
            return chunks
                .join("")
                .split("\n")
                .filter((line) => line.trim().length > 0)
                .flatMap((line) => {
                    try {
                        return [JSON.parse(line) as Record<string, unknown>];
                    } catch {
                        return [];
                    }
                });
        },
        text(): string {
            return chunks.join("");
        },
        restore(): void {
            process.stdout.write = originalStdout;
            process.stderr.write = originalStderr;
        },
    };
}

/** Asserts that no synthetic clinical/PII fixture string reached the logs (CLAUDE.md → Privacy and logging). */
export function expectNoSensitiveStrings(capture: LogCapture, fixtures: string[]): void {
    const text = capture.text();
    for (const fixture of fixtures) {
        if (text.includes(fixture)) {
            throw new Error(`Sensitive fixture string leaked into logs: ${fixture}`);
        }
    }
}
