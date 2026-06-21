"""Credential-blind shim tests (P2R-R9-S1).

These prove the runtime behaviour of the shim: it emits bundleRef-only structures and NEVER
emits a literal secret. The import-time structural invariant (shim never imports a secret-bearing
module) is enforced separately by the import-linter forbidden contract run as `lint-imports` in
the verify:py gate.

The "secret canary" is ASSEMBLED AT RUNTIME (never written as a literal in this file / any
fixture / snapshot), per the credential-never-on-disk rule.
"""

from __future__ import annotations

from typing import Any

import pytest

from agentos_shim import to_bundle_ref_plan_step, to_bundle_ref_tool_call


def _runtime_canary() -> str:
    """Assemble a secret-shaped canary at runtime — never a literal on disk."""
    return "sk-" + "".join(chr(c) for c in (108, 105, 118, 101)) + "-" + str(0xDEADBEEF)


def _contains_value(node: Any, needle: str) -> bool:
    """Recursively scan a JSON-ish structure for `needle` in any key or string value."""
    if isinstance(node, str):
        return needle in node
    if isinstance(node, dict):
        return any(
            _contains_value(k, needle) or _contains_value(v, needle) for k, v in node.items()
        )
    if isinstance(node, (list, tuple)):
        return any(_contains_value(item, needle) for item in node)
    return False


def test_tool_call_is_bundle_ref_only() -> None:
    call = to_bundle_ref_tool_call("send_email", {"api_key": "bundle://creds/smtp"})
    assert call["tool"] == "send_email"
    assert call["args"] == {"api_key": "bundle://creds/smtp"}
    # No literal secret was assembled, so the runtime canary must be absent.
    assert not _contains_value(call, _runtime_canary())


def test_plan_step_is_bundle_ref_only() -> None:
    step = to_bundle_ref_plan_step(
        "charge_card", {"token": "bundle://creds/stripe"}, rationale="user opted in"
    )
    assert step["tool"] == "charge_card"
    assert step["args"] == {"token": "bundle://creds/stripe"}
    assert step["rationale"] == "user opted in"
    assert not _contains_value(step, _runtime_canary())


def test_adversarial_literal_secret_is_rejected() -> None:
    """Passing a secret-shaped (non-bundleRef) value must be rejected, never echoed into output."""
    canary = _runtime_canary()
    with pytest.raises(ValueError):
        to_bundle_ref_tool_call("exfil", {"api_key": canary})


def test_adversarial_secret_keyed_but_non_ref_is_rejected() -> None:
    """A bundleRef-shaped key that does not actually carry a bundleRef value is rejected."""
    with pytest.raises(ValueError):
        to_bundle_ref_tool_call("exfil", {"password": "hunter2-not-a-ref"})


def test_output_is_plain_jsonable_no_secret_object() -> None:
    call = to_bundle_ref_tool_call("noop", {})
    # Pure structure: only str/dict, no I/O handles, no env-derived values.
    assert isinstance(call, dict)
    assert isinstance(call["args"], dict)
