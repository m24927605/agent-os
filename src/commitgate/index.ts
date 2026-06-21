/**
 * Commit-before-effect module public surface — the TS-side sequencing guard that refuses an external
 * effect until its AuditEvent has a durable WORM receipt.
 */
export * from "./guard.js";
