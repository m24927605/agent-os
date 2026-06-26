/**
 * SLICE-ACT1 — the FIRST seed ACTION tools (manifests + composer-held bindings + conditional registration)
 * for the NON-argv app/API family: `gmail.send` (destructive) + `drive.read` (read). The PARALLEL of
 * `exec-seed-tools.ts` (`seedRegistry`/`seedBindings`), but for `ActionBinding` over the structured
 * `{service, method, params}` descriptor — NO argv, NO shell.
 *
 * The action MANIFESTS register in the SAME `ToolRegistry` (a manifest is family-agnostic); the action
 * BINDINGS live in a SEPARATE `seedActionBindings` map (parallel to `seedBindings`). Both are CONDITIONALLY
 * registered, gated on the wired governance primitives:
 *   - `gmail.send` (containment:network-egress + sideEffect:destructive) requires BOTH "egress-allowlist"
 *     AND "approval" (the manifest superRefine FORCES requiresApproval:true for destructive); it
 *     registers ONLY when both are wired (else `assertRegisterable` THROWS — deny-by-default).
 *   - `drive.read` (containment:network-egress + sideEffect:read) requires "egress-allowlist"; it
 *     registers ONLY when egress is wired.
 *
 * CREDENTIAL discipline (REUSES net.fetch's): `gmail.send`'s `toCredentialEnv` emits ONLY a
 * `placeholderForKey(AGENTOS_GMAIL_OAUTH_KEY)` — a PLACEHOLDER in OpenShell's `openshell:resolve:env:<KEY>`
 * grammar, NEVER a literal secret — through the SAME SAFE_ENV_KEY / FORBIDDEN_AUTH_KEYS fail-closed
 * validator shape net.fetch uses. The KEY's real value is resolved by OpenShell's SecretResolver at the
 * sandbox egress boundary (EXEC2-gated); agent-os only ever assembles the placeholder.
 *
 * PROJECTOR discipline: each `actionProjector` emits ONLY safe-derived fields —
 * `networkHosts:[composer-fixed provider host]` + `operationClass` (the service.method bucket) +
 * `destructiveFlags` — and NEVER the params (no to/subject/body/fileId). Stricter than the exec
 * argvRedacted: not even a local AGT advisory sees a param value.
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone alongside exec-seed-tools.ts; imports ONLY
 * `zod`, the neutral `credential` barrel (`placeholderForKey`), the neutral `tools` barrel, and the
 * in-module `ActionBinding` type. Re-exported via the hermes barrel.
 */
import { z } from "zod";
import { placeholderForKey } from "../../../../credential/index.js";
import type { GovernanceProjection } from "../../../../policy/index.js";
import { type Primitive, ToolRegistry, WIRED_PRIMITIVES } from "../../../../tools/index.js";
import type { ActionBinding } from "./action-closed-loop.js";

// ------------------------------------------------------------------------------------------------
// Credential-env discipline — the ACTION twin of net.fetch's SAFE_ENV_KEY / FORBIDDEN_AUTH_KEYS /
// netFetchAuthEnv. An action's credential KEY must be a plain uppercase C-identifier AND not a control
// name; otherwise NO env (fail-closed). A valid key yields `{ [key]: placeholderForKey(key) }` — a
// PLACEHOLDER, NEVER a literal secret. The INPUT guard passes the placeholder and rejects any literal.
// ------------------------------------------------------------------------------------------------

/** A safe env-KEY shape: an UPPERCASE C-identifier (`[A-Z][A-Z0-9_]*`) — the same contract net.fetch uses. */
const SAFE_ACTION_ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

/**
 * Env names that could alter network/credential resolution behavior — NEVER an action auth key (mirrors
 * net.fetch's FORBIDDEN_AUTH_KEYS; an action connector that shells out to a tool must not honor these).
 */
const FORBIDDEN_ACTION_KEYS: ReadonlySet<string> = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "HOME",
  "PATH",
]);

/**
 * Build an action's OPTIONAL placeholder credential env from a per-service token KEY. PURE. The key MUST
 * be an uppercase C-identifier (`SAFE_ACTION_ENV_KEY`) AND NOT a control name (`FORBIDDEN_ACTION_KEYS`) —
 * otherwise `{}` (fail-closed). A valid key returns `{ [key]: placeholderForKey(key) }` — a CREDENTIAL
 * PLACEHOLDER (`openshell:resolve:env:<KEY>`), NEVER a literal secret. (The action twin of `netFetchAuthEnv`.)
 */
export function toCredentialEnv(authKey: string | undefined): Readonly<Record<string, string>> {
  const key = (authKey ?? "").trim();
  if (key.length === 0) return {};
  if (!SAFE_ACTION_ENV_KEY.test(key)) return {};
  if (FORBIDDEN_ACTION_KEYS.has(key)) return {};
  return { [key]: placeholderForKey(key) };
}

/** Build a credential-blind action projection (the safe-derived-only shape; NEVER the params). */
function actionProjection(
  service: string,
  method: string,
  host: string,
  destructiveFlags: readonly string[],
): GovernanceProjection {
  return {
    version: 1,
    // A coarse, deterministic bucket (the action twin of exec's basename-keyed operationClass). NEVER a
    // param value — just the composer-fixed service.method identity.
    operationClass: `action:${service}.${method}`,
    // argv0/argc/argvRedacted are ARGV concepts that do NOT apply to a structured action — inert + EMPTY
    // (the action carries NO argv). Kept on the shared GovernanceProjection shape for the egress fold +
    // boundary summary, which read ONLY networkHosts / operationClass / destructiveFlags.
    argv0: `${service}.${method}`,
    argc: 0,
    argvRedacted: [],
    truncated: false,
    usesShellInterpreter: false,
    // The COMPOSER-FIXED provider host — the very thing the egress fold gates. Host-only (no path/query).
    networkHosts: [host],
    destructiveFlags: [...destructiveFlags],
    // Actions punch the network seal, not the host disk — no host write target.
    writeTargets: [],
  };
}

// ------------------------------------------------------------------------------------------------
// gmail.send — the FIRST destructive action (network-egress + destructive => requiresApproval forced).
// ------------------------------------------------------------------------------------------------

/** The env var naming the OPTIONAL per-service Gmail OAuth token KEY (NON-secret config: names a KEY). */
export const GMAIL_OAUTH_KEY_ENV = "AGENTOS_GMAIL_OAUTH_KEY";

/** The composer-fixed Gmail provider host the egress fold gates. */
export const GMAIL_HOST = "gmail.googleapis.com";

/**
 * A valid `gmail.send` ToolManifest — the FIRST destructive ACTION tool. `containment:"network-egress"`
 * (it punches the seal to the network => requires "egress-allowlist"); `sideEffect:"destructive"` (the
 * manifest superRefine FORCES `requiresApproval:true` => requires "approval"); `idempotent:false` (sending
 * an email is not safely replayable).
 */
export const gmailSendManifest = {
  name: "gmail.send",
  version: "1.0.0",
  description: "send an email via the Gmail API (egress + approval gated)",
  action: "tool:invoke",
  resourcePattern: "gmail/send",
  sideEffect: "destructive" as const,
  idempotent: false,
  // FORCED true by the manifest superRefine (destructive => requiresApproval). A destructive action can
  // NEVER escape the approval gate; set it true to satisfy parseToolManifest.
  requiresApproval: true,
  bundleRefOnly: false,
  containment: "network-egress" as const,
};

/**
 * gmail.send binding: service "gmail" / method "send", STRICT `{to, subject, body}`, `toParams` -> the
 * structured body, `toCredentialEnv` -> the per-service OAuth placeholder, `actionProjector` -> host-only
 * networkHosts + operationClass + destructiveFlags (NEVER the params). `.strict()` rejects a smuggled
 * extra key (e.g. a `bcc` second channel); the body is governed by the credential-blind INPUT guard.
 */
export const gmailSendBinding: ActionBinding = {
  service: "gmail",
  method: "send",
  argSchema: z
    .object({
      to: z.string().min(1),
      subject: z.string(),
      body: z.string(),
    })
    .strict(),
  toParams: (a) => {
    const v = a as { to: string; subject: string; body: string };
    return { to: v.to, subject: v.subject, body: v.body };
  },
  toCredentialEnv: () => toCredentialEnv(process.env[GMAIL_OAUTH_KEY_ENV]),
  // destructiveFlags carries a coarse HINT (the send is a destructive, irreversible network effect) — NOT
  // a param value. NON-VACUITY: remove the host => no networkHosts => the network-egress fail-closed gate
  // denies (the destination is unknown).
  actionProjector: () => actionProjection("gmail", "send", GMAIL_HOST, ["send"]),
};

// ------------------------------------------------------------------------------------------------
// drive.read — a network-egress READ (no approval; still egress-gated).
// ------------------------------------------------------------------------------------------------

/** The composer-fixed Drive provider host the egress fold gates. */
export const DRIVE_HOST = "www.googleapis.com";

/**
 * A valid `drive.read` ToolManifest — a network-egress READ. `containment:"network-egress"` (requires
 * "egress-allowlist"); `sideEffect:"read"` (no approval — a network read is gated by EGRESS, not approval);
 * `idempotent:true` (a read is safely replayable).
 */
export const driveReadManifest = {
  name: "drive.read",
  version: "1.0.0",
  description: "read a file's content via the Drive API (egress gated)",
  action: "tool:invoke",
  resourcePattern: "drive/read",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "network-egress" as const,
};

/**
 * drive.read binding: service "drive" / method "read", STRICT `{fileId}`, `toParams` -> `{fileId}`,
 * `actionProjector` -> host-only networkHosts (the Drive host) + operationClass (NO destructiveFlags — a
 * read). `.strict()` rejects a smuggled extra key.
 */
export const driveReadBinding: ActionBinding = {
  service: "drive",
  method: "read",
  argSchema: z.object({ fileId: z.string().min(1) }).strict(),
  toParams: (a) => ({ fileId: (a as { fileId: string }).fileId }),
  actionProjector: () => actionProjection("drive", "read", DRIVE_HOST, []),
};

// ------------------------------------------------------------------------------------------------
// Conditional registration (parallel to seedRegistry/seedBindings).
// ------------------------------------------------------------------------------------------------

/**
 * The action-relevant governance primitives — a composition that has wired ANY of these INTENDS to open
 * the action family, so `seedActionRegistry`/`seedActionBindings` ATTEMPT to register the action tools and
 * let the CAP3 gate (`assertRegisterable`) enforce COMPLETENESS (deny-by-default at registration). A
 * composition that has wired NONE of them never attempts (no action tools, no throw) — byte-identical to a
 * pure exec composition.
 */
const ACTION_PRIMITIVES: readonly Primitive[] = ["egress-allowlist", "approval"];

/** True iff the composition has wired ANY action-relevant primitive (i.e. INTENDS the action family). */
function intendsActionFamily(wired: ReadonlySet<Primitive>): boolean {
  return ACTION_PRIMITIVES.some((p) => wired.has(p));
}

/**
 * A fresh ToolRegistry holding the seed ACTION tools (so authorize can admit only these names). Both are
 * `containment:"network-egress"`; gmail.send is also `destructive`. The registration POSTURE is
 * deny-by-default at registration, enforced by the CAP3 gate:
 *   - a composition that has wired NO action primitive (the DEFAULT empty `WIRED_PRIMITIVES`, a pure exec
 *     composition) registers NEITHER — no attempt, no throw (the registry is empty of action tools);
 *   - a composition that INTENDS the action family (any of egress-allowlist / approval wired) ATTEMPTS to
 *     register both. `assertRegisterable` THROWS if a required primitive is missing — gmail.send requires
 *     BOTH ["egress-allowlist","approval"], drive.read requires ["egress-allowlist"] — so a PARTIAL wiring
 *     (egress-only, approval-only) is REFUSED, exactly the CAP3 ordering ("open the primitive before the
 *     capability"). Only the FULL {egress-allowlist, approval} wiring registers both.
 */
export function seedActionRegistry(wired: ReadonlySet<Primitive> = WIRED_PRIMITIVES): ToolRegistry {
  const r = new ToolRegistry(undefined, wired);
  if (!intendsActionFamily(wired)) return r;
  // ATTEMPT registration; assertRegisterable (inside register) THROWS on a missing required primitive
  // (gmail.send: egress-allowlist + approval; drive.read: egress-allowlist). gmail.send is registered
  // FIRST so a partial wiring is refused on the destructive tool (the strongest deny-by-default signal).
  r.register(gmailSendManifest);
  r.register(driveReadManifest);
  return r;
}

/**
 * The composer-held bindings map for the seed ACTION tools (parallel to the registry, separate from the
 * exec `seedBindings`). It mirrors the registry's posture: a composition that has wired NO action
 * primitive gets an EMPTY map (byte-identical to a pure exec composition); a composition that INTENDS the
 * action family AND has wired the FULL {egress-allowlist, approval} set gets both bindings. A PARTIAL
 * wiring would have THROWN at `seedActionRegistry` (the registry is the authority), so here we include a
 * binding ONLY when its manifest's required primitives are all wired — an advertised binding always has a
 * corresponding registered manifest (a binding with no manifest is inert; a manifest with no binding denies
 * at the effect edge).
 */
export function seedActionBindings(
  wired: ReadonlySet<Primitive> = WIRED_PRIMITIVES,
): ReadonlyMap<string, ActionBinding> {
  const entries: [string, ActionBinding][] = [];
  if (!intendsActionFamily(wired)) return new Map<string, ActionBinding>();
  if (wired.has("egress-allowlist") && wired.has("approval"))
    entries.push(["gmail.send", gmailSendBinding]);
  if (wired.has("egress-allowlist")) entries.push(["drive.read", driveReadBinding]);
  return new Map<string, ActionBinding>(entries);
}
