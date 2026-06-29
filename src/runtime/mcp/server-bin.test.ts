// ADO-B3 — the governed MCP server must be reachable at a vendor-neutral (no "hermes") entry, so the
// "any MCP host" adoption story doesn't point at a vendor-named path. RED-first: fails until the bin +
// the package.json `bin` mapping exist.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));

describe("vendor-neutral MCP bin (ADO-B3)", () => {
  it("package.json `bin` exposes `agent-os-mcp` at a vendor-neutral dist path (no 'hermes')", () => {
    const p = pkg.bin?.["agent-os-mcp"];
    expect(typeof p, "package.json bin must declare agent-os-mcp").toBe("string");
    expect(p).not.toMatch(/hermes/);
    expect(p).toBe("./dist/runtime/mcp/server-bin.js");
  });

  it("the built neutral bin exists and starts with a node shebang", () => {
    const target = resolve(ROOT, pkg.bin?.["agent-os-mcp"] ?? "dist/runtime/mcp/server-bin.js");
    expect(existsSync(target), `${target} missing (run \`pnpm run build\`)`).toBe(true);
    expect(readFileSync(target, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
  });

  it("delegates to the real exec MCP server (imports the bin + calls main — not a no-op)", () => {
    const built = readFileSync(resolve(ROOT, "dist/runtime/mcp/server-bin.js"), "utf8");
    // a no-op stub would pass the existence+shebang checks; assert it actually wires the server.
    expect(built, "neutral entry must import the exec MCP server bin").toMatch(
      /exec-mcp-server-bin/,
    );
    expect(built, "neutral entry must call main()").toMatch(/\bmain\(/);
  });
});
