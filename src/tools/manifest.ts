/**
 * ToolManifest — an agent-agnostic, vendor-neutral declarative contract for one tool's
 * side-effect semantics. `.strict()` means any unknown field => parse failure (fail-closed):
 * unknown fields are an attack surface, not silently accepted.
 *
 * This module owns ONLY the contract (schema + parse + consistency guardrails). No state,
 * no I/O, no policy decisions. It imports nothing but `zod`.
 */
import { z } from "zod";

export type ToolSideEffect = "none" | "read" | "write" | "destructive";

/**
 * Where a capability's effect is contained — the single-source-of-truth for whether it PUNCHES the
 * sandbox seal (and thus which fail-closed governance primitive it needs). `in-sandbox` = the effect
 * lives entirely inside the ephemeral zero-credential no-egress sandbox (rides pipeline + seal, needs
 * NO primitive). `network-egress`/`host-fs-write` = it punches the seal and names its primitive. This
 * field is REQUIRED (no default): a manifest that omits it FAILS parse — fail-closed, because an
 * unclassified capability is an unknown blast radius, not a safe default. The capability CLASSIFIER
 * (`capability-containment.ts`) reads this field; the REFUSE-to-register gate enforces it.
 */
export type ToolContainment = "in-sandbox" | "network-egress" | "host-fs-write";

const nonEmpty = z.string().trim().min(1);

export const ToolManifest = z
  .object({
    name: nonEmpty,
    version: nonEmpty,
    description: nonEmpty,
    action: nonEmpty,
    resourcePattern: nonEmpty,
    sideEffect: z.enum(["none", "read", "write", "destructive"]),
    idempotent: z.boolean(),
    requiresApproval: z.boolean(),
    bundleRefOnly: z.boolean(),
    containment: z.enum(["in-sandbox", "network-egress", "host-fs-write"]),
  })
  .strict()
  .superRefine((m, ctx) => {
    // Guardrail A: no side effect must be safely replayable.
    if (m.sideEffect === "none" && !m.idempotent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["idempotent"],
        message: 'sideEffect "none" implies idempotent: true',
      });
    }
    // Guardrail B: destructive actions must go through approval.
    if (m.sideEffect === "destructive" && !m.requiresApproval) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiresApproval"],
        message: 'sideEffect "destructive" implies requiresApproval: true',
      });
    }
  });

export type ToolManifest = z.infer<typeof ToolManifest>;

/** Parse an untrusted input into a ToolManifest. Fail-closed: throws on any violation. */
export function parseToolManifest(input: unknown): ToolManifest {
  return ToolManifest.parse(input);
}
