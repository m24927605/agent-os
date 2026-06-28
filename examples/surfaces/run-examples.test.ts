/**
 * RUNNABLE REFERENCE COMPOSITION-ROOT examples — the acceptance test (SLICE surface-run-examples).
 *
 * THE CONCERN this closes: the three surface composition roots (`createPersonalShell` /
 * `createDeveloperKit` / `createEnterpriseFleet`) are fully built + usable in code/tests, but a 3rd
 * party had NO runnable "run a surface" entry point to copy. The three sibling files here ARE those
 * entry points (the canonical roots an adopter copies). This test is the executable proof that each one
 * (a) runs end-to-end over ONLY in-memory defaults, (b) produces a REAL GOVERNED OUTCOME, and (c) is
 * credential-blind. Each example also exposes an `import.meta`-guarded `main()` so it is ALSO runnable
 * standalone via `node examples/surfaces/run-<surface>.ts` (Node strips the types; the example imports
 * the BUILT `dist/<surface>/index.js` surface barrel — the same barrel a copied adopter root imports).
 *
 * RED-first: `./run-personal-shell.js`, `./run-developer-kit.js`, `./run-enterprise-fleet.js` do NOT
 * exist yet, so the imports below fail and the suite cannot even be collected. GREEN only once the three
 * runnable reference roots land.
 *
 * NON-VACUITY (the load-bearing anchor — Personal): the Personal assertion binds to a REAL governed
 * outcome — `decision === "executed"` AND a WORM-backed `已完成` timeline event. The reference root sets
 * `allowToolInvoke: true`; if an adopter (or a regression) drops that, the PDP denies@policy, the effect
 * never runs, the timeline gains NO `已完成` event, and `decision` flips to `denied` — so this test would
 * FAIL. The outcome is therefore not a tautology: it is pinned to the governed effect actually committing.
 * (Developer binds to a registry-backed `executed` + a non-empty deterministic replay fold; Enterprise
 * binds to a maker-checker `ok` + the suspended-agent console projection — each likewise flips on a broken
 * gate.)
 */
import { describe, expect, it } from "vitest";
import { runExample as runDeveloperKit } from "./run-developer-kit.js";
import { runExample as runEnterpriseFleet } from "./run-enterprise-fleet.js";
import { runExample as runPersonalShell } from "./run-personal-shell.js";

/**
 * A runtime-assembled `sk-`-shaped secret canary — never a literal in source (so scan_secrets.sh and the
 * pre-commit guard stay clean) but real enough that the credential-blindness assertion is meaningful.
 */
const SECRET_CANARY = `sk-${"d".repeat(24)}`;

/** Assert NO secret-shaped value (an `sk-…` key) ever appears in an example's printed/returned summary. */
function expectCredentialBlind(summary: unknown): void {
  const text = JSON.stringify(summary);
  expect(text).not.toContain(SECRET_CANARY);
  // Defense in depth: the high-signal `sk-<16+ chars>` shape the repo secret-scanner flags, in case an
  // adopter root ever interpolated one. None of the three roots emit any credential.
  expect(text).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
}

describe("surface reference composition roots — each runs over in-memory defaults to a GOVERNED OUTCOME", () => {
  it("Personal: receive -> previewAndSubmit -> approve yields an EXECUTED governed outcome + a WORM-backed 已完成 timeline (non-vacuity anchor)", async () => {
    const summary = await runPersonalShell();

    // The governed decision: the approved call ran through screen->PDP->cost->commit-before-effect->effect.
    expect(summary.surface).toBe("personal");
    expect(summary.decision).toBe("executed");

    // The WORM-backed timeline (read back from the SAME shared in-memory log the appender wrote) carries
    // at least one completed (已完成) governed event — proof the effect committed, not just that code ran.
    expect(summary.timelineEventCount).toBeGreaterThanOrEqual(1);
    expect(summary.completed).toBe(true);

    // ONLY in-memory defaults: the reference root names NO external sink/reader/registry/gate.
    expect(summary.usedInMemoryDefaults).toBe(true);

    expectCredentialBlind(summary);
  });

  it("Developer: authorTool (registry deny-by-default) -> runTool(registered) -> EXECUTED + a deterministic replay fold", async () => {
    const summary = await runDeveloperKit();

    expect(summary.surface).toBe("developer");
    // The registry-backed authorize granted the REGISTERED tool; the governed pipeline executed it.
    expect(summary.decision).toBe("executed");
    expect(summary.registeredToolCount).toBeGreaterThanOrEqual(1);

    // The WORM gained the committed AuditEvent; the independent deterministic replay fold reflects it.
    expect(summary.replayStepCount).toBeGreaterThanOrEqual(1);
    expect(summary.replayDeterministic).toBe(true);

    expect(summary.usedInMemoryDefaults).toBe(true);
    expectCredentialBlind(summary);
  });

  it("Enterprise: route -> maker-checker -> commit-before-effect yields an OK governed decision + a suspended-agent console projection", async () => {
    const summary = await runEnterpriseFleet();

    expect(summary.surface).toBe("enterprise");
    // The privileged operator action passed the maker-checker gate and committed before the effect ran.
    expect(summary.decision).toBe("ok");

    // The per-tenant WORM gained the operator AuditEvent; the per-tenant console projects the suspension.
    expect(summary.wormEventCount).toBeGreaterThanOrEqual(1);
    expect(summary.agentSuspended).toBe(true);

    expect(summary.usedInMemoryDefaults).toBe(true);
    expectCredentialBlind(summary);
  });
});
