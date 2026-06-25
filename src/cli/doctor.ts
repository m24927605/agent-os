/**
 * Agent OS — `agentos doctor` preflight (SLICE-SETUP1b).
 *
 * A THIN, zero-third-party-dependency PREFLIGHT (Node built-ins only: `node:child_process`,
 * `node:fs`, `node:net`). It verifies — BEFORE a user runs Hermes — that the pieces autonomous
 * execution depends on are present and reachable, and prints one credential-blind line per check:
 *
 *     PASS|FAIL|SKIP  <name> — <hint>
 *
 * Fail-closed law: a non-zero exit if ANY required check FAILs; 0 ONLY when every required check
 * PASSes. A CONDITIONAL check (SpendGuard) SKIPs when unconfigured and never fails the run, but
 * FAILs (fail-closed) when configured-but-unreachable — the operator asked for it, so a missing
 * sidecar is a real problem.
 *
 * Honest scope: doctor is a PREFLIGHT. It changes NO governance and starts NO services and writes NO
 * config — it only reports reachability/registration. Provisioning/starting services and writing
 * config is the SETUP2 wizard, deferred.
 *
 * CREDENTIAL-BLIND: doctor prints ONLY check names, PASS/FAIL/SKIP, host:port / file paths / ENV KEY
 * NAMES, and static hints. It NEVER prints an env VALUE, a secret, or the contents of `~/.hermes`.
 * Registration is probed with Hermes's own READ-ONLY `hermes mcp list` — never by reading the config
 * file. No env value is ever interpolated into output.
 *
 * Testability: the I/O is INJECTABLE via the optional `probes` param, defaulting to the real
 * node-built-in implementations. Tests inject fakes to drive each PASS/FAIL/SKIP deterministically.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Env = NodeJS.ProcessEnv;

/** Fail-closed exit codes (mirrors main.ts). */
const EXIT_OK = 0;
const EXIT_DOCTOR_FAIL = 1;

/** Default endpoints used when the corresponding env var is unset. */
const DEFAULT_OPENSHELL = "127.0.0.1:17670";
const DEFAULT_KERNEL = "127.0.0.1:50051";

/** Short TCP-connect timeout (ms): a refused/timed-out connect is fail-closed (treated as down). */
const TCP_TIMEOUT_MS = 750;

/** Path of the built bin, RESOLVED from the repo root relative to this CLI module. */
const BIN_REL_PATH = "dist/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.js";

/**
 * Injectable I/O seam. Defaults to the real node-built-in implementations; tests inject fakes.
 * Each probe is credential-blind by construction — it returns booleans / read-only command output,
 * never an env value.
 */
export interface DoctorProbes {
  /** Whether `cmd` resolves on PATH (real: `command -v`). */
  commandExists(cmd: string): boolean;
  /** Whether a filesystem path exists (real: `fs.existsSync`). */
  fileExists(path: string): boolean;
  /** Whether a TCP `host:port` accepts a connection within the timeout (real: `net.connect`). */
  tcpReachable(host: string, port: number): Promise<boolean>;
  /** Hermes's READ-ONLY registry listing (real: `hermes mcp list`), or undefined if unavailable. */
  hermesMcpList(): string | undefined;
}

/** PASS/FAIL/SKIP outcome of one check. SKIP never fails the run; FAIL on a required check does. */
type Status = "PASS" | "FAIL" | "SKIP";

interface CheckResult {
  status: Status;
  /** True when this check participates in the fail-closed exit code (a required FAIL => non-zero). */
  required: boolean;
}

/** Real, node-built-in probe implementations (the production default). */
function realProbes(): DoctorProbes {
  return {
    commandExists(cmd: string): boolean {
      // `command -v` is a POSIX builtin; run via sh so it resolves aliases/builtins/PATH.
      const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
      return r.status === 0;
    },
    fileExists(path: string): boolean {
      return existsSync(path);
    },
    tcpReachable(host: string, port: number): Promise<boolean> {
      return new Promise((res) => {
        let settled = false;
        const done = (ok: boolean) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          res(ok);
        };
        const socket = connect({ host, port });
        socket.setTimeout(TCP_TIMEOUT_MS);
        socket.once("connect", () => done(true));
        socket.once("timeout", () => done(false)); // fail-closed: timeout => unreachable
        socket.once("error", () => done(false)); // fail-closed: refused/error => unreachable
      });
    },
    hermesMcpList(): string | undefined {
      // READ-ONLY: ask Hermes to list its own registry — NEVER read ~/.hermes config directly.
      const r = spawnSync("hermes", ["mcp", "list"], { encoding: "utf8" });
      if (r.error !== undefined || r.status !== 0) return undefined;
      return r.stdout ?? "";
    },
  };
}

/** The path of the built bin, resolved from the repo root (this module lives at <root>/{src,dist}/cli). */
function binPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  return resolve(repoRoot, BIN_REL_PATH);
}

/**
 * Split a "host:port" endpoint into its parts, fail-closed on anything unparseable.
 *
 * CREDENTIAL-BLIND: any `user:pass@` userinfo prefix (an operator may set a credentialed URL such as
 * `user:secret@host:port`) is DROPPED before parsing, so the returned host carries no credential and
 * the reparsed `host:port` is safe to print. The doctor prints ONLY this reparsed form, never the raw
 * env value — so embedded credentials can never leak into output.
 */
function splitEndpoint(endpoint: string): { host: string; port: number } {
  // Strip optional scheme (e.g. `grpc://`) and any `userinfo@` prefix — userinfo may carry a secret.
  const noScheme = endpoint.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  const at = noScheme.lastIndexOf("@");
  const authority = at >= 0 ? noScheme.slice(at + 1) : noScheme;
  const idx = authority.lastIndexOf(":");
  const host = idx >= 0 ? authority.slice(0, idx) : authority;
  const port = Number.parseInt(idx >= 0 ? authority.slice(idx + 1) : "", 10);
  return { host, port };
}

/**
 * Run the fixed preflight checklist, print one credential-blind line per check, and return a
 * fail-closed exit code. `probes` defaults to the real node-built-in implementations; tests inject
 * fakes to drive each PASS/FAIL/SKIP branch deterministically.
 */
export async function doctorCommand(
  _rest: string[],
  env: Env,
  probes: DoctorProbes = realProbes(),
): Promise<number> {
  const results: CheckResult[] = [];

  /** Emit one credential-blind line and record the result for the fail-closed tally. */
  const report = (status: Status, name: string, hint: string, required: boolean): void => {
    process.stdout.write(`${status}  ${name} — ${hint}\n`);
    results.push({ status, required });
  };

  // 1. Hermes on PATH (REQUIRED).
  const hermesOnPath = probes.commandExists("hermes");
  report(
    hermesOnPath ? "PASS" : "FAIL",
    "Hermes on PATH",
    hermesOnPath ? "found `hermes`" : "install the Hermes desktop CLI",
    true,
  );

  // 2. bin built (REQUIRED) — resolved from the repo root; value-free (a static path, not a secret).
  const binBuilt = probes.fileExists(binPath());
  report(
    binBuilt ? "PASS" : "FAIL",
    "bin built",
    binBuilt ? BIN_REL_PATH : "run `pnpm run build`",
    true,
  );

  // 3. registered (REQUIRED) — READ-ONLY `hermes mcp list` must mention `agentos-exec`.
  //    If hermes is absent the listing is undefined: report FAIL/blocked, never crash.
  const listing = probes.hermesMcpList();
  // `?.` yields boolean | undefined; undefined (hermes absent) is falsy -> FAIL/blocked, never a crash.
  const registered = listing?.includes("agentos-exec") ?? false;
  report(
    registered ? "PASS" : "FAIL",
    "registered",
    registered
      ? "`agentos-exec` present in `hermes mcp list`"
      : "`bash scripts/install-hermes-desktop.sh` or `hermes mcp add agentos-exec …`",
    true,
  );

  // 4. OpenShell reachable (REQUIRED) — TCP connect. CREDENTIAL-BLIND: print ONLY the reparsed
  //    host:port (from splitEndpoint, userinfo dropped), NEVER the raw env value.
  const openshellEndpoint = env.AGENTOS_OPENSHELL_ENDPOINT ?? DEFAULT_OPENSHELL;
  const osTarget = splitEndpoint(openshellEndpoint);
  const openshellOk = await probes.tcpReachable(osTarget.host, osTarget.port);
  report(
    openshellOk ? "PASS" : "FAIL",
    "OpenShell reachable",
    openshellOk ? `connected ${osTarget.host}:${osTarget.port}` : "start the OpenShell gateway",
    true,
  );

  // 5. kernel reachable (REQUIRED) — commit-before-effect needs the partitioned WORM kernel.
  //    CREDENTIAL-BLIND: print ONLY the reparsed host:port (userinfo dropped), never the raw value.
  const kernelEndpoint = env.AGENTOS_KERNEL_INGEST_ENDPOINT ?? DEFAULT_KERNEL;
  const kTarget = splitEndpoint(kernelEndpoint);
  const kernelOk = await probes.tcpReachable(kTarget.host, kTarget.port);
  report(
    kernelOk ? "PASS" : "FAIL",
    "kernel reachable",
    kernelOk
      ? `connected ${kTarget.host}:${kTarget.port}`
      : "start the partitioned WORM kernel (`--partitions tenant-bin`) — commit-before-effect needs it",
    true,
  );

  // 6. SpendGuard sidecar (CONDITIONAL) — only if the operator configured SPENDGUARD_UDS_PATH.
  //    Unset -> SKIP (in-memory budget gate, never fails the run). Set+unreachable -> FAIL.
  const udsPath = env.SPENDGUARD_UDS_PATH;
  if (udsPath === undefined || udsPath.length === 0) {
    report(
      "SKIP",
      "SpendGuard sidecar",
      "SPENDGUARD_UDS_PATH unset -> SpendGuard off -> in-memory budget gate",
      false,
    );
  } else {
    const udsOk = probes.fileExists(udsPath);
    report(
      udsOk ? "PASS" : "FAIL",
      "SpendGuard sidecar",
      udsOk
        ? "SPENDGUARD_UDS_PATH socket present"
        : "SPENDGUARD_UDS_PATH set but socket unreachable — start the SpendGuard sidecar",
      true,
    );
  }

  // Fail-closed tally: non-zero if ANY required check FAILed; 0 only if all required checks PASSed.
  const anyRequiredFail = results.some((r) => r.required && r.status === "FAIL");
  return anyRequiredFail ? EXIT_DOCTOR_FAIL : EXIT_OK;
}
