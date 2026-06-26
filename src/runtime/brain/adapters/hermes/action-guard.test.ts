/**
 * SLICE-ACT3a-guard (RED-first) — the real-connector SAFETY GATE: live-off-by-default + a test-account
 * allowlist, fail-closed. `createGuardedActionConnector` WRAPS any {@link ActionConnector} so that, once a
 * REAL MCP/OAuth transport is attached (ACT3a-live, BLOCKED), the connector can STRUCTURALLY only act on a
 * configured test account — and is DENY-ALL until `AGENTOS_ACTION_LIVE` is explicitly turned on.
 *
 * This file proves the GUARD as a pure unit (NO real MCP / OAuth / network / transport): the wrapper over a
 * FakeActionConnector (the `inner`) + a FakeAccountResolver. EVERY refusal asserts `inner.invoke` was NEVER
 * called (no side-effect at the connector). The HONEST BOUNDARY: ACT3a-guard is the verify-proven gate; the
 * real transport + the real account resolver (live auth) + the real send are ACT3a-live (deploy/auth-gated).
 *
 *   - DENY-BY-DEFAULT / FAIL-CLOSED: live off => refuse; empty allowlist => refuse; account ∉ allowlist =>
 *     refuse; resolver throws => refuse — each with inner NEVER called.
 *   - MASTER SWITCH: AGENTOS_ACTION_LIVE unset / "false" / blank => off (only exactly "true"/"1" => live).
 *   - MAIN-ACCOUNT PROTECTION: a resolved account not in the test allowlist (e.g. the user's main account)
 *     is refused.
 *   - CREDENTIAL-BLIND: the refusal `detail` is STATIC — a canary account never leaks into it.
 *   - NON-VACUITY: a mutant that skips the live check flips the live-off test RED; a mutant that skips the
 *     allowlist check flips the main-account test RED.
 */
import { describe, expect, it } from "vitest";
import {
  type ActionConnector,
  type ActionDescriptor,
  FakeActionConnector,
} from "./action-closed-loop.js";
import {
  type AccountResolver,
  FakeAccountResolver,
  actionGuardConfigFromEnv,
  actionLiveFromEnv,
  createGuardedActionConnector,
  testAccountsFromEnv,
} from "./action-guard.js";

const ctx = { actorId: "agent:hermes", tenantId: "tenant-a", taskId: "task-1" };

const descriptor: ActionDescriptor = {
  service: "gmail",
  method: "send",
  params: { to: "someone@example.com", subject: "hi", body: "hello" },
};

/**
 * A runtime-built account string that LOOKS like a leaked credential canary. NOT a source secret — used to
 * prove the refusal `detail` never echoes the resolved account (credential-blind static reason).
 */
function canaryAccount(): string {
  return `main+CANARY-${"x9".repeat(4)}@x`;
}

// ==================================================================================================
// RED1 — master switch / deny-by-default: live OFF => refuse, inner NEVER called.
// ==================================================================================================
describe("createGuardedActionConnector — live off (master switch, deny-by-default)", () => {
  it("config.live=false => refuse, FakeActionConnector.invoke NEVER called", async () => {
    const inner = new FakeActionConnector();
    const guarded = createGuardedActionConnector(inner, {
      live: false,
      testAccounts: ["test@x"],
      resolveAccount: new FakeAccountResolver("test@x"),
    });

    const result = await guarded.invoke(ctx, descriptor);

    expect(result.ok).toBe(false);
    expect(inner.invokeCalls.length).toBe(0);
  });

  it("AGENTOS_ACTION_LIVE unset => off => refuse, inner NEVER called", async () => {
    const inner = new FakeActionConnector();
    const guarded = createGuardedActionConnector(
      inner,
      actionGuardConfigFromEnv(
        { AGENTOS_ACTION_TEST_ACCOUNT: "test@x" },
        new FakeAccountResolver("test@x"),
      ),
    );

    const result = await guarded.invoke(ctx, descriptor);

    expect(result.ok).toBe(false);
    expect(inner.invokeCalls.length).toBe(0);
  });

  it('AGENTOS_ACTION_LIVE="false" => off => refuse, inner NEVER called', async () => {
    const inner = new FakeActionConnector();
    const guarded = createGuardedActionConnector(
      inner,
      actionGuardConfigFromEnv(
        { AGENTOS_ACTION_LIVE: "false", AGENTOS_ACTION_TEST_ACCOUNT: "test@x" },
        new FakeAccountResolver("test@x"),
      ),
    );

    const result = await guarded.invoke(ctx, descriptor);

    expect(result.ok).toBe(false);
    expect(inner.invokeCalls.length).toBe(0);
  });
});

// ==================================================================================================
// RED2 — live ON + account IN the test allowlist => delegate; inner receives the SAME descriptor.
// ==================================================================================================
describe("createGuardedActionConnector — live on + allowlisted test account => delegate", () => {
  it('live + testAccounts=["test@x"] + resolver->"test@x" => inner.invoke called ONCE with the same descriptor', async () => {
    const inner = new FakeActionConnector({ ok: true, detail: "fake action ok" });
    const guarded = createGuardedActionConnector(inner, {
      live: true,
      testAccounts: ["test@x"],
      resolveAccount: new FakeAccountResolver("test@x"),
    });

    const result = await guarded.invoke(ctx, descriptor);

    expect(result.ok).toBe(true);
    expect(inner.invokeCalls.length).toBe(1);
    // The guard is a transparent pass-through on the allowed path: the SAME context + descriptor reach inner.
    expect(inner.invokeCalls[0]?.context).toBe(ctx);
    expect(inner.invokeCalls[0]?.descriptor).toBe(descriptor);
  });
});

// ==================================================================================================
// RED3 — main-account protection: live ON but the resolved account is NOT in the allowlist => refuse.
// ==================================================================================================
describe("createGuardedActionConnector — account not in the test allowlist (main-account protection)", () => {
  it('live + resolver->"main@x" (∉ allowlist) => refuse, inner NEVER called', async () => {
    const inner = new FakeActionConnector();
    const guarded = createGuardedActionConnector(inner, {
      live: true,
      testAccounts: ["test@x"],
      resolveAccount: new FakeAccountResolver("main@x"),
    });

    const result = await guarded.invoke(ctx, descriptor);

    expect(result.ok).toBe(false);
    expect(inner.invokeCalls.length).toBe(0);
  });

  it("live + resolver->undefined (no resolvable account) => refuse, inner NEVER called", async () => {
    const inner = new FakeActionConnector();
    const guarded = createGuardedActionConnector(inner, {
      live: true,
      testAccounts: ["test@x"],
      resolveAccount: new FakeAccountResolver(undefined),
    });

    const result = await guarded.invoke(ctx, descriptor);

    expect(result.ok).toBe(false);
    expect(inner.invokeCalls.length).toBe(0);
  });
});

// ==================================================================================================
// RED4 — empty allowlist => deny-all (fail-closed), even when live + account resolves.
// ==================================================================================================
describe("createGuardedActionConnector — empty allowlist (deny-all, fail-closed)", () => {
  it("live + testAccounts=[] => refuse, inner NEVER called", async () => {
    const inner = new FakeActionConnector();
    const guarded = createGuardedActionConnector(inner, {
      live: true,
      testAccounts: [],
      resolveAccount: new FakeAccountResolver("test@x"),
    });

    const result = await guarded.invoke(ctx, descriptor);

    expect(result.ok).toBe(false);
    expect(inner.invokeCalls.length).toBe(0);
  });
});

// ==================================================================================================
// RED5 — fail-closed: a resolver that THROWS/REJECTS => refuse, inner NEVER called.
// ==================================================================================================
describe("createGuardedActionConnector — resolver throws (fail-closed)", () => {
  it("live + resolver THROWS => refuse, inner NEVER called", async () => {
    const inner = new FakeActionConnector();
    const guarded = createGuardedActionConnector(inner, {
      live: true,
      testAccounts: ["test@x"],
      resolveAccount: new FakeAccountResolver({ throws: true }),
    });

    const result = await guarded.invoke(ctx, descriptor);

    expect(result.ok).toBe(false);
    expect(inner.invokeCalls.length).toBe(0);
  });
});

// ==================================================================================================
// RED6 — env readers (fail-closed, mirroring egressAllowFromEnv).
// ==================================================================================================
describe("actionLiveFromEnv — only an exact true-token enables live (deny-by-default)", () => {
  it('"true" => true; "1" => true', () => {
    expect(actionLiveFromEnv({ AGENTOS_ACTION_LIVE: "true" })).toBe(true);
    expect(actionLiveFromEnv({ AGENTOS_ACTION_LIVE: "1" })).toBe(true);
  });

  it("unset / blank / other strings => false", () => {
    expect(actionLiveFromEnv({})).toBe(false);
    expect(actionLiveFromEnv({ AGENTOS_ACTION_LIVE: "" })).toBe(false);
    expect(actionLiveFromEnv({ AGENTOS_ACTION_LIVE: "  " })).toBe(false);
    expect(actionLiveFromEnv({ AGENTOS_ACTION_LIVE: "false" })).toBe(false);
    expect(actionLiveFromEnv({ AGENTOS_ACTION_LIVE: "TRUE" })).toBe(false);
    expect(actionLiveFromEnv({ AGENTOS_ACTION_LIVE: "yes" })).toBe(false);
    expect(actionLiveFromEnv({ AGENTOS_ACTION_LIVE: "true " })).toBe(false);
  });
});

describe("testAccountsFromEnv — comma / trim / blank-filter; unconfigured => []", () => {
  it("comma list => trimmed, blank-filtered", () => {
    expect(testAccountsFromEnv({ AGENTOS_ACTION_TEST_ACCOUNT: "a@x, b@x ,  , c@x" })).toEqual([
      "a@x",
      "b@x",
      "c@x",
    ]);
  });

  it("unset / blank / only-whitespace => []", () => {
    expect(testAccountsFromEnv({})).toEqual([]);
    expect(testAccountsFromEnv({ AGENTOS_ACTION_TEST_ACCOUNT: "" })).toEqual([]);
    expect(testAccountsFromEnv({ AGENTOS_ACTION_TEST_ACCOUNT: "   " })).toEqual([]);
    expect(testAccountsFromEnv({ AGENTOS_ACTION_TEST_ACCOUNT: " , , " })).toEqual([]);
  });
});

describe("actionGuardConfigFromEnv — assembles {live, testAccounts, resolveAccount}; unconfigured => off + []", () => {
  it("unconfigured env => live false + empty allowlist (deny-by-default)", () => {
    const resolver = new FakeAccountResolver("test@x");
    const config = actionGuardConfigFromEnv({}, resolver);
    expect(config.live).toBe(false);
    expect(config.testAccounts).toEqual([]);
    expect(config.resolveAccount).toBe(resolver);
  });

  it('AGENTOS_ACTION_LIVE="true" + accounts => live true + parsed allowlist', () => {
    const resolver = new FakeAccountResolver("test@x");
    const config = actionGuardConfigFromEnv(
      { AGENTOS_ACTION_LIVE: "true", AGENTOS_ACTION_TEST_ACCOUNT: "test@x, other@x" },
      resolver,
    );
    expect(config.live).toBe(true);
    expect(config.testAccounts).toEqual(["test@x", "other@x"]);
    expect(config.resolveAccount).toBe(resolver);
  });
});

// ==================================================================================================
// RED7 — credential-blind: a refusal with a CANARY account => the detail does NOT contain the canary.
// ==================================================================================================
describe("createGuardedActionConnector — credential-blind static refusal reason", () => {
  it("refusal detail never echoes the resolved (canary) account", async () => {
    const canary = canaryAccount();
    const inner = new FakeActionConnector();
    const guarded = createGuardedActionConnector(inner, {
      live: true,
      testAccounts: ["test@x"],
      resolveAccount: new FakeAccountResolver(canary),
    });

    const result = await guarded.invoke(ctx, descriptor);

    expect(result.ok).toBe(false);
    expect(result.detail ?? "").not.toContain(canary);
    expect(result.detail ?? "").not.toContain("CANARY");
    expect(inner.invokeCalls.length).toBe(0);
  });
});

// ==================================================================================================
// RED8 — port contract: AccountResolver is the deferred (ACT3a-live) seam; the Fake proves the wrapper.
// ==================================================================================================
describe("AccountResolver port + FakeAccountResolver", () => {
  it("FakeAccountResolver(fixed) resolves the fixed account regardless of context/descriptor", async () => {
    const resolver: AccountResolver = new FakeAccountResolver("fixed@x");
    expect(await resolver.resolveAccount(ctx, descriptor)).toBe("fixed@x");
    expect(await resolver.resolveAccount({ other: true }, descriptor)).toBe("fixed@x");
  });

  it("FakeAccountResolver(undefined) resolves undefined", async () => {
    const resolver = new FakeAccountResolver(undefined);
    expect(await resolver.resolveAccount(ctx, descriptor)).toBeUndefined();
  });

  it("FakeAccountResolver({throws:true}) rejects", async () => {
    const resolver = new FakeAccountResolver({ throws: true });
    await expect(resolver.resolveAccount(ctx, descriptor)).rejects.toThrow();
  });

  it("the guard satisfies the ActionConnector port", () => {
    const guarded: ActionConnector = createGuardedActionConnector(new FakeActionConnector(), {
      live: false,
      testAccounts: [],
      resolveAccount: new FakeAccountResolver(undefined),
    });
    expect(typeof guarded.invoke).toBe("function");
  });
});
