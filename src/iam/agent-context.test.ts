import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { parseAgentContext } from "./ids.js";

const valid = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

describe("parseAgentContext — fail-closed identity aggregate", () => {
  it("accepts a valid context and exposes all identity fields", () => {
    const ctx = parseAgentContext(valid);
    expect(`${ctx.tenantId}`).toBe("tenant-a");
    expect(`${ctx.actorId}`).toBe("agent:claude");
    expect(`${ctx.projectId}`).toBe("proj-1");
    expect(`${ctx.taskId}`).toBe("task-1");
    expect(`${ctx.requestId}`).toBe("req-1");
    expect(ctx.sandboxId).toBeUndefined();
  });

  it("accepts an optional sandboxId", () => {
    const ctx = parseAgentContext({ ...valid, sandboxId: "sbx-1" });
    expect(`${ctx.sandboxId}`).toBe("sbx-1");
  });

  it("throws when a required id is missing (fail-closed, no partial context)", () => {
    const missing = {
      actorId: valid.actorId,
      projectId: valid.projectId,
      taskId: valid.taskId,
      requestId: valid.requestId,
      // tenantId omitted
    };
    expect(() => parseAgentContext(missing)).toThrow(ZodError);
  });

  it("throws on an empty or whitespace-only id", () => {
    expect(() => parseAgentContext({ ...valid, actorId: "" })).toThrow(ZodError);
    expect(() => parseAgentContext({ ...valid, requestId: "   " })).toThrow(ZodError);
  });

  it("throws on a non-object input (fail-closed)", () => {
    expect(() => parseAgentContext(null)).toThrow(ZodError);
    expect(() => parseAgentContext("nope")).toThrow(ZodError);
  });
});
