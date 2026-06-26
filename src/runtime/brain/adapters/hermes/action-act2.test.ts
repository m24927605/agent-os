/**
 * SLICE-ACT2 (RED-first) — the 4 NEW seed ACTIONS prove the ActionBinding family grows by PURE ADDITION,
 * mirroring ACT1's exact pattern (action-closed-loop.test.ts) over a FakeActionConnector. NO real
 * MCP/OAuth/network. Each new action is a manifest + composer-held binding + actionProjector triad:
 *
 *   1. calendar.events.create — network-egress + WRITE (no approval, still egress-gated), strict
 *      {summary,start,end}, projector -> calendar host + NO params.
 *   2. calendar.events.list   — network-egress + READ, strict {timeMin?,timeMax?}, projector.
 *   3. drive.files.delete     — network-egress + DESTRUCTIVE (superRefine FORCES requiresApproval),
 *      strict {fileId}, projector -> drive host.
 *   4. gmail.search           — network-egress + READ, strict {query}, projector.
 *
 * This file proves the PORT/EFFECT EDGE + PROJECTION HELPER + REGISTRATION as pure units (no pipeline,
 * no subprocess) for the 4 new actions:
 *   - strict deny (extra key) / valid -> descriptor built in ONE place + Fake.invoke receives it;
 *   - the projector emits ONLY safe-derived fields (networkHosts non-empty), NEVER the params;
 *   - REGISTRATION is gated: each new action registers ONLY in a wired set carrying its required
 *     primitive (every action is network-egress => egress-allowlist; drive.files.delete is destructive
 *     => +approval); a registry MISSING the needed primitive => assertRegisterable THROWS.
 *
 * The DESTRUCTIVE end-to-end (drive.files.delete through the REAL runGovernedToolCall) + the read/write
 * egress-gated + credential-blind joins live in `action-act2-join.test.ts`. HONEST BOUNDARY (same as
 * ACT1): ACT2 is pure-addition fake-proven actions; the real send/list/delete + OAuth + MCP transport +
 * real egress reach are deploy/EXEC2-gated/BLOCKED (ACT3).
 */
import { describe, expect, it } from "vitest";
import { defaultExecSecretDetector } from "../../../substrate/index.js";
import {
  type ActionDescriptor,
  FakeActionConnector,
  bindingWrappedActionEffect,
} from "./action-closed-loop.js";
import { buildActionProjectionForCall } from "./action-projection-for-call.js";
import {
  CALENDAR_HOST,
  calendarEventsCreateBinding,
  calendarEventsCreateManifest,
  calendarEventsListBinding,
  calendarEventsListManifest,
  driveFilesDeleteBinding,
  driveFilesDeleteManifest,
  gmailSearchBinding,
  gmailSearchManifest,
  seedActionBindings,
  seedActionRegistry,
} from "./action-seed-tools.js";

const validCtx = {
  actorId: "agent:hermes",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

/** Runtime-built secret canary matching audit/redact's `sk-...` shape (NOT a source literal). */
function secretCanary(): string {
  return `sk-${"a1B2c3D4".repeat(3)}`; // 24 alnum chars => matches /sk-[A-Za-z0-9]{16,}/
}

/** The action-family wired set: egress-allowlist + approval (so ALL 4 new actions register). */
const ACTION_WIRED = new Set(["egress-allowlist", "approval"] as const);

// ==================================================================================================
// RED1 — manifests + bindings contract: each new action's side-effect/containment/approval semantics.
// ==================================================================================================
describe("ACT2 — manifests + bindings contract (the 4 new actions)", () => {
  it("calendar.events.create is network-egress + WRITE + requiresApproval:false (not destructive)", () => {
    expect(calendarEventsCreateManifest.containment).toBe("network-egress");
    expect(calendarEventsCreateManifest.sideEffect).toBe("write");
    expect(calendarEventsCreateManifest.requiresApproval).toBe(false);
    expect(calendarEventsCreateManifest.idempotent).toBe(false);
  });

  it("calendar.events.list is network-egress + READ + requiresApproval:false", () => {
    expect(calendarEventsListManifest.containment).toBe("network-egress");
    expect(calendarEventsListManifest.sideEffect).toBe("read");
    expect(calendarEventsListManifest.requiresApproval).toBe(false);
  });

  it("drive.files.delete is network-egress + DESTRUCTIVE + requiresApproval:true (superRefine forced)", () => {
    expect(driveFilesDeleteManifest.containment).toBe("network-egress");
    expect(driveFilesDeleteManifest.sideEffect).toBe("destructive");
    expect(driveFilesDeleteManifest.requiresApproval).toBe(true);
    expect(driveFilesDeleteManifest.idempotent).toBe(false);
  });

  it("gmail.search is network-egress + READ + requiresApproval:false", () => {
    expect(gmailSearchManifest.containment).toBe("network-egress");
    expect(gmailSearchManifest.sideEffect).toBe("read");
    expect(gmailSearchManifest.requiresApproval).toBe(false);
  });

  it("the bindings carry composer-fixed service+method (brain never supplies them)", () => {
    expect(calendarEventsCreateBinding.service).toBe("calendar");
    expect(calendarEventsCreateBinding.method).toBe("events.create");
    expect(calendarEventsListBinding.service).toBe("calendar");
    expect(calendarEventsListBinding.method).toBe("events.list");
    expect(driveFilesDeleteBinding.service).toBe("drive");
    expect(driveFilesDeleteBinding.method).toBe("files.delete");
    expect(gmailSearchBinding.service).toBe("gmail");
    expect(gmailSearchBinding.method).toBe("search");
  });
});

// ==================================================================================================
// RED2 — effect edge: strict deny (extra key) + valid -> descriptor built in ONE place + Fake.invoke.
// ==================================================================================================
describe("ACT2 — bindingWrappedActionEffect: strict deny + valid descriptor (the 4 new actions)", () => {
  it("calendar.events.create + an EXTRA key -> strict argSchema denies; connector NEVER called", async () => {
    const fake = new FakeActionConnector();
    const effect = bindingWrappedActionEffect(fake, seedActionBindings(ACTION_WIRED), {
      detectSecret: defaultExecSecretDetector,
    });
    const res = await effect({
      tool: "calendar.events.create",
      context: validCtx,
      args: { summary: "s", start: "2026-01-01", end: "2026-01-02", attendees: "evil@x.com" },
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("invalid action args");
    expect(fake.invokeCalls.length).toBe(0);
  });

  it("calendar.events.create valid -> connector receives {service,method,params:{summary,start,end}}", async () => {
    const fake = new FakeActionConnector();
    const effect = bindingWrappedActionEffect(fake, seedActionBindings(ACTION_WIRED), {
      detectSecret: defaultExecSecretDetector,
    });
    const res = await effect({
      tool: "calendar.events.create",
      context: validCtx,
      args: { summary: "standup", start: "2026-01-01T09:00", end: "2026-01-01T09:30" },
    });
    expect(res.ok).toBe(true);
    expect(fake.invokeCalls.length).toBe(1);
    const desc = fake.invokeCalls[0]?.descriptor as ActionDescriptor;
    expect(desc.service).toBe("calendar");
    expect(desc.method).toBe("events.create");
    expect(desc.params).toEqual({
      summary: "standup",
      start: "2026-01-01T09:00",
      end: "2026-01-01T09:30",
    });
  });

  it("calendar.events.list valid (empty args) -> connector receives {service,method,params:{}}", async () => {
    const fake = new FakeActionConnector();
    const effect = bindingWrappedActionEffect(fake, seedActionBindings(ACTION_WIRED), {
      detectSecret: defaultExecSecretDetector,
    });
    const res = await effect({ tool: "calendar.events.list", context: validCtx, args: {} });
    expect(res.ok).toBe(true);
    expect(fake.invokeCalls.length).toBe(1);
    const desc = fake.invokeCalls[0]?.descriptor as ActionDescriptor;
    expect(desc.service).toBe("calendar");
    expect(desc.method).toBe("events.list");
    expect(desc.params).toEqual({});
  });

  it("calendar.events.list + an EXTRA key -> strict argSchema denies; connector NEVER called", async () => {
    const fake = new FakeActionConnector();
    const effect = bindingWrappedActionEffect(fake, seedActionBindings(ACTION_WIRED), {
      detectSecret: defaultExecSecretDetector,
    });
    const res = await effect({
      tool: "calendar.events.list",
      context: validCtx,
      args: { timeMin: "2026-01-01", calendarId: "smuggled" },
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("invalid action args");
    expect(fake.invokeCalls.length).toBe(0);
  });

  it("drive.files.delete + an EXTRA key -> strict argSchema denies; connector NEVER called", async () => {
    const fake = new FakeActionConnector();
    const effect = bindingWrappedActionEffect(fake, seedActionBindings(ACTION_WIRED), {
      detectSecret: defaultExecSecretDetector,
    });
    const res = await effect({
      tool: "drive.files.delete",
      context: validCtx,
      args: { fileId: "file-1", permanent: true },
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("invalid action args");
    expect(fake.invokeCalls.length).toBe(0);
  });

  it("drive.files.delete valid -> connector receives {service:'drive', method:'files.delete', {fileId}}", async () => {
    const fake = new FakeActionConnector();
    const effect = bindingWrappedActionEffect(fake, seedActionBindings(ACTION_WIRED), {
      detectSecret: defaultExecSecretDetector,
    });
    const res = await effect({
      tool: "drive.files.delete",
      context: validCtx,
      args: { fileId: "file-123" },
    });
    expect(res.ok).toBe(true);
    expect(fake.invokeCalls.length).toBe(1);
    const desc = fake.invokeCalls[0]?.descriptor as ActionDescriptor;
    expect(desc.service).toBe("drive");
    expect(desc.method).toBe("files.delete");
    expect(desc.params).toEqual({ fileId: "file-123" });
  });

  it("gmail.search + an EXTRA key -> strict argSchema denies; connector NEVER called", async () => {
    const fake = new FakeActionConnector();
    const effect = bindingWrappedActionEffect(fake, seedActionBindings(ACTION_WIRED), {
      detectSecret: defaultExecSecretDetector,
    });
    const res = await effect({
      tool: "gmail.search",
      context: validCtx,
      args: { query: "in:inbox", maxResults: 50 },
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("invalid action args");
    expect(fake.invokeCalls.length).toBe(0);
  });

  it("gmail.search valid -> connector receives {service:'gmail', method:'search', {query}}", async () => {
    const fake = new FakeActionConnector();
    const effect = bindingWrappedActionEffect(fake, seedActionBindings(ACTION_WIRED), {
      detectSecret: defaultExecSecretDetector,
    });
    const res = await effect({
      tool: "gmail.search",
      context: validCtx,
      args: { query: "from:boss is:unread" },
    });
    expect(res.ok).toBe(true);
    expect(fake.invokeCalls.length).toBe(1);
    const desc = fake.invokeCalls[0]?.descriptor as ActionDescriptor;
    expect(desc.service).toBe("gmail");
    expect(desc.method).toBe("search");
    expect(desc.params).toEqual({ query: "from:boss is:unread" });
  });

  it("a LITERAL secret in a new action's param -> credential-blind INPUT guard denies; NEVER called", async () => {
    const fake = new FakeActionConnector();
    const effect = bindingWrappedActionEffect(fake, seedActionBindings(ACTION_WIRED), {
      detectSecret: defaultExecSecretDetector,
    });
    const canary = secretCanary();
    const res = await effect({
      tool: "gmail.search",
      context: validCtx,
      args: { query: `from:boss ${canary}` },
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("credential-blind");
    expect(fake.invokeCalls.length).toBe(0);
  });
});

// ==================================================================================================
// RED3 — buildActionProjectionForCall: projector emits networkHosts (non-empty) + NEVER the params.
// ==================================================================================================
describe("ACT2 — buildActionProjectionForCall: host-only projection, NO params (the 4 new actions)", () => {
  const lookup = (name: string) => seedActionRegistry(ACTION_WIRED).lookup(name);

  it("calendar.events.create -> networkHosts=[calendar host]; NO param value/key in the projection", () => {
    // Distinctive value canaries (so the assertion is robust) for each of {summary,start,end}.
    const proj = buildActionProjectionForCall(
      {
        tool: "calendar.events.create",
        args: {
          summary: "canarySummaryXYZ",
          start: "canaryStartXYZ",
          end: "canaryEndXYZ",
        },
      },
      seedActionBindings(ACTION_WIRED),
      lookup,
      "effectful",
    );
    expect(proj).toBeDefined();
    expect(proj?.networkHosts).toEqual([CALENDAR_HOST]);
    expect(proj?.operationClass).toContain("calendar");
    const blob = JSON.stringify(proj);
    // NO param VALUE reaches the projection.
    expect(blob).not.toContain("canarySummaryXYZ");
    expect(blob).not.toContain("canaryStartXYZ");
    expect(blob).not.toContain("canaryEndXYZ");
    // NO distinctive param KEY reaches the projection either.
    expect(blob).not.toContain("summary");
  });

  it("calendar.events.list -> networkHosts non-empty; NO timeMin/timeMax in the projection", () => {
    const proj = buildActionProjectionForCall(
      { tool: "calendar.events.list", args: { timeMin: "2026-01-01", timeMax: "2026-02-01" } },
      seedActionBindings(ACTION_WIRED),
      lookup,
      "effectful",
    );
    expect(proj).toBeDefined();
    expect((proj?.networkHosts.length ?? 0) > 0).toBe(true);
    const blob = JSON.stringify(proj);
    expect(blob).not.toContain("timeMin");
    expect(blob).not.toContain("2026-01-01");
  });

  it("drive.files.delete -> networkHosts non-empty; NO fileId in the projection", () => {
    const proj = buildActionProjectionForCall(
      { tool: "drive.files.delete", args: { fileId: "secret-file-id" } },
      seedActionBindings(ACTION_WIRED),
      lookup,
      "effectful",
    );
    expect(proj).toBeDefined();
    expect((proj?.networkHosts.length ?? 0) > 0).toBe(true);
    const blob = JSON.stringify(proj);
    expect(blob).not.toContain("secret-file-id");
    expect(blob).not.toContain("fileId");
  });

  it("gmail.search -> networkHosts non-empty; NO query in the projection", () => {
    const proj = buildActionProjectionForCall(
      { tool: "gmail.search", args: { query: "secret-query-text" } },
      seedActionBindings(ACTION_WIRED),
      lookup,
      "effectful",
    );
    expect(proj).toBeDefined();
    expect((proj?.networkHosts.length ?? 0) > 0).toBe(true);
    const blob = JSON.stringify(proj);
    expect(blob).not.toContain("secret-query-text");
    expect(blob).not.toContain("query");
  });

  it("an INVALID new-action call (extra key) -> the strict-validate gate yields undefined", () => {
    const proj = buildActionProjectionForCall(
      { tool: "drive.files.delete", args: { fileId: "f", permanent: true } },
      seedActionBindings(ACTION_WIRED),
      lookup,
      "effectful",
    );
    expect(proj).toBeUndefined();
  });
});

// ==================================================================================================
// RED4 — registration gated: each new action registers ONLY when its required primitive(s) are wired;
//        a registry MISSING the needed primitive => assertRegisterable THROWS.
// ==================================================================================================
describe("ACT2 — seedActionRegistry conditional registration (the 4 new actions, deny-by-default)", () => {
  it("ALL 4 new actions REGISTER when egress-allowlist + approval are both wired", () => {
    const reg = seedActionRegistry(ACTION_WIRED);
    expect(reg.lookup("calendar.events.create")?.name).toBe("calendar.events.create");
    expect(reg.lookup("calendar.events.list")?.name).toBe("calendar.events.list");
    expect(reg.lookup("drive.files.delete")?.name).toBe("drive.files.delete");
    expect(reg.lookup("gmail.search")?.name).toBe("gmail.search");
  });

  it("a registry MISSING egress-allowlist refuses the new actions (network-egress) — THROWS", () => {
    // approval wired but NOT egress-allowlist. Every new action is network-egress => requires egress
    // => the conditional registration ATTEMPTS and assertRegisterable refuses.
    expect(() => seedActionRegistry(new Set(["approval"]))).toThrow();
  });

  it("a registry MISSING approval refuses drive.files.delete (destructive needs approval) — THROWS", () => {
    // egress-allowlist wired but NOT approval. drive.files.delete is destructive => requires approval
    // => refused (the seed registry attempts to register it and assertRegisterable throws).
    expect(() => seedActionRegistry(new Set(["egress-allowlist"]))).toThrow();
  });

  it("the DEFAULT (no primitives wired) registers NONE of the new actions (no attempt, no throw)", () => {
    const reg = seedActionRegistry(new Set());
    expect(reg.lookup("calendar.events.create")).toBeUndefined();
    expect(reg.lookup("calendar.events.list")).toBeUndefined();
    expect(reg.lookup("drive.files.delete")).toBeUndefined();
    expect(reg.lookup("gmail.search")).toBeUndefined();
  });

  it("seedActionBindings carries ALL 4 new bindings when the full {egress,approval} set is wired", () => {
    const bindings = seedActionBindings(ACTION_WIRED);
    expect(bindings.has("calendar.events.create")).toBe(true);
    expect(bindings.has("calendar.events.list")).toBe(true);
    expect(bindings.has("drive.files.delete")).toBe(true);
    expect(bindings.has("gmail.search")).toBe(true);
  });

  it("seedActionBindings is EMPTY for a pure-exec composition (no action primitive wired)", () => {
    const bindings = seedActionBindings(new Set());
    expect(bindings.size).toBe(0);
  });
});
