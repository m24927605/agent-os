/**
 * SLICE-R9b-2b — the shared scope/projection helper `buildProjectionForCall` (RED-first).
 *
 * The helper is the SINGLE place the autonomous path turns a BoundExecCall into an (optional) R9b-1
 * GovernanceProjection. It composes three gates, in order, and returns `undefined` unless ALL pass:
 *   (1) SCOPE — the tool's manifest `sideEffect`/`requiresApproval` is IN-SCOPE for `scope`
 *       (`effectful` default = write|destructive|requiresApproval; `all` = also none|read).
 *   (2) PROJECTOR — the tool's binding declares a `governanceProjector` (read-only tools declare NONE).
 *   (3) VALIDATION — `binding.argSchema.safeParse(tc.args ?? {})` succeeds (else the effect would deny).
 * Only then does it return `governanceProjector(validated)`.
 *
 * The helper is vendor-neutral in spirit (it consumes the neutral `ToolManifest` lookup + the
 * GovernanceProjection contract) but lives in the hermes adapter zone because `ExecToolBinding` is a
 * hermes-adapter type. Read-only tools (echo/ls/...) declare NO projector, so they are out-of-scope by
 * construction even before the scope gate — but the scope gate is the LOAD-BEARING latency/scope cut
 * proven non-vacuously below.
 *
 * CREDENTIAL-BLIND: the projection is built from the BINDING-VALIDATED args (the screen already ran
 * before authorize), then the R9b-1 builder best-effort redacts. The helper never touches raw env/stdin.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildExecRunProjection } from "../../../../policy/index.js";
import type { ToolManifest } from "../../../../tools/index.js";
import type { ExecToolBinding } from "./exec-closed-loop.js";
import { echoManifest, runBinding, runManifest, seedBindings } from "./exec-seed-tools.js";
import { buildProjectionForCall } from "./governance-projection-for-call.js";

/** A `sk-`-shaped canary assembled at RUNTIME (never a source literal — secret-scan stays clean). */
function skCanary(): string {
  return `${"sk"}-${"Z".repeat(24)}`;
}

// A SYNTHETIC read-only tool that ALSO declares a governanceProjector. This isolates the SCOPE gate as
// an INDEPENDENT non-vacuity target: gate (2)/(3) pass for it, so ONLY the scope gate can keep it out
// under scope=effectful. (The real seed read tools have NO projector, so they'd stay undefined even with
// a broken scope gate — they cannot prove the scope gate alone.)
const readWithProjectorManifest = {
  name: "exec.readproj",
  version: "1.0.0",
  description:
    "a synthetic read tool that nonetheless declares a projector (scope-gate test fixture)",
  action: "tool:invoke",
  resourcePattern: "exec/readproj",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "in-sandbox" as const,
};
const readWithProjectorBinding: ExecToolBinding = {
  argvPrefix: ["true"],
  argSchema: z.object({ argv: z.array(z.string()).min(1) }).strict(),
  toArgv: (a) => [...(a as { argv: string[] }).argv],
  governanceProjector: (a) => buildExecRunProjection({ argv: (a as { argv: string[] }).argv }),
};

const bindings = new Map(seedBindings());
bindings.set("exec.readproj", readWithProjectorBinding);
/** Manifest lookup over the seed registry (exec.run = write; exec.echo = read) + the synthetic fixture. */
const lookup = (name: string): ToolManifest | undefined => {
  if (name === "exec.run") return runManifest as ToolManifest;
  if (name === "exec.echo") return echoManifest as ToolManifest;
  if (name === "exec.readproj") return readWithProjectorManifest as ToolManifest;
  return undefined;
};

describe("buildProjectionForCall — in-scope effectful tool with a projector + valid args", () => {
  it("exec.run (write, has projector, valid argv) -> a GovernanceProjection", () => {
    const proj = buildProjectionForCall(
      { tool: "exec.run", args: { argv: ["ls", "-la"] } },
      bindings,
      lookup,
      "effectful",
    );
    expect(proj).toBeDefined();
    expect(proj?.version).toBe(1);
    expect(proj?.argv0).toBe("ls");
    expect(proj?.argc).toBe(2);
  });

  it("exec.run under scope=all also projects (broader scope is a superset)", () => {
    const proj = buildProjectionForCall(
      { tool: "exec.run", args: { argv: ["cat", "/etc/hosts"] } },
      bindings,
      lookup,
      "all",
    );
    expect(proj).toBeDefined();
    expect(proj?.argv0).toBe("cat");
  });
});

describe("buildProjectionForCall — the SCOPE gate is INDEPENDENTLY load-bearing (synthetic read-with-projector)", () => {
  it("a READ tool that HAS a projector is OUT-OF-SCOPE under scope=effectful -> undefined (scope gate alone)", () => {
    // The fixture passes the projector + validation gates, so ONLY the scope gate keeps it out here.
    // NON-VACUITY: make `isInScope` treat read as in-scope (scope gate disabled) and this flips RED.
    const proj = buildProjectionForCall(
      { tool: "exec.readproj", args: { argv: ["true"] } },
      bindings,
      lookup,
      "effectful",
    );
    expect(proj).toBeUndefined();
  });

  it("the SAME read-with-projector tool UNDER scope=all -> a projection (scope=all admits read)", () => {
    // Proves the scope gate is the discriminator: only the scope changed, and the outcome flipped.
    const proj = buildProjectionForCall(
      { tool: "exec.readproj", args: { argv: ["true"] } },
      bindings,
      lookup,
      "all",
    );
    expect(proj).toBeDefined();
    expect(proj?.argv0).toBe("true");
  });
});

describe("buildProjectionForCall — out-of-scope / no projector / invalid args -> undefined", () => {
  it("exec.echo (read, NO projector) under scope=effectful -> undefined", () => {
    // NON-VACUITY: this is the scope+projector cut. A helper that built a projection for a read tool
    // (e.g. dropped the projector check / treated read as in-scope) would return a projection -> RED.
    const proj = buildProjectionForCall(
      { tool: "exec.echo", args: { text: "hello" } },
      bindings,
      lookup,
      "effectful",
    );
    expect(proj).toBeUndefined();
  });

  it("exec.echo (read) is out-of-scope EVEN under scope=all because it declares NO projector", () => {
    // exec.echo has no governanceProjector — even scope=all (which admits read) cannot synthesise one.
    const proj = buildProjectionForCall(
      { tool: "exec.echo", args: { text: "hello" } },
      bindings,
      lookup,
      "all",
    );
    expect(proj).toBeUndefined();
  });

  it("exec.run with INVALID args (fails argSchema) -> undefined (the effect would deny anyway)", () => {
    const proj = buildProjectionForCall(
      // argv must be a non-empty string[]; an empty array fails `.min(1)`, a smuggled key fails .strict().
      { tool: "exec.run", args: { argv: [], cmd: "rm -rf /" } },
      bindings,
      lookup,
      "effectful",
    );
    expect(proj).toBeUndefined();
  });

  it("an unregistered tool (no manifest) -> undefined", () => {
    const proj = buildProjectionForCall(
      { tool: "exec.unknown", args: {} },
      bindings,
      lookup,
      "effectful",
    );
    expect(proj).toBeUndefined();
  });

  it("ABSENT bindings (a surface with no exec bindings) -> undefined (byte-identical degrade)", () => {
    const proj = buildProjectionForCall(
      { tool: "exec.run", args: { argv: ["ls"] } },
      undefined,
      lookup,
      "effectful",
    );
    expect(proj).toBeUndefined();
  });
});

describe("buildProjectionForCall — credential-blind (built from validated args, R9b-1 redact)", () => {
  it("a canary in argv is best-effort redacted in the projection (no raw secret survives)", () => {
    const canary = skCanary();
    const proj = buildProjectionForCall(
      { tool: "exec.run", args: { argv: ["curl", canary, "https://api.example.com"] } },
      bindings,
      lookup,
      "effectful",
    );
    expect(proj).toBeDefined();
    const serialized = JSON.stringify(proj);
    expect(serialized).not.toContain(canary);
    expect(serialized).toContain("[REDACTED]");
  });
});

describe("runBinding — the exec.run binding declares a governanceProjector", () => {
  it("runBinding.governanceProjector is present and projects validated {argv}", () => {
    // The projector is a thin wrapper around buildExecRunProjection over the VALIDATED args.
    expect(runBinding.governanceProjector).toBeDefined();
    const proj = runBinding.governanceProjector?.({ argv: ["echo", "hi"] });
    expect(proj?.version).toBe(1);
    expect(proj?.argv0).toBe("echo");
  });
});
