/**
 * SLICE-HDI1 — `buildHermesMcpAddArgv` UNIT tests (in `pnpm run verify`, hermetic, NO live, NO Hermes).
 *
 * HDI1 makes a real Hermes DESKTOP user able to use Agent OS by registering our governed MCP bin into
 * Hermes Desktop's `~/.hermes/config.yaml` `mcp_servers` map — VIA Hermes's own `hermes mcp add` CLI
 * (Hermes owns the config.yaml format, so the install DELEGATES rather than hand-editing YAML). The
 * unit-testable, Hermes-free core is the PURE function `buildHermesMcpAddArgv`, which builds the exact
 * argv vector for that CLI.
 *
 * The two things HDI1 pins in-repo (the live drive — a real Hermes Desktop reading config.yaml and
 * autonomously calling our governed tools — is user-initiated, gated, and OUT of verify):
 *
 *   1. ARGV CORRECTNESS — the argv has the Hermes-CLI shape:
 *        ["mcp","add", <name>, "--command","node", "--env", K=V…, "--args", <binPath>]
 *      with the load-bearing constraint that `--args` is the LAST flag (Hermes parses it with
 *      nargs=REMAINDER, so everything after `--args` is the bin's args vector — it MUST come last or it
 *      would swallow the `--env` pairs). NON-VACUITY: a mutation that emits `--args` BEFORE `--env`
 *      flips the order assertion RED.
 *
 *   2. CREDENTIAL-BLINDNESS — the install writes ONLY non-secret inputs (the bin path + NON-secret
 *      OpenShell/kernel host:port endpoints). A secret-shaped env value makes the builder THROW (a
 *      secret must NEVER be emitted into the install argv / into config.yaml). NON-VACUITY: removing the
 *      guard makes the secret-rejection test RED. The secret CANARY is built at RUNTIME (never a source
 *      literal) so `secret-scan` stays clean.
 *
 * No subprocess, no model, no AGENTOS_LIVE_*, no `~/.hermes` access — pure unit.
 */
import { describe, expect, it } from "vitest";
import {
  buildHermesMcpAddArgv,
  renderHermesConfigYamlSnippet,
  renderHermesMcpServersConfigYaml,
} from "./hermes-desktop-install.js";

/** The non-secret endpoint env a real install threads into the bin (host:port + an mTLS DIR path). */
const ENDPOINTS = {
  AGENTOS_OPENSHELL_ENDPOINT: "127.0.0.1:17670",
  AGENTOS_OPENSHELL_MTLS: "/home/u/.config/openshell/gateways/openshell/mtls",
  AGENTOS_KERNEL_INGEST_ENDPOINT: "127.0.0.1:50543",
};
const BIN = "/abs/path/to/dist/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.js";

/** Runtime-built secret canary matching audit/redact's `sk-...` shape (NOT a source literal). */
function secretCanary(): string {
  return `sk-${"a1B2c3D4".repeat(3)}`; // 24 alnum chars => matches /sk-[A-Za-z0-9]{16,}/
}

describe("HDI1 — buildHermesMcpAddArgv builds the `hermes mcp add` argv (delegates to Hermes's own CLI)", () => {
  it("emits the correct argv shape: mcp add <name> --command node --env K=V… --args <bin>", () => {
    const argv = buildHermesMcpAddArgv({ binPath: BIN, env: ENDPOINTS });
    // Leading subcommand + default name + the stdio command.
    expect(argv.slice(0, 5)).toEqual(["mcp", "add", "agentos-exec", "--command", "node"]);
    // Every endpoint surfaces as a KEY=VALUE token under --env.
    expect(argv).toContain("--env");
    expect(argv).toContain("AGENTOS_OPENSHELL_ENDPOINT=127.0.0.1:17670");
    expect(argv).toContain(
      "AGENTOS_OPENSHELL_MTLS=/home/u/.config/openshell/gateways/openshell/mtls",
    );
    expect(argv).toContain("AGENTOS_KERNEL_INGEST_ENDPOINT=127.0.0.1:50543");
    // The bin path is the FINAL token (REMAINDER args vector for the spawned `node` process).
    expect(argv[argv.length - 1]).toBe(BIN);
  });

  it("CRITICAL / NON-VACUITY: `--args` is the LAST flag and is followed by EXACTLY the bin path (nargs=REMAINDER)", () => {
    const argv = buildHermesMcpAddArgv({ binPath: BIN, env: ENDPOINTS });
    const argsIdx = argv.indexOf("--args");
    const envIdx = argv.indexOf("--env");
    expect(argsIdx).toBeGreaterThan(-1);
    expect(envIdx).toBeGreaterThan(-1);
    // `--env` MUST precede `--args`: Hermes parses --args with nargs=REMAINDER, so anything after it is
    // swallowed into the bin's args vector. A mutation that puts --args before --env (so REMAINDER eats
    // the KEY=VALUE pairs) flips THIS assertion RED.
    expect(envIdx).toBeLessThan(argsIdx);
    // `--args` is the LAST flag: exactly one token (the bin path) follows it, and nothing else.
    expect(argv.slice(argsIdx)).toEqual(["--args", BIN]);
    // No --env / --command appears AFTER --args (they would be swallowed by REMAINDER).
    expect(argv.slice(argsIdx + 1)).not.toContain("--env");
    expect(argv.slice(argsIdx + 1)).not.toContain("--command");
  });

  it("name defaults to agentos-exec and is overridable; command is always node", () => {
    const dflt = buildHermesMcpAddArgv({ binPath: BIN, env: {} });
    expect(dflt[2]).toBe("agentos-exec");
    expect(dflt).toContain("--command");
    expect(dflt[dflt.indexOf("--command") + 1]).toBe("node");
    const named = buildHermesMcpAddArgv({ name: "my-agentos", binPath: BIN, env: {} });
    expect(named[2]).toBe("my-agentos");
  });

  it("with no env, --args still trails immediately (no dangling --env)", () => {
    const argv = buildHermesMcpAddArgv({ binPath: BIN, env: {} });
    expect(argv[argv.length - 2]).toBe("--args");
    expect(argv[argv.length - 1]).toBe(BIN);
    // With zero endpoints there is no --env flag emitted (an empty --env would be a dangling nargs=*).
    expect(argv).not.toContain("--env");
  });
});

describe("HDI1 — credential-blindness of the install (writes ONLY non-secret inputs)", () => {
  it("NON-VACUITY: a secret-shaped env VALUE makes the builder THROW (never emits a secret into the argv)", () => {
    expect(() =>
      buildHermesMcpAddArgv({
        binPath: BIN,
        env: { ...ENDPOINTS, AGENTOS_OPENSHELL_TOKEN: secretCanary() },
      }),
    ).toThrow(/credential-blind|secret/i);
  });

  it("a secret-shaped env KEY name with a secret value is rejected (the guard runs over the rendered K=V)", () => {
    expect(() => buildHermesMcpAddArgv({ binPath: BIN, env: { API_KEY: secretCanary() } })).toThrow(
      /credential-blind|secret/i,
    );
  });

  it("the legit-endpoints argv contains NO secret-shaped token (positive credential-blind proof)", () => {
    const argv = buildHermesMcpAddArgv({ binPath: BIN, env: ENDPOINTS });
    const blob = JSON.stringify(argv);
    // No `sk-…`-shaped token slipped through; the only values are host:port + a filesystem path + the bin.
    expect(/sk-[A-Za-z0-9]{16,}/.test(blob)).toBe(false);
  });

  it("benign endpoints (host:port + mTLS DIR path) are NOT over-blocked", () => {
    expect(() => buildHermesMcpAddArgv({ binPath: BIN, env: ENDPOINTS })).not.toThrow();
  });
});

describe("HDI1 — renderHermesConfigYamlSnippet (the manual no-hermes fallback)", () => {
  it("renders an mcp_servers.<name> block with command/args/env for the no-hermes clean-block path", () => {
    const snippet = renderHermesConfigYamlSnippet({ binPath: BIN, env: ENDPOINTS });
    expect(snippet).toContain("mcp_servers:");
    expect(snippet).toContain("agentos-exec:");
    expect(snippet).toContain("command: node");
    expect(snippet).toContain(BIN);
    expect(snippet).toContain("AGENTOS_OPENSHELL_ENDPOINT");
    expect(snippet).toContain("127.0.0.1:17670");
  });

  it("the manual snippet is ALSO credential-blind: a secret-shaped env value THROWS", () => {
    expect(() =>
      renderHermesConfigYamlSnippet({ binPath: BIN, env: { TOKEN: secretCanary() } }),
    ).toThrow(/credential-blind|secret/i);
  });
});

/**
 * A MINIMAL, test-local YAML structure reader for the fixed Hermes config.yaml shape this slice emits
 * (no YAML dependency exists in the repo + no new dep is allowed). It is indentation-aware enough to
 * answer the two NON-VACUITY questions the structure assertions hinge on:
 *
 *   • is `mcp_servers:` a TOP-LEVEL (column-0) mapping key?  (a mutation that drops it -> the
 *     `mcp_servers.<name>` lookup returns undefined -> the structure assertion goes RED.)
 *   • is the server's `env:` rendered as a MAP (a `KEY: value` child) and NOT as a LIST (`- KEY=value`)?
 *     (a mutation that emits env as a list -> `env` parses as `{}` with the list ignored -> the
 *     "env carries KEY: value" assertion goes RED.)
 *
 * It is intentionally tiny: it walks the exact 2-space-indented shape the renderer produces — top-level
 * keys at column 0, the server name at 2 spaces, command/args/env at 4 spaces, env entries at 6 spaces.
 */
interface ParsedConfig {
  /** True iff `mcp_servers:` appears as a TOP-LEVEL (column-0) mapping key. */
  hasTopLevelMcpServers: boolean;
  /** The server names found under `mcp_servers:` (column-2 mapping keys). */
  serverNames: string[];
  /** For a server: its scalar fields (command), the args LIST, and the env MAP — by structural shape. */
  servers: Record<
    string,
    {
      command?: string;
      args: string[];
      /** env parsed as a MAP only — a list-shaped env yields an EMPTY map (the non-vacuity trip). */
      env: Record<string, string>;
      /** True iff the server's `env:` child was rendered as a YAML LIST (`- …`) rather than a MAP. */
      envWasList: boolean;
    }
  >;
}

function parseHermesConfig(yaml: string): ParsedConfig {
  const lines = yaml.split("\n");
  const result: ParsedConfig = { hasTopLevelMcpServers: false, serverNames: [], servers: {} };
  let inMcpServers = false;
  let currentServer: string | undefined;
  // Which 4-space child block of the current server we are inside (so we can read its env-map / args-list).
  let childKey: "args" | "env" | undefined;

  for (const raw of lines) {
    if (raw.trim() === "") continue;
    const indent = raw.length - raw.replace(/^ +/, "").length;
    const content = raw.trim();

    if (indent === 0) {
      // Top-level key.
      inMcpServers = content === "mcp_servers:";
      if (inMcpServers) result.hasTopLevelMcpServers = true;
      currentServer = undefined;
      childKey = undefined;
      continue;
    }
    if (!inMcpServers) continue;

    if (indent === 2 && content.endsWith(":")) {
      // A server name under mcp_servers.
      currentServer = content.slice(0, -1);
      result.serverNames.push(currentServer);
      result.servers[currentServer] = { args: [], env: {}, envWasList: false };
      childKey = undefined;
      continue;
    }
    if (currentServer === undefined) continue;
    const server = result.servers[currentServer];
    if (server === undefined) continue;

    if (indent === 4) {
      childKey = undefined;
      if (content.startsWith("command:")) {
        server.command = content.slice("command:".length).trim();
      } else if (content === "args:") {
        childKey = "args";
      } else if (content === "env:") {
        childKey = "env";
      }
      continue;
    }
    if (indent >= 6) {
      if (childKey === "args" && content.startsWith("- ")) {
        // A YAML list item: strip leading "- " and any surrounding quotes.
        server.args.push(content.slice(2).replace(/^"(.*)"$/, "$1"));
      } else if (childKey === "env") {
        if (content.startsWith("- ")) {
          // env rendered as a LIST (the non-vacuity mutation) — record it but DO NOT populate the map.
          server.envWasList = true;
        } else {
          const colon = content.indexOf(":");
          if (colon > 0) {
            const k = content.slice(0, colon).trim();
            const v = content
              .slice(colon + 1)
              .trim()
              .replace(/^"(.*)"$/, "$1");
            server.env[k] = v;
          }
        }
      }
    }
  }
  return result;
}

/** Fetch a parsed server by name, failing the test (not throwing TS-undefined) if it is absent. */
function serverOf(cfg: ParsedConfig, name: string): ParsedConfig["servers"][string] {
  const server = cfg.servers[name];
  expect(
    server,
    `expected mcp_servers.${name} to be present in the parsed config.yaml`,
  ).toBeDefined();
  if (server === undefined) throw new Error(`mcp_servers.${name} missing`);
  return server;
}

describe("HDI1-FIX — renderHermesMcpServersConfigYaml (the HEADLESS config.yaml direct-write path)", () => {
  it("emits a parseable config.yaml with a TOP-LEVEL mcp_servers.<name> whose command=node + args=[bin] + env MAP", () => {
    const yaml = renderHermesMcpServersConfigYaml({ binPath: BIN, env: ENDPOINTS });
    const cfg = parseHermesConfig(yaml);

    // STRUCTURE (NON-VACUITY): drop the top-level `mcp_servers:` key -> this goes RED.
    expect(cfg.hasTopLevelMcpServers).toBe(true);
    expect(cfg.serverNames).toContain("agentos-exec");

    const server = serverOf(cfg, "agentos-exec");
    expect(server.command).toBe("node");
    // args is a LIST whose single element is the bin path.
    expect(server.args).toEqual([BIN]);

    // env is a MAP (NOT a list): each endpoint surfaces as a KEY: value pair. NON-VACUITY: emitting env as
    // a list (`- KEY=value`) parses to an EMPTY env map + envWasList=true -> the next assertions go RED.
    expect(server.envWasList).toBe(false);
    expect(server.env.AGENTOS_OPENSHELL_ENDPOINT).toBe("127.0.0.1:17670");
    expect(server.env.AGENTOS_OPENSHELL_MTLS).toBe(
      "/home/u/.config/openshell/gateways/openshell/mtls",
    );
    expect(server.env.AGENTOS_KERNEL_INGEST_ENDPOINT).toBe("127.0.0.1:50543");
  });

  it("the bin path + each endpoint value appear verbatim in the rendered file body", () => {
    const yaml = renderHermesMcpServersConfigYaml({ binPath: BIN, env: ENDPOINTS });
    expect(yaml).toContain("mcp_servers:");
    expect(yaml).toContain(BIN);
    expect(yaml).toContain("127.0.0.1:17670");
    expect(yaml).toContain("127.0.0.1:50543");
    expect(yaml).toContain("/home/u/.config/openshell/gateways/openshell/mtls");
  });

  it("name defaults to agentos-exec and is overridable", () => {
    const dflt = parseHermesConfig(renderHermesMcpServersConfigYaml({ binPath: BIN, env: {} }));
    expect(dflt.serverNames).toContain("agentos-exec");
    const named = parseHermesConfig(
      renderHermesMcpServersConfigYaml({ name: "my-agentos", binPath: BIN, env: {} }),
    );
    expect(named.serverNames).toContain("my-agentos");
    const namedServer = serverOf(named, "my-agentos");
    expect(namedServer.command).toBe("node");
    expect(namedServer.args).toEqual([BIN]);
  });

  it("with no env, the server omits an env block entirely (no dangling empty map)", () => {
    const yaml = renderHermesMcpServersConfigYaml({ binPath: BIN, env: {} });
    expect(yaml).not.toContain("env:");
    const cfg = parseHermesConfig(yaml);
    expect(serverOf(cfg, "agentos-exec").env).toEqual({});
  });

  it("CREDENTIAL-BLIND / NON-VACUITY: a secret-shaped env VALUE makes the renderer THROW (no secret in the file)", () => {
    expect(() =>
      renderHermesMcpServersConfigYaml({
        binPath: BIN,
        env: { ...ENDPOINTS, AGENTOS_OPENSHELL_TOKEN: secretCanary() },
      }),
    ).toThrow(/credential-blind|secret/i);
  });

  it("the legit-endpoints config.yaml contains NO secret-shaped token (positive credential-blind proof)", () => {
    const yaml = renderHermesMcpServersConfigYaml({ binPath: BIN, env: ENDPOINTS });
    expect(/sk-[A-Za-z0-9]{16,}/.test(yaml)).toBe(false);
  });

  it("benign endpoints (host:port + mTLS DIR path) are NOT over-blocked", () => {
    expect(() => renderHermesMcpServersConfigYaml({ binPath: BIN, env: ENDPOINTS })).not.toThrow();
  });
});
