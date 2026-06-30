/**
 * SLICE-SETUP3 Step 5C/6 — `agentos config render | check`: the config COMPILER + drift guard (RED-first).
 *
 * Pins: renderArtifacts compiles each present section to a native artifact (env reference + OpenShell egress +
 * NemoClaw onboard) and ONLY when present; buildRenderLock hashes the source + targets; driftReport fail-closes
 * on any divergence; configCommand render writes `.agentos/rendered/*` + `render.lock.json`; check returns 0
 * IN-SYNC and non-zero on DRIFT; missing/invalid config or lock fail-closed. I/O is injected (no real FS).
 */
import { describe, expect, it } from "vitest";
import {
  type ConfigDeps,
  type RenderLock,
  buildRenderLock,
  configCommand,
  driftReport,
  renderArtifacts,
} from "./config.js";
import type { AgentOsConfig } from "./setup.js";

const BASE: AgentOsConfig = {
  openshell: { endpoint: "127.0.0.1:17670", mtlsDir: "/m", image: "img@sha256:abc" },
  kernel: { ingestEndpoint: "127.0.0.1:50051" },
};
const WITH_NP: AgentOsConfig = {
  ...BASE,
  openshell: {
    ...BASE.openshell,
    networkPolicy: { egressAllow: ["api.github.com"], gitEgressAllow: ["github.com"] },
  },
};
const WITH_NEMO: AgentOsConfig = { ...BASE, nemoclaw: { gateway: "benevolent-buck" } };

function makeDeps(seed: Record<string, string> = {}): {
  deps: ConfigDeps;
  store: Record<string, string>;
  printed: string[];
} {
  const store: Record<string, string> = { ...seed };
  const printed: string[] = [];
  const deps: ConfigDeps = {
    readFile: (p) => (p in store ? store[p] : undefined),
    writeFile: (p, c) => {
      store[p] = c;
    },
    print: (l) => {
      printed.push(l);
    },
  };
  return { deps, store, printed };
}

const CONFIG_PATH = "./agent-os.config.json";
const LOCK_PATH = ".agentos/render.lock.json";

describe("renderArtifacts — compile each present section; absent => no artifact", () => {
  it("BASE => only the registration.env reference (carrying the non-secret endpoints)", () => {
    const arts = renderArtifacts(BASE);
    expect(arts.map((a) => a.relPath)).toEqual(["registration.env"]);
    expect(arts[0]?.content).toContain("AGENTOS_OPENSHELL_ENDPOINT=127.0.0.1:17670");
  });

  it("networkPolicy => + openshell-egress.json (from buildEgressNetworkPolicies, matches the auto-provisioner)", () => {
    const arts = renderArtifacts(WITH_NP);
    const egress = arts.find((a) => a.relPath === "openshell-egress.json");
    expect(egress).toBeDefined();
    expect(egress?.content).toContain("api.github.com");
    expect(egress?.content).toContain("agentos_net_fetch");
    expect(egress?.content).toContain("agentos_git_push");
    // registration.env also carries the compiled egress env.
    expect(arts[0]?.content).toContain("AGENTOS_EGRESS_ALLOW=api.github.com");
  });

  it("nemoclaw => + nemoclaw-onboard.txt with the onboard command", () => {
    const arts = renderArtifacts(WITH_NEMO);
    const nemo = arts.find((a) => a.relPath === "nemoclaw-onboard.txt");
    expect(nemo?.content).toContain("nemohermes onboard --gateway benevolent-buck");
  });
});

describe("buildRenderLock + driftReport", () => {
  it("a fresh render of the SAME config is IN-SYNC", () => {
    const raw = JSON.stringify(WITH_NP);
    const lock = buildRenderLock("0.0.0", raw, renderArtifacts(WITH_NP));
    const { inSync } = driftReport(lock, raw, renderArtifacts(WITH_NP));
    expect(inSync).toBe(true);
  });

  it("a CHANGED config drifts (config hash + the affected target)", () => {
    const lock = buildRenderLock("0.0.0", JSON.stringify(BASE), renderArtifacts(BASE));
    const changedRaw = JSON.stringify(WITH_NEMO); // added nemoclaw
    const { inSync, lines } = driftReport(lock, changedRaw, renderArtifacts(WITH_NEMO));
    expect(inSync).toBe(false);
    expect(lines.join("\n")).toMatch(/DRIFT/);
  });
});

describe("configCommand render | check", () => {
  it("render: writes rendered targets + render.lock, exits 0, the lock parses", async () => {
    const { deps, store, printed } = makeDeps({ [CONFIG_PATH]: JSON.stringify(WITH_NP) });
    const code = await configCommand(["render"], {}, deps);
    expect(code).toBe(0);
    expect(store[LOCK_PATH]).toBeDefined();
    const lock = JSON.parse(store[LOCK_PATH] ?? "{}") as RenderLock;
    expect(lock.targets.length).toBeGreaterThanOrEqual(2); // registration.env + openshell-egress.json
    expect(printed.some((l) => l.includes("openshell-egress.json"))).toBe(true);
  });

  it("check: IN-SYNC right after render => exit 0", async () => {
    const { deps } = makeDeps({ [CONFIG_PATH]: JSON.stringify(WITH_NP) });
    expect(await configCommand(["render"], {}, deps)).toBe(0);
    expect(await configCommand(["check"], {}, deps)).toBe(0); // same deps/store: lock present + matches
  });

  it("check: DRIFT after the config changes => NON-ZERO (the CI staleness guard)", async () => {
    const { deps, store } = makeDeps({ [CONFIG_PATH]: JSON.stringify(BASE) });
    expect(await configCommand(["render"], {}, deps)).toBe(0);
    store[CONFIG_PATH] = JSON.stringify(WITH_NEMO); // edit the config without re-rendering
    expect(await configCommand(["check"], {}, deps)).not.toBe(0);
  });

  it("fail-closed: missing config => non-zero; check with no lock => non-zero; bad action => usage", async () => {
    expect(await configCommand(["render"], {}, makeDeps().deps)).not.toBe(0); // no config
    expect(
      await configCommand(["check"], {}, makeDeps({ [CONFIG_PATH]: JSON.stringify(BASE) }).deps),
    ).not.toBe(0); // no lock
    expect(await configCommand(["frobnicate"], {}, makeDeps().deps)).toBe(2); // unknown action
  });
});

// ================================================================================================
// Independent-Verifier fixes (D1 credential-blind render, D2 malformed-lock, D3 host de-dupe)
// ================================================================================================
describe("config compiler — IV hardening", () => {
  // an AWS-key-shaped value, assembled at runtime so no contiguous secret literal lives in the file.
  const SECRET_SHAPED = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

  it("D1 CREDENTIAL-BLIND: a secret-shaped value in a free-form field => render fail-closed, value-free, NO write", async () => {
    const cfg = { ...BASE, openshell: { ...BASE.openshell, image: SECRET_SHAPED } };
    const { deps, store, printed } = makeDeps({ [CONFIG_PATH]: JSON.stringify(cfg) });
    expect(await configCommand(["render"], {}, deps)).not.toBe(0);
    expect(store[LOCK_PATH]).toBeUndefined(); // screened BEFORE any write
    expect(printed.join("\n")).not.toContain(SECRET_SHAPED); // value-free error (names the artifact, not the value)
  });

  it("D2: a MALFORMED lock (valid JSON, missing targets[]) fails closed CLEANLY (no uncaught crash)", async () => {
    const { deps, store } = makeDeps({ [CONFIG_PATH]: JSON.stringify(BASE) });
    store[LOCK_PATH] = "{}"; // older-schema / hand-edited committed lock
    await expect(configCommand(["check"], {}, deps)).resolves.not.toBe(0); // returns, never throws
  });

  it("D3: duplicate egress hosts are de-duped to match the live auto-provisioner", () => {
    const dup = {
      ...BASE,
      openshell: {
        ...BASE.openshell,
        networkPolicy: { egressAllow: ["api.github.com", "api.github.com"] },
      },
    };
    const egress = renderArtifacts(dup).find((a) => a.relPath === "openshell-egress.json");
    const parsed = JSON.parse(egress?.content ?? "{}") as {
      network_policies: { agentos_net_fetch: { endpoints: unknown[] } };
    };
    expect(parsed.network_policies.agentos_net_fetch.endpoints.length).toBe(1); // de-duped, not 2
  });
});

// ================================================================================================
// (SLICE-SETUP3 #1) config schema — print the JSON Schema (editor autocomplete; no config needed)
// ================================================================================================
describe("config schema — print the JSON Schema", () => {
  it("prints valid JSON Schema for agent-os.config, exit 0, reads/writes NOTHING", async () => {
    const { deps, store, printed } = makeDeps(); // empty store: no config on disk
    const code = await configCommand(["schema"], {}, deps);
    expect(code).toBe(0);
    expect(Object.keys(store).length).toBe(0); // schema action neither reads a config nor writes
    const parsed = JSON.parse(printed.join("\n")) as { properties?: Record<string, unknown> };
    expect(parsed.properties?.openshell).toBeDefined(); // it IS the agent-os.config schema
  });
});
