/**
 * SLICE-SETUP3 Step #1 (editor UX) — the JSON Schema for `agent-os.config.json`. Hand-authored (zod 3 has no
 * JSON-Schema export and the CLI is zero-third-party-dep) and kept in sync with the zod `.strict()` schema by a
 * drift-guard test. `agentos setup --init` writes this file next to the config and stamps a `"$schema"` ref, so
 * editors (VS Code et al.) give **autocomplete + inline validation + hover docs** on the otherwise-bare JSON —
 * turning the file itself into the teaching surface (the previous guidance was stdout-only).
 *
 * Mirrors the zod schema EXACTLY: `additionalProperties:false` at every level (== `.strict()`), the same
 * required fields, the same enums/patterns. NON-SECRET only — every `description` names env-key NAMES, never a
 * value. The `descriptions` ARE the hover-docs, so they carry the field's meaning + its compiled env target.
 */

/** The relative filename `setup --init` writes + references via `"$schema"` (resolved next to the config). */
export const CONFIG_SCHEMA_FILENAME = "agent-os.config.schema.json";

/** A plain DNS host (mirrors setup.ts `PLAIN_DNS_HOST` / the egress-provisioner) — no scheme/port/path/IP. */
const PLAIN_DNS_PATTERN = "^(?:localhost|(?:[A-Za-z0-9-]+\\.)*[A-Za-z0-9-]*[A-Za-z][A-Za-z0-9-]*)$";

const hostList = {
  type: "array",
  items: { type: "string", pattern: PLAIN_DNS_PATTERN },
} as const;

/** The JSON Schema (draft-07) for `agent-os.config.json`. Drift-guarded against the zod schema (config tests). */
export const AGENT_OS_CONFIG_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://agent-os.dev/agent-os.config.schema.json",
  title: "agent-os.config.json",
  description:
    "Agent OS declarative, NON-SECRET onboarding config. `agentos setup` compiles it to each system's native config; secrets live in env (resolved only at egress), never here.",
  type: "object",
  additionalProperties: false,
  required: ["openshell", "kernel"],
  properties: {
    $schema: {
      type: "string",
      description:
        "Editor schema reference (ignored at runtime). Written by `agentos setup --init`.",
    },
    openshell: {
      type: "object",
      additionalProperties: false,
      required: ["endpoint", "mtlsDir", "image"],
      description: "The OpenShell substrate the governed tools execute in.",
      properties: {
        endpoint: {
          type: "string",
          description:
            "host:port of the OpenShell gateway → AGENTOS_OPENSHELL_ENDPOINT (doctor TCP-probes it).",
        },
        mtlsDir: {
          type: "string",
          description: "Gateway mTLS directory → AGENTOS_OPENSHELL_MTLS.",
        },
        image: { type: "string", description: "Pinned sandbox image → AGENTOS_OPENSHELL_IMAGE." },
        networkPolicy: {
          type: "object",
          additionalProperties: false,
          description:
            "Egress allowlist (deny-by-default). Compiled to the env the Option B egress auto-provisioner reads at sandbox creation.",
          properties: {
            egressAllow: {
              ...hostList,
              description:
                "Plain-DNS hosts net.fetch may reach → AGENTOS_EGRESS_ALLOW (no scheme/port/path/IP).",
            },
            gitEgressAllow: {
              ...hostList,
              description:
                "Plain-DNS hosts git.push may reach → AGENTOS_GIT_EGRESS_ALLOW (separate, higher-bar).",
            },
          },
        },
      },
    },
    kernel: {
      type: "object",
      additionalProperties: false,
      required: ["ingestEndpoint"],
      description: "The attester≠actor WORM kernel (commit-before-effect needs it).",
      properties: {
        ingestEndpoint: {
          type: "string",
          description:
            "host:port of the WORM kernel ingest → AGENTOS_KERNEL_INGEST_ENDPOINT (doctor TCP-probes).",
        },
      },
    },
    spendguard: {
      type: "object",
      additionalProperties: false,
      required: ["udsPath", "budgetId", "unitId", "windowInstanceId"],
      description:
        "SpendGuard budget governance (optional; ALL-OR-NOTHING — all four fields required if present).",
      properties: {
        udsPath: {
          type: "string",
          description: "SpendGuard sidecar UDS path → SPENDGUARD_UDS_PATH.",
        },
        budgetId: { type: "string", description: "→ SPENDGUARD_BUDGET_ID." },
        unitId: { type: "string", description: "→ SPENDGUARD_UNIT_ID." },
        windowInstanceId: { type: "string", description: "→ SPENDGUARD_WINDOW_INSTANCE_ID." },
      },
    },
    agt: {
      type: "object",
      additionalProperties: false,
      required: ["udsPath"],
      description: "AGT policy advisory (optional; udsPath required if present).",
      properties: {
        udsPath: { type: "string", description: "AGT advisory sidecar UDS path → AGT_UDS_PATH." },
        scope: {
          type: "string",
          enum: ["effectful", "all"],
          description: "Which tool calls consult AGT → AGT_SCOPE (default effectful).",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          description: "Advisory timeout in ms → AGT_TIMEOUT_MS.",
        },
      },
    },
    secrets: {
      type: "object",
      description:
        'Registry of env-key NAMES only (e.g. { "gmail": "AGENTOS_GMAIL_OAUTH_KEY" }). The VALUES are exported in your shell and resolved only at egress — a pasted secret value is rejected.',
      additionalProperties: {
        type: "string",
        pattern: "^[A-Z][A-Z0-9_]*$",
        description: "An UPPER_SNAKE env-key NAME — never a secret value.",
      },
    },
    nemoclaw: {
      type: "object",
      additionalProperties: false,
      required: ["gateway"],
      description:
        "NemoClaw hosting (optional). `config render` emits an onboard stanza (no auto-provisioner).",
      properties: {
        gateway: {
          type: "string",
          description: "Gateway NAME to host the in-sandbox Hermes brain.",
        },
        image: { type: "string", description: "Optional sandbox image override." },
      },
    },
  },
} as const;

/** The schema file contents (pretty-printed + trailing newline) that `setup --init` / `config schema` writes. */
export function configJsonSchemaText(): string {
  return `${JSON.stringify(AGENT_OS_CONFIG_JSON_SCHEMA, null, 2)}\n`;
}
