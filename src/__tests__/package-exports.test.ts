// PKG1 — package public-surface contract. RED-first: fails until package.json declares the `exports`
// allowlist (and the build emits each target). No governance behaviour is exercised; this pins the
// package's distribution contract so the documented `import … from "agent-os/<subpath>"` resolves,
// loads, and exposes its factory — and so the docs cannot drift from the allowlist.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));

// The intentional public surface (INDEX §3 / PKG1 §A). `.` + 7 subpaths.
const PUBLIC_SUBPATHS = [
  ".",
  "./personal",
  "./developer",
  "./enterprise",
  "./tools",
  "./sdk/templates",
  "./runtime/spendguard",
  "./policy/adapters/agt",
] as const;

// Surface subpaths whose documented factory must actually load.
const REQUIRED_NAMED_EXPORTS: Record<string, string> = {
  "./personal": "createPersonalShell",
  "./developer": "createDeveloperKit",
  "./enterprise": "createEnterpriseFleet",
  "./runtime/spendguard": "integrationsFromEnv",
  "./policy/adapters/agt": "AgtSecondaryPolicy",
};

describe("package public-surface contract (PKG1)", () => {
  it("declares an `exports` map with the allowlisted public subpaths", () => {
    expect(typeof pkg.exports, "package.json must declare `exports`").toBe("object");
    for (const p of PUBLIC_SUBPATHS) {
      expect(pkg.exports[p], `missing exports["${p}"]`).toBeDefined();
    }
    expect(pkg.exports["./package.json"]).toBe("./package.json");
  });

  it("the exports allowlist is EXACTLY the public surface (no wildcard, no internal deep path)", () => {
    expect(Object.keys(pkg.exports ?? {}).sort()).toEqual(
      [...PUBLIC_SUBPATHS, "./package.json"].sort(),
    );
  });

  it("maps every entry to a built dist target that exists (types + import)", () => {
    for (const p of PUBLIC_SUBPATHS) {
      const entry = pkg.exports?.[p];
      expect(entry, `exports["${p}"] undefined`).toBeDefined();
      for (const cond of ["types", "import"] as const) {
        const target = entry[cond];
        expect(typeof target, `exports["${p}"].${cond} must be a string`).toBe("string");
        expect(
          existsSync(resolve(ROOT, target)),
          `exports["${p}"].${cond} -> ${target} does not exist (run \`pnpm run build\`)`,
        ).toBe(true);
      }
    }
  });

  it("each entry actually loads and exposes its documented factory (not just exists)", async () => {
    for (const p of PUBLIC_SUBPATHS) {
      const target = pkg.exports?.[p]?.import as string;
      const mod = await import(resolve(ROOT, target));
      expect(mod, `${p} import is empty`).toBeTruthy();
      const named = REQUIRED_NAMED_EXPORTS[p];
      if (named) {
        expect(typeof mod[named], `exports["${p}"] must expose ${named}`).toBe("function");
      }
    }
  });

  it("every `agent-os/<subpath>` import in the user docs is in the exports allowlist", () => {
    const keys = new Set(Object.keys(pkg.exports ?? {}));
    const specifiers = new Set<string>();
    const collect = (file: string) => {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/["'`]agent-os(\/[A-Za-z0-9._/-]+)?["'`]/g)) {
        specifiers.add(m[1] ? `.${m[1]}` : ".");
      }
    };
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        // skip the design specs (they discuss "wrong" examples on purpose).
        if (full.includes(`${join("docs", "slices")}`)) continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".md")) collect(full);
      }
    };
    collect(resolve(ROOT, "README.md"));
    if (existsSync(resolve(ROOT, "CONTRIBUTING.md"))) collect(resolve(ROOT, "CONTRIBUTING.md"));
    walk(resolve(ROOT, "docs"));
    for (const s of specifiers) {
      expect(
        keys.has(s),
        `docs import "agent-os${s === "." ? "" : s.slice(1)}" is not in package.exports`,
      ).toBe(true);
    }
  });

  it("ships a publishable manifest (license, files, prepack)", () => {
    expect(pkg.license).toBe("MIT");
    expect(Array.isArray(pkg.files) && pkg.files.includes("dist")).toBe(true);
    expect(pkg.files).toEqual(expect.arrayContaining(["dist", "README.md", "LICENSE"]));
    expect(String(pkg.scripts?.prepack ?? "")).toContain("build");
  });
});
