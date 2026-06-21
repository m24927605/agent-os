"""Agent OS credential-blind shim — Developer surface, Python plane (P2R-R9-S1).

Authors wrap their agent logic here. Every proposal the shim emits is **bundleRef-only**: a tool
call or plan step carries references to credentials (``bundle://...``), never a literal secret.
The shim does no I/O, reads no environment credentials, and dials no provider — and the
import-linter forbidden contract makes that a structural invariant: this package may not import
any secret-bearing module. The real secret only ever materializes downstream at the OpenShell
SecretResolver egress.
"""

from .shim import (
    BUNDLE_REF_PREFIX,
    to_bundle_ref_plan_step,
    to_bundle_ref_tool_call,
)

__all__ = [
    "BUNDLE_REF_PREFIX",
    "to_bundle_ref_plan_step",
    "to_bundle_ref_tool_call",
]
