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
