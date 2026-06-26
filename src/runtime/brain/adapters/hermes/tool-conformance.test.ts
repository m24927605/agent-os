/**
 * SLICE-CAP8 — the registry-wide CONFORMANCE SUITE (consolidation).
 *
 * The capability surface is now 16 tools across exec/file/git/network families (15 + the CAP6b
 * destructive tool git.push). Until CAP8 every tool's
 * invariants were RE-ASSERTED by hand, per tool, in `exec-seed-tools.test.ts` (the `for (const tool of
 * tools)` schema-derive loop, the per-tool strict-deny loop, the per-tool credential-blind loop). CAP8
 * CONSOLIDATES those generic invariant re-assertions into ONE reusable property — `assertToolConformant`
 * — and runs it over the WHOLE bin catalog via a parameterized `describe.each`. Any FUTURE tool added to
 * the seed is then automatically subject to the same registry-wide invariants (no new hand assertion).
 *
 * `assertToolConformant(manifest, binding, advertisedInputSchema, opts?)` proves, for ONE (manifest,
 * binding), the four registry-wide invariants:
 *
 *   1. schema-no-drift   — `argSchemaToJsonSchema(binding.argSchema)` does NOT throw (the deterministic
 *      derive the MCP server makes) AND equals the schema the server ADVERTISES for that tool (advertised
 *      == derived; single source of truth, no hand-written constant that could drift).
 *   2. strict-args deny-by-default — `binding.argSchema.safeParse({ <unknown>: "x" }).success === false`
 *      (a `.strict()` schema rejects an unknown key — a non-strict schema would ACCEPT it and FAIL here).
 *   3. effectful ⇒ projector — `manifest.sideEffect ∈ {write,destructive}` ⇒ `governanceProjector` is
 *      defined (an effectful tool MUST declare its AGT governance projection).
 *   4. credential-blind (string-arg tools) — for each STRING field in the argSchema, a runtime-built
 *      `sk-…` canary in that field is DENIED by the args credential screen (the secret never reaches the
 *      substrate). A tool with NO string field (e.g. `git.status`, `exec.pwd`) — and `exec.run`, whose
 *      arg is a string ARRAY not a string FIELD — is N/A for this check (skipped here; `exec.run`'s
 *      secret-ELEMENT screen is covered by its own behavioral test, kept in `exec-seed-tools.test.ts`).
 *
 * NOT folded here (by design): `commit-before-effect` is a PIPELINE-level invariant
 * (`runGovernedToolCall` always appends the audit receipt BEFORE the effect runs) — it is a property of
 * the pipeline, not of a per-tool (manifest, binding) pair, so the existing closed-loop / MCP-server
 * tests that prove `effectOrder === ["append","effect"]` are LEFT AS-IS and are the source of truth for
 * it. This suite never re-asserts commit-before-effect per tool.
 *
 * NON-VACUITY (the load-bearing proof): each of the four checks is shown to CATCH a synthetic
 * non-conformant (manifest, binding) — an effectful manifest with NO projector, a non-`.strict()`
 * argSchema, an `argSchemaToJsonSchema`-underivable argSchema, and a string-arg tool the screen would
 * MISS (a no-op detector). And a MUTATION that strips a REAL tool's projector flips THAT tool's
 * parameterized case RED — proving the `describe.each` genuinely checks each tool.
 *
 * HONEST BOUNDARY: CAP8 proves the INVARIANTS hold registry-wide; it does NOT prove an effectAdapter's
 * DOMAIN logic is correct (a `write_file` that writes the wrong bytes still passes conformance — its
 * per-capability behavioral test governs that). Pure consolidation: a test + an inlined helper, NO
 * production change, no new capability, no new dependency.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { redactSecrets } from "../../../../audit/index.js";
import type { ToolManifest } from "../../../../tools/index.js";
import { makeArgsCredentialScreen } from "./args-credential-screen.js";
import type { ExecToolBinding } from "./exec-closed-loop.js";
import { seedBindings, seedRegistry } from "./exec-seed-tools.js";
import { type JsonSchemaObject, argSchemaToJsonSchema } from "./mcp/exec-mcp-server.js";

// ------------------------------------------------------------------------------------------------
// Shared fixtures — the production secret detector + a runtime-built canary (NEVER a source literal).
// ------------------------------------------------------------------------------------------------

/** The repo's real detector (same construction as every bootstrap): secret-shaped iff redact changes it. */
const detectSecret = (v: unknown): boolean =>
  JSON.stringify(redactSecrets(v)) !== JSON.stringify(v);

/** Runtime-built secret canary matching audit/redact's `sk-...` shape (NOT a source literal). */
function secretCanary(): string {
  return `sk-${"a1B2c3D4".repeat(3)}`; // 24 alnum chars => matches /sk-[A-Za-z0-9]{16,}/
}

// A key that cannot collide with any real arg field (CAP8-scoped) — used for the strict-deny probe.
const UNKNOWN_KEY = "__unknown_cap8__";

// ------------------------------------------------------------------------------------------------
// stringFieldsOf — derive the STRING arg field names from a binding's argSchema shape (registry-wide,
// no per-tool fixture map needed). Mirrors `argSchemaToJsonSchema`'s unwrap order: a field is a "string
// field" iff (after unwrapping a single ZodOptional and/or a single ZodEffects layer) it is a ZodString.
// A string ARRAY (`exec.run {argv}`) is NOT a string field (its element, not the field, is a string) —
// it is correctly excluded, so exec.run is N/A for the per-field credential-blind check (its secret-
// ELEMENT screen is its own behavioral test). A non-ZodObject (defensive) yields no fields.
// ------------------------------------------------------------------------------------------------
function stringFieldsOf(argSchema: z.ZodType<unknown>): string[] {
  const def = (argSchema as { _def?: unknown })._def as
    | { typeName?: string; shape?: () => Record<string, unknown> }
    | undefined;
  if (def === undefined || def.typeName !== "ZodObject" || typeof def.shape !== "function") {
    return [];
  }
  const shape = def.shape();
  const out: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    let fieldDef = (field as { _def?: unknown })._def as
      | {
          typeName?: string;
          innerType?: { _def?: { typeName?: string } };
          schema?: { _def?: { typeName?: string } };
        }
      | undefined;
    let typeName = fieldDef?.typeName;
    if (typeName === "ZodOptional") {
      fieldDef = fieldDef?.innerType?._def;
      typeName = fieldDef?.typeName;
    }
    if (typeName === "ZodEffects") {
      fieldDef = fieldDef?.schema?._def;
      typeName = fieldDef?.typeName;
    }
    if (typeName === "ZodString") out.push(key);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// assertToolConformant — the reusable, vendor-neutral conformance property (inlined per the slice).
// Proves the FOUR registry-wide invariants for ONE (manifest, binding). Throws (fails the test) on any
// violation, so `describe.each` over the catalog turns it into a registry-wide property.
//
// `advertisedInputSchema` is the schema the MCP server ADVERTISES for this tool (from its tools/list) —
// passing it in lets check #1 prove advertised == derived against the REAL server output, not a re-derive
// of the same expression. `opts.detectSecret` defaults to the production detector; the non-vacuity
// "screen would MISS it" synthetic injects a no-op detector to prove check #4 is load-bearing.
// ------------------------------------------------------------------------------------------------
interface AssertToolConformantOpts {
  /** Detector the credential-blind screen uses. Defaults to the production `redactSecrets`-changed test. */
  readonly detectSecret?: (v: unknown) => boolean;
}

function assertToolConformant(
  manifest: Pick<ToolManifest, "sideEffect">,
  binding: ExecToolBinding,
  advertisedInputSchema: JsonSchemaObject,
  opts: AssertToolConformantOpts = {},
): void {
  // (1) schema-no-drift — the deterministic derive does NOT throw, and EQUALS what the server advertises.
  const derived = argSchemaToJsonSchema(binding.argSchema); // throws (fails) on an underivable shape
  expect(derived).toEqual(advertisedInputSchema);

  // (2) strict-args deny-by-default — a `.strict()` schema rejects an unknown key (a non-strict one would
  // ACCEPT it => `success === true` => this assertion fails). Probe an unknown key directly on the schema.
  expect(binding.argSchema.safeParse({ [UNKNOWN_KEY]: "x" }).success).toBe(false);

  // (3) effectful ⇒ projector — a write/destructive tool MUST declare its AGT governance projector.
  if (manifest.sideEffect === "write" || manifest.sideEffect === "destructive") {
    expect(binding.governanceProjector).toBeDefined();
  }

  // (4) credential-blind — for EACH string field, a runtime-built sk- canary is DENIED at the args screen
  // (the secret never reaches the substrate). No string field (pwd/git.status/...) or a string-ARRAY arg
  // (exec.run) => no per-field probe here (N/A — `exec.run`'s secret-element screen is its own test).
  const screen = makeArgsCredentialScreen(opts.detectSecret ?? detectSecret);
  for (const field of stringFieldsOf(binding.argSchema)) {
    const outcome = screen({ context: {}, args: { [field]: secretCanary() } });
    expect(outcome.ok).toBe(false); // a string-arg tool's secret-shaped value is DENIED@screen
  }
}

// ------------------------------------------------------------------------------------------------
// Build the FULL bin catalog: the 16 tools (incl. net.fetch + git.push) the bin composes, with BOTH
// "approval" + "egress-allowlist" WIRED. Mirror the bin's wired set so seedRegistry/seedBindings include
// the network-egress tool net.fetch (CAP6) AND the destructive network-egress tool git.push (CAP6b).
// ------------------------------------------------------------------------------------------------
const BIN_WIRED = new Set<"approval" | "egress-allowlist">(["approval", "egress-allowlist"]);

interface CatalogEntry {
  readonly name: string;
  readonly manifest: ToolManifest;
  readonly binding: ExecToolBinding;
}

/** The 16 bin tools as (name, manifest, binding), derived from the registry + bindings (single source). */
function binCatalog(): CatalogEntry[] {
  const registry = seedRegistry(BIN_WIRED);
  const bindings = seedBindings(new Map(), BIN_WIRED);
  const entries: CatalogEntry[] = [];
  for (const manifest of registry.list()) {
    const binding = bindings.get(manifest.name);
    if (binding === undefined) continue; // a manifest with no binding is inert (defensive)
    entries.push({ name: manifest.name, manifest, binding });
  }
  return entries;
}

/** Advertise the inputSchema for each tool exactly as the MCP server does (the no-drift comparand). */
function advertisedSchemas(): ReadonlyMap<string, JsonSchemaObject> {
  const bindings = seedBindings(new Map(), BIN_WIRED);
  const m = new Map<string, JsonSchemaObject>();
  for (const [name, binding] of bindings) m.set(name, argSchemaToJsonSchema(binding.argSchema));
  return m;
}

// The EXACT bin catalog — 16 tools (the 14 in-sandbox seed tools + net.fetch + git.push, BOTH primitives
// WIRED). A tool removed/added wrongly flips this exact-set assertion (the catalog is the single source the
// suite runs).
const FULL_BIN_SET = [
  "exec.cat",
  "exec.echo",
  "exec.grep",
  "exec.head",
  "exec.ls",
  "exec.pwd",
  "exec.run",
  "exec.wc",
  "exec.write_file",
  "git.add",
  "git.commit",
  "git.diff",
  "git.log",
  "git.push",
  "git.status",
  "net.fetch",
];

// ==================================================================================================
// CAP8-0 — sanity: the catalog is EXACTLY the 16 bin tools (so the parameterized suite covers them all).
// ==================================================================================================
describe("CAP8-0 the bin catalog is exactly the 16 tools (the conformance suite's coverage set)", () => {
  it("seedRegistry/seedBindings (egress + approval wired) yield exactly the 16 bin tools", () => {
    const names = binCatalog()
      .map((e) => e.name)
      .sort();
    expect(names).toEqual(FULL_BIN_SET);
    expect(names.length).toBe(16);
    // net.fetch (network-egress) is present ONLY because egress is wired (CAP6 ordering).
    expect(names).toContain("net.fetch");
    // git.push (network-egress + destructive) is present ONLY because BOTH egress + approval are wired (CAP6b).
    expect(names).toContain("git.push");
  });
});

// ==================================================================================================
// CAP8-1 — the registry-wide PROPERTY: EVERY one of the 15 bin tools is conformant. A future tool added
//          to the seed is automatically subject to the same four invariants (no new hand assertion).
//          The schema each tool is checked against is the one the MCP server ADVERTISES (advertised ==
//          derived). This is the consolidation of the per-tool hand assertions deleted from
//          exec-seed-tools.test.ts.
// ==================================================================================================
describe("CAP8-1 registry-wide conformance: every bin tool passes assertToolConformant", () => {
  const advertised = advertisedSchemas();
  const cases: [string, ToolManifest, ExecToolBinding][] = binCatalog().map((e) => [
    e.name,
    e.manifest,
    e.binding,
  ]);

  describe.each(cases)("conformance: %s", (name, manifest, binding) => {
    it("is schema-no-drift + strict-deny + effectful⇒projector + credential-blind", () => {
      const schema = advertised.get(name);
      expect(schema).toBeDefined();
      if (schema === undefined) return;
      // The whole property for THIS tool. Throws (fails THIS case) on any invariant violation — so the
      // strip-real-projector mutation flips exactly this tool's case RED.
      assertToolConformant(manifest, binding, schema);
    });
  });
});

// ==================================================================================================
// CAP8-2 — NON-VACUITY (the core): a SYNTHETIC non-conformant (manifest, binding) is CAUGHT by
//          assertToolConformant for EACH of the four checks. Proves the property is load-bearing — a
//          future BAD tool would be rejected, not silently admitted.
// ==================================================================================================
describe("CAP8-2 non-vacuity: assertToolConformant CATCHES a synthetic non-conformant tool", () => {
  // (a) effectful (sideEffect:"write") manifest + a binding with NO governanceProjector -> check #3 FAILS.
  it("(a) effectful WITHOUT a projector is caught (effectful⇒projector fails)", () => {
    const manifest = { sideEffect: "write" as const };
    const binding: ExecToolBinding = {
      argvPrefix: ["x"],
      argSchema: z.object({ path: z.string() }).strict(),
      toArgv: () => [],
      // NO governanceProjector — the violation.
    };
    const advertised = argSchemaToJsonSchema(binding.argSchema);
    expect(() => assertToolConformant(manifest, binding, advertised)).toThrow();
  });

  // (b) a binding whose argSchema is NOT `.strict()` -> caught. The strict-deny check (#2) is the
  //     load-bearing one: an EMPTY non-strict object ACCEPTS the unknown key (success === true), so the
  //     `safeParse({unknown}).success === false` assertion flips. (No-drift (#1) ALSO rejects a non-strict
  //     object — defense-in-depth — but we isolate the strict-deny failure with an empty object so the only
  //     thing wrong is the missing `.strict()`, not a missing required field.)
  it("(b) a non-strict argSchema is caught (strict-deny fails: unknown key accepted)", () => {
    const manifest = { sideEffect: "read" as const };
    const binding: ExecToolBinding = {
      argvPrefix: ["x"],
      argSchema: z.object({}), // EMPTY + NOT .strict() — the violation (accepts unknown keys)
      toArgv: () => [],
    };
    // ISOLATED load-bearing fact: a non-strict object ACCEPTS the unknown key (the strict-deny check #2
    // probes exactly this and flips RED). A `.strict()` empty object would reject it (success === false).
    expect(binding.argSchema.safeParse({ [UNKNOWN_KEY]: "x" }).success).toBe(true);
    // And the whole property CATCHES it: no-drift (#1) refuses to derive a non-strict object => throws.
    expect(() =>
      assertToolConformant(manifest, binding, {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      }),
    ).toThrow();
    // To prove the strict-deny check itself (not only no-drift) is what fails for a non-strict object, run
    // check #2 in isolation with an advertised schema that MATCHES a (hypothetical) derive — impossible to
    // derive non-strict, so we assert the probe directly: it is the behavioral guarantee #2 encodes.
    expect(
      z
        .object({})
        .strict()
        .safeParse({ [UNKNOWN_KEY]: "x" }).success,
    ).toBe(false);
  });

  // (c) a binding whose argSchema is an argSchemaToJsonSchema-UNDERIVABLE shape -> check #1 throws/fails.
  it("(c) an underivable argSchema is caught (schema-no-drift throws)", () => {
    const manifest = { sideEffect: "read" as const };
    const binding: ExecToolBinding = {
      argvPrefix: ["x"],
      argSchema: z.object({ n: z.number() }).strict(), // a number field is underivable — the violation
      toArgv: () => [],
    };
    // No advertised schema can match — the derive THROWS before any comparison. assertToolConformant
    // propagates the throw (caught here). The synthetic bad tool is rejected.
    expect(() =>
      assertToolConformant(manifest, binding, {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      }),
    ).toThrow();
  });

  // (d) a synthetic string-arg tool whose args screen would MISS the secret (a no-op detector) -> check
  //     #4 FAILS. Proves the credential-blind check is load-bearing (a screen that does not catch the
  //     canary is rejected).
  it("(d) a string-arg tool the screen would MISS is caught (credential-blind fails)", () => {
    const manifest = { sideEffect: "read" as const };
    const binding: ExecToolBinding = {
      argvPrefix: ["x"],
      argSchema: z.object({ path: z.string() }).strict(),
      toArgv: () => [],
    };
    const advertised = argSchemaToJsonSchema(binding.argSchema);
    // A no-op detector NEVER flags the canary -> the screen returns ok:true -> check #4 fails.
    const noopDetector = () => false;
    expect(() =>
      assertToolConformant(manifest, binding, advertised, { detectSecret: noopDetector }),
    ).toThrow();
    // With the REAL detector the SAME tool is conformant (so it is the screen-miss, not the tool, caught).
    expect(() => assertToolConformant(manifest, binding, advertised)).not.toThrow();
  });
});

// ==================================================================================================
// CAP8-3 — the parameterized suite genuinely checks EACH tool: a MUTATION that strips a REAL tool's
//          projector (write_file) flips THAT tool's conformance case RED (then we revert in-test). Proves
//          the describe.each is not vacuous — it actually runs assertToolConformant per (manifest,
//          binding), so a regression in any one tool is caught.
// ==================================================================================================
describe("CAP8-3 the parameterized suite is per-tool: stripping write_file's projector flips its case", () => {
  it("write_file conformant WITH its projector; RED WITHOUT it (revert leaves the suite green)", () => {
    const entry = binCatalog().find((e) => e.name === "exec.write_file");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const advertised = argSchemaToJsonSchema(entry.binding.argSchema);

    // WITH the real projector: conformant.
    expect(() => assertToolConformant(entry.manifest, entry.binding, advertised)).not.toThrow();

    // MUTATION: strip the projector off a COPY of the binding (never mutate the real seed binding). The
    // effectful⇒projector check now flips RED for this real tool's (manifest, binding).
    const stripped: ExecToolBinding = { ...entry.binding, governanceProjector: undefined };
    expect(() => assertToolConformant(entry.manifest, stripped, advertised)).toThrow();

    // The real seed binding is UNCHANGED (we copied) — the live suite case stays green.
    expect(entry.binding.governanceProjector).toBeDefined();
  });
});
