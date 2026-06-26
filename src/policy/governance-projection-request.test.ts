/**
 * SLICE-R9b-2a — PolicyRequest carries an OPTIONAL credential-blind GovernanceProjection (RED-first).
 *
 * R9b-1 built the projection (inert). R9b-2a lets a PolicyRequest CARRY it so the (also-new) AGT
 * endpoint adapter can read it. Invariants pinned here:
 *   - PolicyRequest parses WITH a governanceProjection and WITHOUT it (optional).
 *   - The PDP IGNORES the projection: an allow/deny verdict is byte-identical whether the projection
 *     is present, absent, or set to a different value (evaluatePolicy only keys on action/resource/
 *     tenant). Default undefined -> the request shape is byte-identical to today.
 */
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "./evaluate.js";
import { type GovernanceProjection, buildExecRunProjection } from "./governance-projection.js";
import { PolicyRequest } from "./types.js";

const base = {
  requestId: "req-1",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  actorId: "agent:claude",
  action: "exec.run",
  resource: "exec/run",
} as const;

const projection: GovernanceProjection = buildExecRunProjection({ argv: ["rm", "-rf", "/tmp/x"] });

describe("PolicyRequest.governanceProjection — optional, credential-blind advisory field", () => {
  it("parses WITHOUT a governanceProjection (default undefined; byte-identical to today)", () => {
    const parsed = PolicyRequest.parse(base);
    expect(parsed.governanceProjection).toBeUndefined();
  });

  it("parses WITH a governanceProjection and preserves its fields", () => {
    const parsed = PolicyRequest.parse({ ...base, governanceProjection: projection });
    expect(parsed.governanceProjection).toBeDefined();
    expect(parsed.governanceProjection?.version).toBe(1);
    expect(parsed.governanceProjection?.operationClass).toBe("filesystem");
    expect(parsed.governanceProjection?.destructiveFlags).toContain("-rf");
  });

  it("SLICE-CAP9: the schema carries writeTargets (parallel to networkHosts); defaults [] for exec.run", () => {
    const parsed = PolicyRequest.parse({ ...base, governanceProjection: projection });
    expect(parsed.governanceProjection?.writeTargets).toEqual([]);
    // A projection WITH writeTargets parses + preserves them (the shape a host-fs-write projector emits).
    const withWrites = PolicyRequest.parse({
      ...base,
      governanceProjection: { ...projection, writeTargets: ["/work/out.txt"] },
    });
    expect(withWrites.governanceProjection?.writeTargets).toEqual(["/work/out.txt"]);
  });

  it("rejects a malformed governanceProjection (wrong version literal) — fail-closed schema", () => {
    const bad = { ...base, governanceProjection: { ...projection, version: 2 } };
    expect(PolicyRequest.safeParse(bad).success).toBe(false);
  });
});

describe("PDP IGNORES governanceProjection (the projection never changes the verdict)", () => {
  const allowRule = { id: "a-1", action: "exec.run", resource: "exec/run" } as const;

  it("an allow verdict is identical with, without, and with a different projection", () => {
    const without = evaluatePolicy(base, [allowRule]);
    const withProj = evaluatePolicy({ ...base, governanceProjection: projection }, [allowRule]);
    const withOther = evaluatePolicy(
      { ...base, governanceProjection: buildExecRunProjection({ argv: ["echo", "hi"] }) },
      [allowRule],
    );
    expect(without.effect).toBe("allow");
    expect(withProj).toEqual(without);
    expect(withOther).toEqual(without);
  });

  it("a deny-by-default verdict is identical with and without a projection", () => {
    const without = evaluatePolicy(base, []);
    const withProj = evaluatePolicy({ ...base, governanceProjection: projection }, []);
    expect(without.effect).toBe("deny");
    expect(withProj).toEqual(without);
  });
});
