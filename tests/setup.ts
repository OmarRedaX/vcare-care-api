import "reflect-metadata";
import { registerDependencies } from "../src/bootstrap";
import { getEnv } from "../src/lib/config/env";

// Real wiring only — NO infrastructure mocks here (CLAUDE.md → Testing policy).
registerDependencies(getEnv());
