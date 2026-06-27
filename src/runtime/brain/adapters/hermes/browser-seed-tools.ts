/**
 * SLICE-ACT5a+b — the FIRST seed BROWSER tools (manifests + composer-held bindings + projectors +
 * conditional registration) for the stateful UI sub-family: `browser.navigate` (network-egress read) +
 * `browser.read` (read, with the data-OUT sanitizer applied in the effect). The PARALLEL of
 * `action-seed-tools.ts`, but for {@link BrowserBinding} over a SERVER-HELD session — NO argv, NO shell.
 *
 * The browser MANIFESTS register in the SAME `ToolRegistry` (a manifest is family-agnostic); the browser
 * BINDINGS live in a SEPARATE `seedBrowserBindings` map. Both are CONDITIONALLY registered, gated on the
 * wired governance primitives:
 *   - `browser.navigate` (containment:network-egress + sideEffect:read) requires "egress-allowlist"; it
 *     registers ONLY when egress is wired (else `assertRegisterable` THROWS — deny-by-default).
 *   - `browser.read` (containment:in-sandbox + sideEffect:read) requires NO primitive — the read reaches
 *     the actor's CURRENT page (already egress-gated by the navigate that put it there) and is governed by
 *     the data-OUT sanitizer in the effect. It is registered alongside navigate when the family is INTENDED.
 *
 * NAVIGATE EGRESS DISCIPLINE (REUSES net.fetch's): the brain-supplied url is validated by the IDENTICAL
 * `isAllowedFetchUrl` (https-only / plain DNS host / no userinfo / no IP-literal) net.fetch + git.push use;
 * the projector emits `networkHosts=[new URL(url).hostname]` (host-only, REUSING net.fetch's hostname
 * projection) so the PER-NAVIGATION egress fold gates it (deny-all default). NON-VACUITY: drop the
 * projector => no networkHosts => the CAP6 fail-closed gate denies (the destination is unknown).
 *
 * PROJECTOR discipline: each projector emits ONLY safe-derived fields — host-only networkHosts (navigate)
 * + operationClass — and NEVER the params (no url path/query, no selector). The read projector emits an
 * in-sandbox projection with NO host (read does not punch the egress seal itself).
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone alongside action-seed-tools.ts; imports ONLY
 * `zod`, the neutral `policy` barrel (`GovernanceProjection`), the neutral `tools` barrel, the in-module
 * `BrowserBinding` type, and `isAllowedFetchUrl` from the SIBLING exec-seed-tools (the one shared url
 * validator — not a re-implementation).
 */
import { z } from "zod";
import type { GovernanceProjection } from "../../../../policy/index.js";
import { type Primitive, ToolRegistry, WIRED_PRIMITIVES } from "../../../../tools/index.js";
import type { BrowserBinding } from "./browser-closed-loop.js";
import { isAllowedFetchUrl } from "./exec-seed-tools.js";

/** A strict, opaque-sessionId shape: `bsess_` + a run of url-safe id chars. Validates the brain's ref. */
const SESSION_ID = z.string().regex(/^bsess_[A-Za-z0-9]{4,}$/);

/** Build a credential-blind browser projection (safe-derived only; NEVER the params). */
function browserProjection(
  primitive: string,
  networkHosts: readonly string[],
): GovernanceProjection {
  return {
    version: 1,
    // A coarse, deterministic bucket — NEVER a param value (no url path/query, no selector).
    operationClass: `browser:${primitive}`,
    // argv concepts do NOT apply to a structured browser step — inert + empty (kept on the shared shape
    // for the egress fold + boundary summary, which read ONLY networkHosts / operationClass).
    argv0: `browser.${primitive}`,
    argc: 0,
    argvRedacted: [],
    truncated: false,
    usesShellInterpreter: false,
    // Host-only (navigate); empty for an in-sandbox read.
    networkHosts: [...networkHosts],
    destructiveFlags: [],
    // The browser punches the network seal (navigate), not the host disk — no host write target.
    writeTargets: [],
  };
}

// ------------------------------------------------------------------------------------------------
// browser.navigate — a NETWORK-EGRESS read (per-navigation egress; brain-supplied host).
// ------------------------------------------------------------------------------------------------

/**
 * A valid `browser.navigate` ToolManifest. `containment:"network-egress"` (it punches the seal to the
 * network => requires "egress-allowlist"); `sideEffect:"read"` (navigation itself is a read — no approval;
 * gated by EGRESS, not approval); `idempotent:true` (re-navigating the same url is safely replayable).
 */
export const browserNavigateManifest = {
  name: "browser.navigate",
  version: "1.0.0",
  description:
    "navigate a server-held browser session to an https url (per-navigation egress gated)",
  action: "tool:invoke",
  resourcePattern: "browser/navigate",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "network-egress" as const,
};

/**
 * browser.navigate binding: primitive "navigate", STRICT `{sessionId, url}` (url validated by the SHARED
 * `isAllowedFetchUrl`), `toParams` -> `{url}` (the connector resolves the sessionId itself), projector ->
 * host-only networkHosts (`new URL(url).hostname`, REUSING net.fetch's projection) so the per-navigation
 * egress fold gates it. `.strict()` rejects a smuggled extra key. NON-VACUITY: remove the projector => no
 * networkHosts => the network-egress CAP6 fail-closed gate denies.
 */
export const browserNavigateBinding: BrowserBinding = {
  primitive: "navigate",
  argSchema: z
    .object({
      sessionId: SESSION_ID,
      url: z.string().min(1).max(2048).refine(isAllowedFetchUrl),
    })
    .strict(),
  toParams: (a) => ({ url: (a as { url: string }).url }),
  governanceProjector: (a) => {
    const url = (a as { url: string }).url;
    // The url is already validated (http/https + plain DNS host), so `new URL` cannot throw here.
    return browserProjection("navigate", [new URL(url).hostname]);
  },
};

// ------------------------------------------------------------------------------------------------
// browser.read — an IN-SANDBOX read of the actor's CURRENT page (egress-gated by the prior navigate).
// ------------------------------------------------------------------------------------------------

/**
 * A valid `browser.read` ToolManifest. `containment:"in-sandbox"` (the read itself does NOT punch the
 * egress seal — the page is already there, put by an egress-gated navigate; the returned content is
 * governed by the data-OUT sanitizer in the effect); `sideEffect:"read"` (no approval); `idempotent:true`.
 */
export const browserReadManifest = {
  name: "browser.read",
  version: "1.0.0",
  description:
    "read content from the current page of a server-held browser session (data-OUT sanitized)",
  action: "tool:invoke",
  resourcePattern: "browser/read",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "in-sandbox" as const,
};

/**
 * browser.read binding: primitive "read", STRICT `{sessionId, selector?}`, `toParams` -> only the supplied
 * selector. The EFFECT runs the connector's returned content through `returnContentSanitizer` before it
 * reaches the brain. projector -> in-sandbox (NO host — read does not punch the egress seal). `.strict()`
 * rejects a smuggled extra key.
 */
export const browserReadBinding: BrowserBinding = {
  primitive: "read",
  argSchema: z
    .object({
      sessionId: SESSION_ID,
      selector: z.string().min(1).max(1024).optional(),
    })
    .strict(),
  toParams: (a) => {
    const v = a as { selector?: string };
    return v.selector !== undefined ? { selector: v.selector } : {};
  },
  governanceProjector: () => browserProjection("read", []),
};

// ------------------------------------------------------------------------------------------------
// browser.click — an IN-SANDBOX DESTRUCTIVE UI action (click can submit/delete/trigger — its network/UI
// effect is OPAQUE, so it cannot be projected ahead of time; the substrate's REAL boundary is PRIMARY and
// the seal-relevant control is destructive => approval, layered with session-on-allowlisted-host + sandbox).
// ------------------------------------------------------------------------------------------------

/**
 * A valid `browser.click` ToolManifest. `containment:"in-sandbox"` (a click has NO projectable host — its
 * network effect is opaque and is forced by the substrate, not predicted here; honestly marked in-sandbox so
 * the seal-relevant gate is APPROVAL, not a phantom egress projection); `sideEffect:"destructive"` (a click
 * can submit/delete/trigger => superRefine FORCES `requiresApproval:true` — per-step approval);
 * `idempotent:false` (re-clicking is NOT safely replayable).
 */
export const browserClickManifest = {
  name: "browser.click",
  version: "1.0.0",
  description:
    "click an element in a server-held browser session (destructive — per-step approval)",
  action: "tool:invoke",
  resourcePattern: "browser/click",
  sideEffect: "destructive" as const,
  idempotent: false,
  requiresApproval: true,
  bundleRefOnly: false,
  containment: "in-sandbox" as const,
};

/**
 * browser.click binding: primitive "click", STRICT `{sessionId, selector}`, `toParams` -> `{selector}` (a
 * plain structured field, NEVER a script — no DOM injection面), projector -> in-sandbox (NO host, NO params
 * — only operationClass). `.strict()` rejects a smuggled extra key.
 */
export const browserClickBinding: BrowserBinding = {
  primitive: "click",
  argSchema: z
    .object({
      sessionId: SESSION_ID,
      selector: z.string().min(1).max(1024),
    })
    .strict(),
  toParams: (a) => ({ selector: (a as { selector: string }).selector }),
  governanceProjector: () => browserProjection("click", []),
};

// ------------------------------------------------------------------------------------------------
// browser.type — an IN-SANDBOX DESTRUCTIVE UI action with a TEXT that MAY be a credential PLACEHOLDER
// (resolved at the connector EGRESS, credential-blind). A LITERAL secret in `text` is denied by the
// credential-blind INPUT guard (the connector is never called); a placeholder passes (not a secret shape)
// and is materialized ONLY at the connector, never reaching the brain/WORM/projection.
// ------------------------------------------------------------------------------------------------

/**
 * A valid `browser.type` ToolManifest. `containment:"in-sandbox"` (no projectable host — opaque UI effect);
 * `sideEffect:"destructive"` (typing can trigger submit/validation/side effects => superRefine FORCES
 * `requiresApproval:true`); `idempotent:false`.
 */
export const browserTypeManifest = {
  name: "browser.type",
  version: "1.0.0",
  description:
    "type text into an element in a server-held browser session (destructive — per-step approval; text may be a credential placeholder resolved at egress)",
  action: "tool:invoke",
  resourcePattern: "browser/type",
  sideEffect: "destructive" as const,
  idempotent: false,
  requiresApproval: true,
  bundleRefOnly: false,
  containment: "in-sandbox" as const,
};

/**
 * browser.type binding: primitive "type", STRICT `{sessionId, selector, text}`, `toParams` ->
 * `{selector, text}` (structured fields, NEVER a script). The `text` MAY be a credential PLACEHOLDER
 * (`openshell:resolve:env:KEY`): a placeholder is NOT secret-shaped so it PASSES the credential-blind INPUT
 * guard and the connector resolves it at EGRESS (`resolveCredentialText`); a LITERAL secret in `text` IS
 * secret-shaped so the INPUT guard DENIES it (the connector is never called). projector -> in-sandbox (NO
 * host, NO params — only operationClass; the brain/WORM never see the text). `.strict()` rejects an extra key.
 */
export const browserTypeBinding: BrowserBinding = {
  primitive: "type",
  argSchema: z
    .object({
      sessionId: SESSION_ID,
      selector: z.string().min(1).max(1024),
      text: z.string().min(1).max(4096),
    })
    .strict(),
  toParams: (a) => {
    const v = a as { selector: string; text: string };
    return { selector: v.selector, text: v.text };
  },
  governanceProjector: () => browserProjection("type", []),
};

// ------------------------------------------------------------------------------------------------
// Conditional registration (parallel to seedActionRegistry/seedActionBindings).
// ------------------------------------------------------------------------------------------------

/**
 * The browser-relevant governance primitives — a composition that has wired "egress-allowlist" INTENDS to
 * open the browser family (every browser task starts with an egress-gated navigate), so the seeders
 * ATTEMPT to register the browser tools and let the CAP3 gate (`assertRegisterable`) enforce COMPLETENESS.
 * A composition that has wired NONE of them never attempts (no browser tools, no throw) — byte-identical
 * to a pure exec/action composition.
 */
const BROWSER_PRIMITIVES: readonly Primitive[] = ["egress-allowlist"];

/** True iff the composition has wired ANY browser-relevant primitive (i.e. INTENDS the browser family). */
function intendsBrowserFamily(wired: ReadonlySet<Primitive>): boolean {
  return BROWSER_PRIMITIVES.some((p) => wired.has(p));
}

/**
 * A fresh ToolRegistry holding the seed BROWSER tools (so authorize can admit only these names). The
 * registration POSTURE is deny-by-default at registration, enforced by the CAP3 gate:
 *   - a composition that has wired NO browser primitive (the DEFAULT empty `WIRED_PRIMITIVES`) registers
 *     NEITHER — no attempt, no throw (byte-identical to a pure exec/action composition);
 *   - a composition that INTENDS the browser family (egress-allowlist wired) ATTEMPTS to register both.
 *     `assertRegisterable` THROWS if a required primitive is missing — browser.navigate requires
 *     ["egress-allowlist"]; browser.read (in-sandbox) requires none. The network-egress tool is registered
 *     FIRST so a (hypothetical) partial wiring is refused on the seal-punching tool (the strongest signal).
 */
export function seedBrowserRegistry(
  wired: ReadonlySet<Primitive> = WIRED_PRIMITIVES,
): ToolRegistry {
  const r = new ToolRegistry(undefined, wired);
  if (!intendsBrowserFamily(wired)) return r;
  r.register(browserNavigateManifest);
  r.register(browserReadManifest);
  // browser.click/type are destructive (in-sandbox) => `requiredPrimitives` includes "approval". They
  // register ONLY when "approval" is wired; a composition without it gets navigate/read but NOT the
  // destructive primitives (deny-by-default at registration — `assertRegisterable` would throw otherwise).
  if (wired.has("approval")) {
    r.register(browserClickManifest);
    r.register(browserTypeManifest);
  }
  return r;
}

/**
 * The composer-held bindings map for the seed BROWSER tools (parallel to the registry, separate from the
 * exec/action bindings). It mirrors the registry's posture: a composition that has wired NO browser
 * primitive gets an EMPTY map; one that INTENDS the browser family AND has wired "egress-allowlist" gets
 * both bindings. A binding is included ONLY when its manifest's required primitives are all wired.
 */
export function seedBrowserBindings(
  wired: ReadonlySet<Primitive> = WIRED_PRIMITIVES,
): ReadonlyMap<string, BrowserBinding> {
  const entries: [string, BrowserBinding][] = [];
  if (!intendsBrowserFamily(wired)) return new Map<string, BrowserBinding>();
  // browser.navigate (network-egress) requires egress-allowlist; browser.read (in-sandbox) requires none,
  // but the read is only meaningful alongside an egress-gated navigate, so it rides the same gate.
  if (wired.has("egress-allowlist")) {
    entries.push(["browser.navigate", browserNavigateBinding]);
    entries.push(["browser.read", browserReadBinding]);
  }
  // browser.click/type (destructive) ride the APPROVAL gate — their bindings are included ONLY when
  // "approval" is wired (mirroring the registry's posture; a binding without its manifest registered would
  // be unreachable). Deny-by-default: an approval-less composition gets no click/type binding.
  if (wired.has("approval")) {
    entries.push(["browser.click", browserClickBinding]);
    entries.push(["browser.type", browserTypeBinding]);
  }
  return new Map<string, BrowserBinding>(entries);
}
