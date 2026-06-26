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

// ================================================================================================
// SLICE-ACT2 — the action family grows by PURE ADDITION (4 new triads), mirroring the ACT1 pattern
// EXACTLY: each is a manifest + composer-held binding + actionProjector, conditionally registered on
// the same wired primitives. NO gate is widened. The 4: calendar.events.create (write),
// calendar.events.list (read), drive.files.delete (destructive), gmail.search (read).
// ================================================================================================

/** The composer-fixed Google Calendar provider host the egress fold gates (the shared googleapis host). */
export const CALENDAR_HOST = "www.googleapis.com";

/** The env var naming the OPTIONAL per-service Calendar OAuth token KEY (NON-secret config: names a KEY). */
export const GCAL_OAUTH_KEY_ENV = "AGENTOS_GCAL_OAUTH_KEY";

// ------------------------------------------------------------------------------------------------
// calendar.events.create — a network-egress WRITE (NOT destructive => no approval; still egress-gated).
// ------------------------------------------------------------------------------------------------

/**
 * A valid `calendar.events.create` ToolManifest — a network-egress WRITE. `containment:"network-egress"`
 * (requires "egress-allowlist"); `sideEffect:"write"` (NOT destructive => NO approval — gated by EGRESS,
 * not approval); `idempotent:false` (creating a calendar event is not safely replayable).
 */
export const calendarEventsCreateManifest = {
  name: "calendar.events.create",
  version: "1.0.0",
  description: "create a calendar event via the Calendar API (egress gated)",
  action: "tool:invoke",
  resourcePattern: "calendar/events.create",
  sideEffect: "write" as const,
  idempotent: false,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "network-egress" as const,
};

/**
 * calendar.events.create binding: service "calendar" / method "events.create", STRICT
 * `{summary, start, end}` (typed strings; structured fields, NO command/shell concern), `toParams` -> the
 * structured body, `toCredentialEnv` -> the per-service OAuth placeholder, `actionProjector` -> host-only
 * networkHosts (the Calendar host) + operationClass (NO destructiveFlags — a write, not destructive),
 * NEVER the params. `.strict()` rejects a smuggled extra key (e.g. an `attendees` second channel).
 */
export const calendarEventsCreateBinding: ActionBinding = {
  service: "calendar",
  method: "events.create",
  argSchema: z
    .object({
      summary: z.string().min(1),
      start: z.string().min(1),
      end: z.string().min(1),
    })
    .strict(),
  toParams: (a) => {
    const v = a as { summary: string; start: string; end: string };
    return { summary: v.summary, start: v.start, end: v.end };
  },
  toCredentialEnv: () => toCredentialEnv(process.env[GCAL_OAUTH_KEY_ENV]),
  actionProjector: () => actionProjection("calendar", "events.create", CALENDAR_HOST, []),
};

// ------------------------------------------------------------------------------------------------
// calendar.events.list — a network-egress READ (no approval; still egress-gated).
// ------------------------------------------------------------------------------------------------

/**
 * A valid `calendar.events.list` ToolManifest — a network-egress READ. `containment:"network-egress"`
 * (requires "egress-allowlist"); `sideEffect:"read"` (no approval — gated by EGRESS); `idempotent:true`
 * (a list is safely replayable).
 */
export const calendarEventsListManifest = {
  name: "calendar.events.list",
  version: "1.0.0",
  description: "list calendar events via the Calendar API (egress gated)",
  action: "tool:invoke",
  resourcePattern: "calendar/events.list",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "network-egress" as const,
};

/**
 * calendar.events.list binding: service "calendar" / method "events.list", STRICT `{timeMin?, timeMax?}`
 * (both optional — `{}` is valid), `toParams` -> only the supplied keys, `actionProjector` -> host-only
 * networkHosts (the Calendar host). `.strict()` rejects a smuggled extra key.
 */
export const calendarEventsListBinding: ActionBinding = {
  service: "calendar",
  method: "events.list",
  argSchema: z
    .object({
      timeMin: z.string().min(1).optional(),
      timeMax: z.string().min(1).optional(),
    })
    .strict(),
  toParams: (a) => {
    const v = a as { timeMin?: string; timeMax?: string };
    return {
      ...(v.timeMin !== undefined ? { timeMin: v.timeMin } : {}),
      ...(v.timeMax !== undefined ? { timeMax: v.timeMax } : {}),
    };
  },
  actionProjector: () => actionProjection("calendar", "events.list", CALENDAR_HOST, []),
};

// ------------------------------------------------------------------------------------------------
// drive.files.delete — a network-egress DESTRUCTIVE action (superRefine FORCES requiresApproval:true).
// ------------------------------------------------------------------------------------------------

/**
 * A valid `drive.files.delete` ToolManifest — a network-egress DESTRUCTIVE action.
 * `containment:"network-egress"` (requires "egress-allowlist"); `sideEffect:"destructive"` (the manifest
 * superRefine FORCES `requiresApproval:true` => requires "approval"); `idempotent:false` (deleting a file
 * is not safely replayable).
 */
export const driveFilesDeleteManifest = {
  name: "drive.files.delete",
  version: "1.0.0",
  description: "delete a file via the Drive API (egress + approval gated)",
  action: "tool:invoke",
  resourcePattern: "drive/files.delete",
  sideEffect: "destructive" as const,
  idempotent: false,
  // FORCED true by the manifest superRefine (destructive => requiresApproval). A destructive action can
  // NEVER escape the approval gate; set it true to satisfy parseToolManifest.
  requiresApproval: true,
  bundleRefOnly: false,
  containment: "network-egress" as const,
};

/**
 * drive.files.delete binding: service "drive" / method "files.delete", STRICT `{fileId}`, `toParams` ->
 * `{fileId}`, `actionProjector` -> host-only networkHosts (the Drive host) + operationClass +
 * destructiveFlags (a coarse "delete" HINT, NOT a param value), NEVER the params. `.strict()` rejects a
 * smuggled extra key.
 */
export const driveFilesDeleteBinding: ActionBinding = {
  service: "drive",
  method: "files.delete",
  argSchema: z.object({ fileId: z.string().min(1) }).strict(),
  toParams: (a) => ({ fileId: (a as { fileId: string }).fileId }),
  // destructiveFlags carries a coarse HINT (a destructive, irreversible delete) — NOT a param value.
  // NON-VACUITY: remove the host => no networkHosts => the network-egress fail-closed gate denies.
  actionProjector: () => actionProjection("drive", "files.delete", DRIVE_HOST, ["delete"]),
};

// ------------------------------------------------------------------------------------------------
// gmail.search — a network-egress READ (no approval; still egress-gated).
// ------------------------------------------------------------------------------------------------

/**
 * A valid `gmail.search` ToolManifest — a network-egress READ. `containment:"network-egress"` (requires
 * "egress-allowlist"); `sideEffect:"read"` (no approval — gated by EGRESS); `idempotent:true` (a search
 * is safely replayable).
 */
export const gmailSearchManifest = {
  name: "gmail.search",
  version: "1.0.0",
  description: "search messages via the Gmail API (egress gated)",
  action: "tool:invoke",
  resourcePattern: "gmail/search",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "network-egress" as const,
};

/**
 * gmail.search binding: service "gmail" / method "search", STRICT `{query}`, `toParams` -> `{query}`,
 * `toCredentialEnv` -> the same per-service Gmail OAuth placeholder gmail.send uses, `actionProjector` ->
 * host-only networkHosts (the Gmail host) + operationClass (NO destructiveFlags — a read), NEVER the
 * params. `.strict()` rejects a smuggled extra key.
 */
export const gmailSearchBinding: ActionBinding = {
  service: "gmail",
  method: "search",
  argSchema: z.object({ query: z.string().min(1) }).strict(),
  toParams: (a) => ({ query: (a as { query: string }).query }),
  toCredentialEnv: () => toCredentialEnv(process.env[GMAIL_OAUTH_KEY_ENV]),
  actionProjector: () => actionProjection("gmail", "search", GMAIL_HOST, []),
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
  // (egress-allowlist for every network-egress action; +approval for the destructive ones). The
  // destructive tools are registered FIRST so a partial wiring is refused on a destructive tool (the
  // strongest deny-by-default signal).
  r.register(gmailSendManifest);
  r.register(driveReadManifest);
  // SLICE-ACT2 — pure addition: 4 more network-egress actions. drive.files.delete is destructive
  // (egress + approval); the rest are write/read (egress only).
  r.register(driveFilesDeleteManifest);
  r.register(calendarEventsCreateManifest);
  r.register(calendarEventsListManifest);
  r.register(gmailSearchManifest);
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
  // Destructive actions require BOTH egress-allowlist AND approval.
  if (wired.has("egress-allowlist") && wired.has("approval")) {
    entries.push(["gmail.send", gmailSendBinding]);
    entries.push(["drive.files.delete", driveFilesDeleteBinding]);
  }
  // Non-destructive network-egress actions (read/write) require only egress-allowlist.
  if (wired.has("egress-allowlist")) {
    entries.push(["drive.read", driveReadBinding]);
    entries.push(["calendar.events.create", calendarEventsCreateBinding]);
    entries.push(["calendar.events.list", calendarEventsListBinding]);
    entries.push(["gmail.search", gmailSearchBinding]);
  }
  return new Map<string, ActionBinding>(entries);
}
