/**
 * SLICE-SETUP3 #1 — the JSON Schema stays in sync with the zod `.strict()` schema (the editor-UX drift guard).
 * If a future zod section is added without updating the hand-authored JSON Schema, the top-level guard fails.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_OS_CONFIG_JSON_SCHEMA,
  CONFIG_SCHEMA_FILENAME,
  configJsonSchemaText,
} from "./config-json-schema.js";
import { AgentOsConfigSchema, loadAgentOsConfig } from "./setup.js";

describe("agent-os.config JSON Schema — in sync with the zod schema (editor autocomplete + hover docs)", () => {
  it("DRIFT GUARD: top-level properties == the zod schema's keys (a new zod section must be added here too)", () => {
    const schemaKeys = Object.keys(AGENT_OS_CONFIG_JSON_SCHEMA.properties).sort();
    const zodKeys = Object.keys(AgentOsConfigSchema.shape).sort();
    expect(schemaKeys).toEqual(zodKeys);
  });

  it("mirrors .strict() (additionalProperties:false) + the required sections + is valid JSON", () => {
    expect(AGENT_OS_CONFIG_JSON_SCHEMA.additionalProperties).toBe(false);
    expect([...AGENT_OS_CONFIG_JSON_SCHEMA.required].sort()).toEqual(["kernel", "openshell"]);
    expect(() => JSON.parse(configJsonSchemaText())).not.toThrow();
    expect(CONFIG_SCHEMA_FILENAME).toBe("agent-os.config.schema.json");
  });

  it("declares the nested egress allowlist (editors validate hosts) + the secrets key-name pattern", () => {
    const os = AGENT_OS_CONFIG_JSON_SCHEMA.properties.openshell;
    expect(Object.keys(os.properties)).toContain("networkPolicy");
    expect(os.properties.networkPolicy.properties.egressAllow.type).toBe("array");
    expect(AGENT_OS_CONFIG_JSON_SCHEMA.properties.secrets.additionalProperties.pattern).toBe(
      "^[A-Z][A-Z0-9_]*$",
    );
  });

  it("a config carrying `$schema` parses (the .strict() passthrough) — editors can reference the schema", () => {
    const raw = JSON.stringify({
      $schema: "./agent-os.config.schema.json",
      openshell: { endpoint: "127.0.0.1:17670", mtlsDir: "/m", image: "img@sha256:a" },
      kernel: { ingestEndpoint: "127.0.0.1:50051" },
    });
    expect(() => loadAgentOsConfig(raw)).not.toThrow();
    expect(loadAgentOsConfig(raw).$schema).toBe("./agent-os.config.schema.json");
  });
});
