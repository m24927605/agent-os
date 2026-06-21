import { describe, expect, it } from "vitest";
import { FakeSandboxAdapter } from "../runtime/substrate/index.js";
import { commitBeforeEffect } from "./guard.js";

const validCtx = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

const receipt = { sequence: 1, entryHash: "sha256:deadbeef" };

describe("commitBeforeEffect — the effect runs ONLY after a durable append receipt", () => {
  it("runs the effect strictly AFTER the append resolves (ordering)", async () => {
    const order: string[] = [];
    const out = await commitBeforeEffect({
      appender: {
        append: async () => {
          order.push("append");
          return receipt;
        },
      },
      event: { kind: "probe" },
      effect: async () => {
        order.push("effect");
        return "done";
      },
    });
    expect(order).toEqual(["append", "effect"]);
    expect(out.status).toBe("committed");
    if (out.status === "committed") {
      expect(out.receipt).toBe(receipt);
      expect(out.result).toBe("done");
    }
  });

  it("ABORTS without running the effect when append REJECTS (kernel down / error)", async () => {
    let effectRan = false;
    const out = await commitBeforeEffect({
      appender: {
        append: async () => {
          throw new Error("kernel unavailable");
        },
      },
      event: { kind: "probe" },
      effect: async () => {
        effectRan = true;
        return "should-not-happen";
      },
    });
    expect(effectRan).toBe(false);
    expect(out.status).toBe("aborted");
    if (out.status === "aborted") expect(out.reason).toContain("kernel unavailable");
  });

  it("ABORTS without running the effect when append TIMES OUT (no receipt in time)", async () => {
    let effectRan = false;
    const out = await commitBeforeEffect({
      appender: {
        append: () => new Promise<typeof receipt>(() => {}),
      },
      event: { kind: "probe" },
      effect: async () => {
        effectRan = true;
        return "should-not-happen";
      },
      timeoutMs: 20,
    });
    expect(effectRan).toBe(false);
    expect(out.status).toBe("aborted");
    if (out.status === "aborted") expect(out.reason).toMatch(/timed out|timeout/i);
  });

  it("wired to the substrate adapter path: a failed commit produces NO sandbox effect", async () => {
    const fake = new FakeSandboxAdapter();
    const out = await commitBeforeEffect({
      appender: {
        append: async () => {
          throw new Error("kernel unavailable");
        },
      },
      event: { kind: "create-sandbox" },
      effect: () => fake.createSandbox(validCtx, { image: "x" }),
    });
    expect(out.status).toBe("aborted");
    // The sandbox was never created — a fresh sandbox would be sbx-fake-1; starting it must be
    // denied (unknown id) because create never ran.
    expect((await fake.startSandbox(validCtx, "sbx-fake-1")).status).toBe("denied");
  });

  it("wired to the substrate adapter path: a successful commit DOES run the sandbox effect", async () => {
    const fake = new FakeSandboxAdapter();
    const out = await commitBeforeEffect({
      appender: { append: async () => receipt },
      event: { kind: "create-sandbox" },
      effect: () => fake.createSandbox(validCtx, { image: "x" }),
    });
    expect(out.status).toBe("committed");
    if (out.status === "committed") expect(out.result.status).toBe("ok");
  });
});
