/**
 * Shrunken guard limits for the integration tests. MUST be imported before any
 * src module: ESM evaluates imports ahead of module-body statements, so plain
 * `process.env.X = ...` lines at the top of a test file run AFTER config.ts
 * has already read the environment.
 */
process.env.MAX_DROP_BYTES = "1024";
process.env.RATE_WINDOW_MS = "60000";
process.env.RATE_MAX_DROPS_PER_WINDOW = "100";
process.env.STORAGE_WARN_BYTES = "4096";
process.env.STORAGE_MAX_BYTES = "5000";

export {};
