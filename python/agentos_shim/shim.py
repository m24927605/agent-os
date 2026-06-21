"""Minimal credential-blind shim: express agent proposals as bundleRef-only structures.

Pure structure, no I/O, no environment reads, no provider clients. The functions here ACCEPT
only bundleRef strings for argument values and reject anything that looks like a literal secret,
so the structures they emit can never carry a plaintext credential. This is the lint/import-time
complement to the runtime ``screenBrainEvent`` guard
(``src/runtime/brain/credential-guard.ts``): that one blocks the runtime payload, this one keeps
the proposal credential-blind by construction.
"""

from __future__ import annotations

# A credential-blind argument value MUST be a reference into the bundle, never a literal secret.
BUNDLE_REF_PREFIX = "bundle://"


def _looks_like_bundle_ref(value: str) -> bool:
    """A value is an allowed credential reference iff it is a ``bundle://`` ref."""
    return value.startswith(BUNDLE_REF_PREFIX) and len(value) > len(BUNDLE_REF_PREFIX)


def _assert_bundle_ref_only(args: dict[str, str]) -> dict[str, str]:
    """Validate that every arg value is a bundleRef; reject literal-secret-shaped values.

    Fail-closed: a value that is not a syntactic bundleRef is treated as a potential literal
    secret and rejected with ``ValueError`` — it is never echoed into the emitted structure. An
    empty args dict is allowed (no credential-bearing args at all).
    """
    if not isinstance(args, dict):  # pyright: ignore[reportUnnecessaryIsInstance] — runtime guard
        raise ValueError("args must be a dict of str -> bundleRef str")
    out: dict[str, str] = {}
    for key, value in args.items():
        if not isinstance(key, str):  # pyright: ignore[reportUnnecessaryIsInstance]
            raise ValueError("arg keys must be strings")
        if not isinstance(value, str):  # pyright: ignore[reportUnnecessaryIsInstance]
            raise ValueError(f"arg {key!r} must be a bundleRef string, not {type(value).__name__}")
        if not _looks_like_bundle_ref(value):
            # Reject without including the offending value in the message (deny-by-default; the
            # rejected value is never written anywhere downstream).
            raise ValueError(
                f"arg {key!r} is not a bundleRef ({BUNDLE_REF_PREFIX}...); "
                "credential-blind shim refuses literal values"
            )
        out[key] = value
    return out


def to_bundle_ref_tool_call(tool: str, bundle_refs: dict[str, str]) -> dict[str, object]:
    """Build a bundleRef-only tool call.

    ``bundle_refs`` maps each argument name to a ``bundle://`` reference. Any non-reference value
    is rejected (fail-closed) so the result can never contain a literal secret.
    """
    if not tool:
        raise ValueError("tool name is required")
    return {"tool": tool, "args": _assert_bundle_ref_only(bundle_refs)}


def to_bundle_ref_plan_step(
    tool: str, bundle_refs: dict[str, str], *, rationale: str = ""
) -> dict[str, object]:
    """Build a bundleRef-only plan step (a tool call plus an optional plain-text rationale)."""
    step = to_bundle_ref_tool_call(tool, bundle_refs)
    step["rationale"] = rationale
    return step
