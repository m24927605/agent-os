/**
 * SLICE-CAP6b (RED-first) — `git.push` (`git push -- <url> <branch>`), the FIRST real DESTRUCTIVE tool.
 *
 * CAP2 DEFERRED git.push: its egress target is not argv-visible (a remote NAME), it needs the egress
 * primitive (CAP5/6) AND the approval gate (CAP4). CAP6b unblocks it by taking an EXPLICIT https URL
 * (`{url, branch}`) instead of a remote name — so the URL host is IN argv and PROJECTABLE (the egress fold
 * can gate it AND it clears CAP6's "network-egress with no projectable host => deny" fail-closed rule).
 * git.push is the FIRST tool that is BOTH `sideEffect:"destructive"` (=> manifest superRefine FORCES
 * `requiresApproval:true`) AND `containment:"network-egress"` (=> needs "egress-allowlist" wired) — so it
 * needs BOTH "approval" AND "egress-allowlist" wired to register (CAP3). The bin wires both.
 *
 * This file pins the TOOL-LEVEL invariants (the bin END-TO-END approval + egress + boundary gates live in
 * the sibling `mcp/exec-mcp-server-bin.cap6b.test.ts`):
 *   - REGISTRATION-GATED — a registry missing EITHER "approval" OR "egress-allowlist" REFUSES git.push
 *     (CAP3 gate, fail-closed); a registry wired with BOTH REGISTERS it. The DEFAULT empty-wired
 *     `seedRegistry()` does NOT carry git.push (no egress wired).
 *   - DESTRUCTIVE ⇒ requiresApproval — the manifest's superRefine FORCES requiresApproval:true; a
 *     `sideEffect:"destructive"` + `requiresApproval:false` manifest THROWS at `parseToolManifest`.
 *   - ARGV / STRICT / NO-SHELL — `git.push {url,branch}` builds argv EXACTLY
 *     `["git","push","--",<url>,<branch>]` (the `--` guards a `-`-leading repo arg — verified valid git
 *     syntax); an unknown key denies (strict); a `branch` that is a flag (`--force`/`-d`), has whitespace,
 *     or is empty is REJECTED (no flag injection); a `url` that is `file://` / userinfo / IP-literal is
 *     REJECTED (`isAllowedFetchUrl` reuse).
 *   - NETWORKHOSTS PROJECTION — git.push's `governanceProjector` projects `networkHosts = [URL host]`
 *     (reusing net.fetch's EXACT hostname projector, so the projected host == git's real connect host).
 *   - IN-SCOPE — git.push (containment:"network-egress", sideEffect:"destructive") is IN-SCOPE for
 *     `buildProjectionForCall` under the default `effectful` scope.
 *   - CREDENTIAL PLACEHOLDER — git.push's OPTIONAL `toEnv` emits a CREDENTIAL PLACEHOLDER
 *     (`placeholderForKey`, NEVER a literal secret); `makeExecEffect`'s INPUT guard PASSES the placeholder
 *     and REJECTS a literal secret env value (substrate 0 calls).
 *
 * Proven against a FAKE substrate that RECORDS the exec request (argv + env). NO live, NO real Hermes, NO
 * real git, NO real network, NO real push — the approval + egress GATING + boundary record + credential
 * placeholder are real IN-REPO; the real push reaching a remote + the SecretResolver-at-egress credential
 * resolution are deploy/EXEC2-gated (git.push is unauthenticated-to-allowlisted until EXEC2).
 */
import { describe, expect, it } from "vitest";
import { placeholderForKey } from "../../../../credential/index.js";
import { buildExecRunProjection } from "../../../../policy/index.js";
import { type Primitive, ToolRegistry, parseToolManifest } from "../../../../tools/index.js";
import {
  type AdapterResult,
  type ExecCommandSpec,
  type ExecResult,
  FakeSandboxAdapter,
  type SandboxSpec,
  makeExecEffect,
} from "../../../substrate/index.js";
import { gitPushBinding, gitPushManifest, seedBindings, seedRegistry } from "./exec-seed-tools.js";
import { type AgtScope, buildProjectionForCall } from "./governance-projection-for-call.js";

const validCtx = {
  actorId: "agent:hermes",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

/** The wired set the BIN uses: BOTH primitives (so git.push — destructive + network-egress — registers). */
const BIN_WIRED: ReadonlySet<Primitive> = new Set<Primitive>(["approval", "egress-allowlist"]);
/** Only egress wired (missing "approval") — must REFUSE git.push (destructive needs approval). */
const EGRESS_ONLY: ReadonlySet<Primitive> = new Set<Primitive>(["egress-allowlist"]);
/** Only approval wired (missing "egress-allowlist") — must REFUSE git.push (network-egress needs it). */
const APPROVAL_ONLY: ReadonlySet<Primitive> = new Set<Primitive>(["approval"]);

/** Runtime-built secret canary matching audit/redact's `sk-...` shape (NOT a source literal). */
function secretCanary(): string {
  return `sk-${"a1B2c3D4".repeat(3)}`; // 24 alnum chars => matches /sk-[A-Za-z0-9]{16,}/
}

/** The credential env KEY env var the bin's toEnv emits a placeholder for (mirrors net.fetch's). */
const GIT_PUSH_AUTH_KEY_ENV = "AGENTOS_GIT_PUSH_AUTH_KEY";

/** A spying Fake substrate that records argv + env per exec call. */
class SpyFakeSandboxAdapter extends FakeSandboxAdapter {
  readonly execCalls: ExecCommandSpec[] = [];
  override createSandbox(ctx: unknown, spec: SandboxSpec): Promise<AdapterResult> {
    return super.createSandbox(ctx, spec);
  }
  override execSandbox(
    ctx: unknown,
    sandboxId: string,
    spec: ExecCommandSpec,
  ): Promise<ExecResult> {
    this.execCalls.push(spec);
    return super.execSandbox(ctx, sandboxId, spec);
  }
}

// ==================================================================================================
// CAP6b-(a) REGISTRATION-GATED — git.push is `containment:"network-egress"` + `sideEffect:"destructive"`
//   => requires BOTH "egress-allowlist" AND "approval". A registry missing EITHER REFUSES it (CAP3 gate,
//   fail-closed); a registry wired with BOTH REGISTERS it. The DEFAULT empty-wired `seedRegistry()` does
//   NOT carry git.push.
//   NON-VACUITY: dropping a primitive from the required set would let an under-wired composition register
//   the first destructive network tool — the "refuses" assertions flip RED.
// ==================================================================================================
describe("CAP6b-(a) git.push registration is GATED on BOTH approval + egress-allowlist (CAP3 gate)", () => {
  it("a registry with DEFAULT empty wired THROWS (both primitives unwired)", () => {
    expect(() => new ToolRegistry([{ ...gitPushManifest }])).toThrow();
    const reg = new ToolRegistry(undefined); // default empty wired
    expect(() => reg.register({ ...gitPushManifest })).toThrow();
    expect(reg.has("git.push")).toBe(false);
  });

  it("a registry wired with ONLY egress (missing approval) REFUSES git.push", () => {
    expect(() => new ToolRegistry([{ ...gitPushManifest }], EGRESS_ONLY)).toThrow();
    const reg = new ToolRegistry(undefined, EGRESS_ONLY);
    expect(() => reg.register({ ...gitPushManifest })).toThrow();
    expect(reg.has("git.push")).toBe(false);
  });

  it("a registry wired with ONLY approval (missing egress) REFUSES git.push", () => {
    expect(() => new ToolRegistry([{ ...gitPushManifest }], APPROVAL_ONLY)).toThrow();
    const reg = new ToolRegistry(undefined, APPROVAL_ONLY);
    expect(() => reg.register({ ...gitPushManifest })).toThrow();
    expect(reg.has("git.push")).toBe(false);
  });

  it("a registry wired with BOTH approval + egress-allowlist REGISTERS git.push", () => {
    const reg = new ToolRegistry([{ ...gitPushManifest }], BIN_WIRED);
    expect(reg.has("git.push")).toBe(true);
    expect(reg.lookup("git.push")?.containment).toBe("network-egress");
    expect(reg.lookup("git.push")?.sideEffect).toBe("destructive");
  });

  it("seedRegistry/seedBindings carry git.push ONLY when BOTH primitives are WIRED (else not)", () => {
    // DEFAULT (nothing wired) => git.push NOT registered/bound.
    expect(seedRegistry().has("git.push")).toBe(false);
    expect(seedBindings().get("git.push")).toBeUndefined();
    // ONLY egress wired (no approval) => git.push NOT registered/bound (would fail CAP3 if it tried).
    expect(seedRegistry(EGRESS_ONLY).has("git.push")).toBe(false);
    expect(seedBindings(new Map(), EGRESS_ONLY).get("git.push")).toBeUndefined();
    // ONLY approval wired (no egress) => git.push NOT registered/bound.
    expect(seedRegistry(APPROVAL_ONLY).has("git.push")).toBe(false);
    expect(seedBindings(new Map(), APPROVAL_ONLY).get("git.push")).toBeUndefined();
    // BOTH wired (what the bin passes) => git.push registered + bound.
    const reg = seedRegistry(BIN_WIRED);
    expect(reg.has("git.push")).toBe(true);
    expect(seedBindings(new Map(), BIN_WIRED).get("git.push")).toBe(gitPushBinding);
  });
});

// ==================================================================================================
// CAP6b-(b) MANIFEST posture + DESTRUCTIVE ⇒ requiresApproval — git.push is network-egress, destructive,
//   NOT idempotent, requiresApproval:true (FORCED by the manifest superRefine). A destructive manifest
//   with requiresApproval:false THROWS at parseToolManifest.
//   NON-VACUITY: a flipped containment/sideEffect/requiresApproval flips these RED; the superRefine
//   throw-on-false is the mutation guard for "destructive cannot escape approval".
// ==================================================================================================
describe("CAP6b-(b) the git.push manifest declares the network-egress DESTRUCTIVE approval-gated posture", () => {
  it("containment network-egress, sideEffect destructive, idempotent false, requiresApproval true", () => {
    expect(gitPushManifest.name).toBe("git.push");
    expect(gitPushManifest.containment).toBe("network-egress");
    expect(gitPushManifest.sideEffect).toBe("destructive");
    expect(gitPushManifest.idempotent).toBe(false);
    expect(gitPushManifest.requiresApproval).toBe(true);
  });

  it("the REAL git.push manifest PARSES (it is a valid destructive+approval manifest)", () => {
    expect(() => parseToolManifest({ ...gitPushManifest })).not.toThrow();
  });

  it("a destructive manifest with requiresApproval:false THROWS at parseToolManifest (superRefine)", () => {
    // The superRefine guard B: sideEffect "destructive" implies requiresApproval:true — so the only way to
    // model git.push is requiresApproval:true. Attempting requiresApproval:false is REJECTED by parse.
    expect(() => parseToolManifest({ ...gitPushManifest, requiresApproval: false })).toThrow();
  });
});

// ==================================================================================================
// CAP6b-(c) ARGV / NO-SHELL — the binding builds argv EXACTLY ["git","push","--",<url>,<branch>]. The `--`
//   guards a `-`-leading repo arg (verified valid `git push` syntax); url + branch are SINGLE literal
//   tokens (no flag injection, no shell). NON-VACUITY: dropping `--`, or splitting/reordering, flips RED.
// ==================================================================================================
describe("CAP6b-(c) git.push builds its EXACT argv from the binding (`--` guard, no shell)", () => {
  it("git.push {url,branch} -> argv EXACTLY [git,push,--,<url>,<branch>]", () => {
    const parsed = gitPushBinding.argSchema.safeParse({
      url: "https://github.com/o/r.git",
      branch: "main",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const argv = [...gitPushBinding.argvPrefix, ...gitPushBinding.toArgv(parsed.data)];
    expect(argv).toEqual(["git", "push", "--", "https://github.com/o/r.git", "main"]);
    expect(argv[0]).toBe("git");
    expect(argv[1]).toBe("push");
    expect(argv[2]).toBe("--"); // the `--` guard immediately precedes the repo arg
    // No shell wrapper, ever.
    expect(argv).not.toContain("sh");
    expect(argv).not.toContain("-c");
    expect(argv).not.toContain("bash");
  });

  it("strict argSchema: an unknown key denies; missing/empty fields deny", () => {
    expect(
      gitPushBinding.argSchema.safeParse({
        url: "https://github.com/o/r.git",
        branch: "main",
        argv: "; rm -rf /",
      }).success,
    ).toBe(false);
    expect(gitPushBinding.argSchema.safeParse({}).success).toBe(false);
    expect(gitPushBinding.argSchema.safeParse({ url: "https://github.com/o/r.git" }).success).toBe(
      false,
    );
    expect(gitPushBinding.argSchema.safeParse({ branch: "main" }).success).toBe(false);
  });

  // ⚠️ NO-FLAG-INJECTION (branch): a branch that is a git FLAG (`--force`/`-d`), has whitespace, or is
  // empty is REJECTED by the strict branch regex (`^[A-Za-z0-9._/-]+$` AND not starting with `-`). So even
  // though `--` guards the repo arg, the branch can never be coerced into a `git push` flag.
  it("DENIES a branch that is a flag / has whitespace / is empty (no flag injection)", () => {
    for (const branch of [
      "--force", // a destructive git push flag
      "--delete", // ref deletion
      "-d", // short delete flag
      "-f",
      "--mirror",
      "a b", // whitespace (would split into two tokens conceptually; the regex denies it outright)
      "main\nfeature", // newline injection
      "", // empty
      "feat;rm -rf /", // shell metachar
      "feat$(whoami)",
      "branch with space",
    ]) {
      expect(
        gitPushBinding.argSchema.safeParse({ url: "https://github.com/o/r.git", branch }).success,
      ).toBe(false);
    }
  });

  it("ADMITS a plain branch name (letters/digits/dot/underscore/slash/dash, no leading dash)", () => {
    for (const branch of ["main", "feature/x", "release-1.2.3", "v2_beta", "a.b.c", "x/y/z"]) {
      expect(
        gitPushBinding.argSchema.safeParse({ url: "https://github.com/o/r.git", branch }).success,
      ).toBe(true);
    }
  });

  // ⚠️ URL VALIDATION (isAllowedFetchUrl reuse): a non-https / userinfo / IP-literal / host-less URL is
  // REJECTED at the argSchema (the SAME validator net.fetch uses), so EVERY admitted url is an https URL
  // with a plain DNS host whose projected token == git's real connect host.
  it("DENIES a non-https / userinfo / IP-ambiguous / host-less URL (isAllowedFetchUrl reuse)", () => {
    for (const url of [
      "file:///etc/passwd", // no authority / non-http
      "ssh://git@github.com/o/r.git", // SSH (out of scope; non-http)
      "git@github.com:o/r.git", // scp-like (unparseable as URL)
      "ftp://host.example/x",
      "http://", // host-less
      "/relative/path",
      "not a url",
      "https://user:pass@github.com/o/r.git", // userinfo credential in the URL
      "http://2130706433/r.git", // integer IP
      "http://0x7f000001/r.git", // hex IP
      "http://127.0.0.1/r.git", // dotted IP literal
      "http://[::1]/r.git", // bracketed IPv6
    ]) {
      expect(gitPushBinding.argSchema.safeParse({ url, branch: "main" }).success).toBe(false);
    }
  });

  it("ADMITS a plain http/https git URL (with port / path) — each produces a host", () => {
    for (const url of [
      "https://github.com/o/r.git",
      "http://localhost:8080/o/r.git",
      "https://git.allowed.example:8443/team/repo.git",
    ]) {
      expect(gitPushBinding.argSchema.safeParse({ url, branch: "main" }).success).toBe(true);
    }
  });
});

// ==================================================================================================
// CAP6b-(d) NETWORKHOSTS PROJECTION — git.push's governanceProjector projects networkHosts = [URL host]
//   (reusing net.fetch's EXACT hostname projection, NOT buildExecRunProjection's raw token), so the
//   projected host == git's real connect host. NON-VACUITY: removing the projector yields no projection ->
//   the network-egress fail-closed gate denies (the bin test exercises this).
// ==================================================================================================
describe("CAP6b-(d) git.push projects networkHosts = the URL host (bare, no port)", () => {
  it("projector(validated {url,branch}) carries networkHosts = the BARE URL host (no port)", () => {
    expect(gitPushBinding.governanceProjector).toBeDefined();
    const parsed = gitPushBinding.argSchema.safeParse({
      url: "https://git.allowed.example:8443/team/repo.git",
      branch: "main",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success || gitPushBinding.governanceProjector === undefined) return;
    const projection = gitPushBinding.governanceProjector(parsed.data);
    // The BARE host — so a host-only allowlist entry `git.allowed.example` matches the ported URL.
    expect(projection.networkHosts).toEqual(["git.allowed.example"]);
    // Apart from the host-only networkHosts override, it matches the canonical builder over the argv.
    const base = buildExecRunProjection({
      argv: ["git", "push", "--", "https://git.allowed.example:8443/team/repo.git", "main"],
    });
    expect(projection).toEqual({ ...base, networkHosts: ["git.allowed.example"] });
  });
});

// ==================================================================================================
// CAP6b-(e) IN-SCOPE — git.push (containment:"network-egress", sideEffect:"destructive") is IN-SCOPE for
//   buildProjectionForCall under the DEFAULT `effectful` scope, so its networkHosts reach the bin egress
//   fold. NON-VACUITY: if isInScope ignored network-egress/destructive, the projection would be undefined
//   and the egress fold could never gate it.
// ==================================================================================================
describe("CAP6b-(e) git.push is IN-SCOPE for projection under the default `effectful` scope", () => {
  it("buildProjectionForCall(git.push) returns a projection carrying networkHosts (default scope)", () => {
    const registry = seedRegistry(BIN_WIRED);
    const bindings = seedBindings(new Map(), BIN_WIRED);
    const scope: AgtScope = "effectful";
    const projection = buildProjectionForCall(
      { tool: "git.push", args: { url: "https://github.com/o/r.git", branch: "main" } },
      bindings,
      (n) => registry.lookup(n),
      scope,
    );
    expect(projection).toBeDefined();
    expect(projection?.networkHosts).toEqual(["github.com"]);
  });
});

// ==================================================================================================
// SLICE-EXEC-HARDENING (CAP6b MINOR) — git.push branch + url LENGTH CAPS (`.max()`). PURE TIGHTENING:
//   the branch gains `.max(255)` (the git ref practical limit) AFTER the SAFE_BRANCH_NAME regex; the url
//   gains `.max(2048)` within its refine chain. Existing SHORT branch/url values are UNAFFECTED
//   (byte-identical) — these are an upper bound, not a relaxation.
//   NON-VACUITY: dropping a `.max()` makes the over-length input ACCEPTED again => the "rejects" assertion
//   flips RED.
// ==================================================================================================
describe("SLICE-EXEC-HARDENING — git.push branch + url length caps (.max(), pure tightening)", () => {
  /** A valid-charset branch of exactly `n` chars (SAFE_BRANCH_NAME: alnum, no leading dash). */
  function branchOfLength(n: number): string {
    return "a".repeat(n);
  }

  it("REJECTS a branch of 256 chars (over the .max(255) cap), even though the charset is valid", () => {
    const branch = branchOfLength(256);
    expect(branch.length).toBe(256);
    // The charset is fine (all 'a', no leading dash — mirrors the production SAFE_BRANCH_NAME shape);
    // ONLY the length cap rejects it. (Local regex twin so the test doesn't widen the module's exports.)
    expect(/^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/.test(branch)).toBe(true);
    expect(
      gitPushBinding.argSchema.safeParse({ url: "https://github.com/o/r.git", branch }).success,
    ).toBe(false);
  });

  it("ACCEPTS a valid branch of exactly 255 chars (the boundary; the cap is inclusive)", () => {
    const branch = branchOfLength(255);
    expect(branch.length).toBe(255);
    expect(
      gitPushBinding.argSchema.safeParse({ url: "https://github.com/o/r.git", branch }).success,
    ).toBe(true);
  });

  it("REJECTS a url longer than .max(2048) (even an otherwise-valid https plain-DNS URL)", () => {
    // A valid https URL whose path pushes the total length over 2048 — the host is plain-DNS + allowlisted-
    // shape, so ONLY the length cap can reject it.
    const longPath = "x".repeat(2100);
    const url = `https://api.allowed.example/${longPath}`;
    expect(url.length).toBeGreaterThan(2048);
    expect(gitPushBinding.argSchema.safeParse({ url, branch: "main" }).success).toBe(false);
  });

  it("ACCEPTS a normal short url (well under the cap) — byte-identical to today", () => {
    expect(
      gitPushBinding.argSchema.safeParse({
        url: "https://github.com/o/r.git",
        branch: "main",
      }).success,
    ).toBe(true);
  });

  it("the EXISTING short branch ('main') + url is still ACCEPTED (byte-identical; caps only bound the top)", () => {
    const parsed = gitPushBinding.argSchema.safeParse({
      url: "https://github.com/o/r.git",
      branch: "main",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // The argv is unchanged by the caps.
    const argv = [...gitPushBinding.argvPrefix, ...gitPushBinding.toArgv(parsed.data)];
    expect(argv).toEqual(["git", "push", "--", "https://github.com/o/r.git", "main"]);
  });
});

// ==================================================================================================
// CAP6b-(f) ⚠️ CREDENTIAL PLACEHOLDER — git.push's OPTIONAL `toEnv` emits a CREDENTIAL PLACEHOLDER (never a
//   literal secret). makeExecEffect's INPUT guard PASSES the placeholder env and runs the effect; a LITERAL
//   secret injected into the env is REJECTED (substrate 0 calls). This exercises the placeholder seam that
//   EXEC2's SecretResolver-at-egress will resolve.
//   NON-VACUITY: a toEnv that emitted a literal secret would be rejected by the same guard.
// ==================================================================================================
describe("CAP6b-(f) git.push's toEnv emits a credential PLACEHOLDER (never a literal secret); the env guard agrees", () => {
  it("the binding's toEnv reads the env-configured auth key (default: NO env when unset)", () => {
    expect(gitPushBinding.toEnv).toBeDefined();
    if (gitPushBinding.toEnv === undefined) return;
    const parsed = gitPushBinding.argSchema.safeParse({
      url: "https://github.com/o/r.git",
      branch: "main",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const prev = process.env[GIT_PUSH_AUTH_KEY_ENV];
    try {
      // Unset => no env (default; unauthenticated-to-allowlisted).
      delete process.env[GIT_PUSH_AUTH_KEY_ENV];
      expect(gitPushBinding.toEnv(parsed.data)).toEqual({});
      // Configured => the placeholder for that key (NEVER a literal secret).
      process.env[GIT_PUSH_AUTH_KEY_ENV] = "GIT_PUSH_TOKEN";
      const env = gitPushBinding.toEnv(parsed.data);
      expect(env.GIT_PUSH_TOKEN).toBe(placeholderForKey("GIT_PUSH_TOKEN"));
      expect(env.GIT_PUSH_TOKEN).toMatch(/^openshell:resolve:env:/);
      // No env value carries a secret SHAPE.
      expect(JSON.stringify(env)).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    } finally {
      if (prev === undefined) delete process.env[GIT_PUSH_AUTH_KEY_ENV];
      else process.env[GIT_PUSH_AUTH_KEY_ENV] = prev;
    }
  });

  it("makeExecEffect PASSES the placeholder env (runs the effect on the Fake substrate)", async () => {
    const spy = new SpyFakeSandboxAdapter();
    const created = (await spy.createSandbox(validCtx, { image: "x" })) as { sandboxId: string };
    await spy.startSandbox(validCtx, created.sandboxId);
    const effect = makeExecEffect(spy, created.sandboxId);
    const res = await effect({
      context: validCtx,
      args: {
        argv: ["git", "push", "--", "https://github.com/o/r.git", "main"],
        env: { GIT_PUSH_TOKEN: placeholderForKey("GIT_PUSH_TOKEN") },
      },
    });
    expect(res.ok).toBe(true);
    // The placeholder did NOT trip the credential-blind input guard — the effect ran.
    expect(spy.execCalls.length).toBe(1);
    expect(spy.execCalls[0]?.env?.GIT_PUSH_TOKEN).toBe(placeholderForKey("GIT_PUSH_TOKEN"));
  });

  it("makeExecEffect REJECTS a LITERAL secret env value (input guard; substrate 0 calls)", async () => {
    const spy = new SpyFakeSandboxAdapter();
    const created = (await spy.createSandbox(validCtx, { image: "x" })) as { sandboxId: string };
    await spy.startSandbox(validCtx, created.sandboxId);
    const effect = makeExecEffect(spy, created.sandboxId);
    const canary = secretCanary();
    const res = await effect({
      context: validCtx,
      args: {
        argv: ["git", "push", "--", "https://github.com/o/r.git", "main"],
        env: { GIT_PUSH_TOKEN: canary },
      },
    });
    expect(res.ok).toBe(false);
    // Fail-closed: the literal secret never reached the substrate.
    expect(spy.execCalls.length).toBe(0);
    expect(JSON.stringify(res)).not.toContain(canary);
  });
});
