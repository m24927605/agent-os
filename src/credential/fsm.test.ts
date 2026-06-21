import { describe, expect, it } from "vitest";
import { redactSecrets } from "../audit/redact.js";
import type { CredentialLease } from "./index.js";
import { LeaseEvent, expire, inject, mint, revoke, use } from "./index.js";

const validCtx = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
  sandboxId: "sbx-1",
};

const farFuture = 4_102_444_800_000; // 2100-01-01, comfortably in the future.

// A mint spec (no `state`/`now` — the FSM stamps `issued` itself).
const validSpec = {
  bundleRef: "anthropic-prod",
  context: validCtx,
  keys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  expiresAtMs: farFuture,
};

// Canary: a secret-SHAPED value assembled at RUNTIME so no literal secret touches source/scan.
// Matches audit/redact SECRET_VALUE (`sk-[A-Za-z0-9]{16,}`).
const secretCanary = `sk-${"a".repeat(24)}`;

const fixedNow = () => 1_000_000;

/** Helper: mint a valid issued lease (asserts ok along the way). */
function mintIssued(): CredentialLease {
  const t = mint(validSpec, fixedNow);
  if (t.status !== "ok") throw new Error(`expected mint ok, got ${JSON.stringify(t)}`);
  return t.lease;
}

describe("lease FSM — legal transitions, deny-by-default, fail-closed", () => {
  it("happy path: mint -> inject -> use, each ok with state issued -> injected -> used", () => {
    const minted = mint(validSpec, fixedNow);
    expect(minted.status).toBe("ok");
    if (minted.status !== "ok") return;
    expect(minted.lease.state).toBe("issued");
    expect(minted.event.transition).toBe("mint");
    expect(minted.event.toState).toBe("issued");

    const injected = inject(minted.lease);
    expect(injected.status).toBe("ok");
    if (injected.status !== "ok") return;
    expect(injected.lease.state).toBe("injected");

    const used = use(injected.lease, fixedNow);
    expect(used.status).toBe("ok");
    if (used.status !== "ok") return;
    expect(used.lease.state).toBe("used");
    // bundleRef + context are preserved across transitions (immutable lease identity).
    expect(used.lease.bundleRef).toBe("anthropic-prod");
  });

  it("revoke from any non-terminal state -> revoked (ok)", () => {
    const lease = mintIssued();
    const r = revoke(lease);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.lease.state).toBe("revoked");
  });

  it("expire when expiresAtMs <= now -> expired (ok)", () => {
    const lease = mintIssued();
    // now is strictly after expiry.
    const e = expire({ ...lease, expiresAtMs: 500_000 }, fixedNow);
    expect(e.status).toBe("ok");
    if (e.status !== "ok") return;
    expect(e.lease.state).toBe("expired");
  });

  it("expire when still in the future -> denied (not yet expired)", () => {
    const lease = mintIssued();
    const e = expire(lease, fixedNow);
    expect(e.status).toBe("denied");
  });

  describe("deny-by-default (adversarial)", () => {
    it("use without inject (issued -> use) is denied", () => {
      const lease = mintIssued();
      const t = use(lease, fixedNow);
      expect(t.status).toBe("denied");
    });

    it("inject/use after revoke is denied (terminal)", () => {
      const lease = mintIssued();
      const r = revoke(lease);
      if (r.status !== "ok") throw new Error("revoke should be ok");
      expect(inject(r.lease).status).toBe("denied");
      expect(use(r.lease, fixedNow).status).toBe("denied");
    });

    it("use after expire is denied (terminal)", () => {
      const lease = mintIssued();
      const e = expire({ ...lease, expiresAtMs: 500_000 }, fixedNow);
      if (e.status !== "ok") throw new Error("expire should be ok");
      expect(use(e.lease, fixedNow).status).toBe("denied");
      expect(inject(e.lease).status).toBe("denied");
    });

    it("re-transitioning a terminal lease (revoke/expire again) is denied", () => {
      const lease = mintIssued();
      const r = revoke(lease);
      if (r.status !== "ok") throw new Error("revoke should be ok");
      expect(revoke(r.lease).status).toBe("denied");
      expect(expire(r.lease, fixedNow).status).toBe("denied");
    });

    it("double inject (injected -> inject) is denied", () => {
      const lease = mintIssued();
      const i = inject(lease);
      if (i.status !== "ok") throw new Error("inject should be ok");
      expect(inject(i.lease).status).toBe("denied");
    });
  });

  describe("expiry fail-closed (clock-injected)", () => {
    it("use of an injected lease whose expiresAtMs <= now is denied (reason flags expired)", () => {
      const lease = mintIssued();
      const i = inject({ ...lease, expiresAtMs: 500_000 });
      if (i.status !== "ok") throw new Error("inject should be ok");
      // The injected lease has expiresAtMs (500_000) <= now (1_000_000): the use entry must
      // fail-closed even though state === "injected" (the expiry window invariant, design §2.2).
      const t = use(i.lease, fixedNow);
      expect(t.status).toBe("denied");
      if (t.status !== "denied") return;
      expect(t.reason.toLowerCase()).toContain("expire");
      // The denied event carries no secret.
      expect(redactSecrets(t.event)).toEqual(t.event);
    });

    it("the boundary expiresAtMs === now is treated as expired (<=, not <)", () => {
      const lease = mintIssued();
      const i = inject({ ...lease, expiresAtMs: fixedNow() });
      if (i.status !== "ok") throw new Error("inject should be ok");
      expect(use(i.lease, fixedNow).status).toBe("denied");
    });
  });

  describe("malformed -> deny (no throw that lets it through)", () => {
    it("a transition on a non-lease (missing state) is denied, not thrown", () => {
      const notALease = { bundleRef: "x", context: validCtx, keys: ["A"], expiresAtMs: farFuture };
      expect(() => inject(notALease as unknown as CredentialLease)).not.toThrow();
      expect(inject(notALease as unknown as CredentialLease).status).toBe("denied");
      expect(use(notALease as unknown as CredentialLease, fixedNow).status).toBe("denied");
      expect(revoke(notALease as unknown as CredentialLease).status).toBe("denied");
    });

    it("mint of a malformed spec (bad context) is denied, not thrown", () => {
      const { tenantId: _omit, ...badCtx } = validCtx;
      const badSpec = { ...validSpec, context: badCtx };
      expect(() => mint(badSpec as unknown as typeof validSpec, fixedNow)).not.toThrow();
      expect(mint(badSpec as unknown as typeof validSpec, fixedNow).status).toBe("denied");
    });

    it("a transition on null/garbage input is denied, not thrown", () => {
      expect(inject(null as unknown as CredentialLease).status).toBe("denied");
      expect(use("nope" as unknown as CredentialLease, fixedNow).status).toBe("denied");
    });
  });

  describe("event shape — auditable, no secret", () => {
    it("every transition event parses as LeaseEvent and survives redactSecrets unchanged", () => {
      const minted = mint(validSpec, fixedNow);
      const injected = minted.status === "ok" ? inject(minted.lease) : minted;
      const denied = use(mintIssued(), fixedNow); // issued -> use is denied

      for (const t of [minted, injected, denied]) {
        expect(() => LeaseEvent.parse(t.event)).not.toThrow();
        // Proof the event is born clean: redaction is a no-op.
        expect(redactSecrets(t.event)).toEqual(t.event);
        // And the event JSON never contains the secret canary shape.
        expect(JSON.stringify(t.event)).not.toContain(secretCanary);
      }
    });

    it("the event carries bundleRef + fromState/toState but no value-bearing field", () => {
      const minted = mint(validSpec, fixedNow);
      if (minted.status !== "ok") throw new Error("mint should be ok");
      expect(minted.event.bundleRef).toBe("anthropic-prod");
      expect(minted.event.result).toBe("ok");
      // No `keys` values, no secret — the event is reference-only.
      expect(JSON.stringify(minted.event)).not.toContain("ANTHROPIC_API_KEY");
    });
  });
});
