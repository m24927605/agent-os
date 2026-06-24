/**
 * SLICE-EXEC3b — the SHARED seed exec tools (manifests + composer-held bindings) reused by BOTH the
 * EXEC3a join test (`exec-closed-loop.test.ts`) and the EXEC3b live capstone (`exec-capstone.live.test.ts`).
 *
 * These are the SAME two read-only seed tools the EXEC3a slice introduced — `exec.echo` (argvPrefix
 * ["echo"], strict {text}) and `exec.ls` (argvPrefix ["ls"], strict {path}) — extracted out of the test
 * file so the live capstone composes the EXACT bindings the in-repo join proved, not a re-declared
 * lookalike that could drift. The brain proposes only a REGISTERED tool NAME + DECLARED params; the
 * composer's binding fixes `argvPrefix` + a STRICT `argSchema` + a pure `toArgv` builder, so argv is a
 * pure string vector built in ONE place — never a shell string, never `sh -c`, never raw brain input.
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone alongside `exec-closed-loop.ts`; imports
 * ONLY `zod`, the neutral `tools` public barrel, and the in-module `ExecToolBinding` type. Re-exported
 * via the hermes barrel.
 */
import { z } from "zod";
import { ToolRegistry } from "../../../../tools/index.js";
import type { ExecToolBinding } from "./exec-closed-loop.js";

/** A valid `exec.echo` ToolManifest (read-only, no host damage). */
export const echoManifest = {
  name: "exec.echo",
  version: "1.0.0",
  description: "echo a line of text",
  action: "tool:invoke",
  resourcePattern: "exec/echo",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
};

/** A valid `exec.ls` ToolManifest. */
export const lsManifest = {
  name: "exec.ls",
  version: "1.0.0",
  description: "list a path",
  action: "tool:invoke",
  resourcePattern: "exec/ls",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
};

/** exec.echo binding: argvPrefix ["echo"], strict {text}, toArgv -> [text]. */
export const echoBinding: ExecToolBinding = {
  argvPrefix: ["echo"],
  argSchema: z.object({ text: z.string() }).strict(),
  toArgv: (a) => [(a as { text: string }).text],
};

/** exec.ls binding: argvPrefix ["ls"], strict {path}, toArgv -> [path]. */
export const lsBinding: ExecToolBinding = {
  argvPrefix: ["ls"],
  argSchema: z.object({ path: z.string() }).strict(),
  toArgv: (a) => [(a as { path: string }).path],
};

/** A fresh ToolRegistry holding the two seed exec tools (so authorize can admit only these names). */
export function seedRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(echoManifest);
  r.register(lsManifest);
  return r;
}

/** The composer-held bindings map for the two seed exec tools (parallel to the registry). */
export function seedBindings(): ReadonlyMap<string, ExecToolBinding> {
  return new Map<string, ExecToolBinding>([
    ["exec.echo", echoBinding],
    ["exec.ls", lsBinding],
  ]);
}
