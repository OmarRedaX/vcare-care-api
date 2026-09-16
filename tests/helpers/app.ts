import { createPublicApp } from "../../src/app";
import { createInternalApp } from "../../src/internal-app";
import { container } from "../../src/lib/di/container";
import type { BuildTestAppsOptions, ContainerOverride, TestApps } from "./types";

/** Builds the REAL apps (real middleware chain, real container). Test-only routers arrive via `extraRouters`. */
export function buildTestApps(options?: BuildTestAppsOptions): TestApps {
    return {
        publicApp: createPublicApp({ extraRouters: options?.publicRouters }),
        internalApp: createInternalApp({ extraRouters: options?.internalRouters }),
    };
}

/**
 * Temporarily swaps container instances (e.g. an unreachable Redis, a Knex pointing at a closed port)
 * and restores the originals afterwards.
 *
 * NOTE (deviation from spec §9.1): the overrides are applied to the ROOT container rather than a child
 * container. Routers resolve their controllers from the root container, so a child container's
 * registrations would be invisible to the app under test. Restoration in `finally` keeps suites isolated.
 */
export async function withContainerOverrides(
    overrides: ContainerOverride[],
    fn: () => Promise<void> | void,
): Promise<void> {
    const previous = overrides.map((override) => ({
        token: override.token,
        value: container.isRegistered(override.token) ? container.resolve(override.token) : undefined,
    }));

    for (const override of overrides) {
        container.registerInstance(override.token, override.value);
    }

    try {
        await fn();
    } finally {
        for (const entry of previous) {
            if (entry.value !== undefined) {
                container.registerInstance(entry.token, entry.value);
            }
        }
    }
}
