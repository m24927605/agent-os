"""Cross-language boundary test (SLICE-DV4) — the Python side of the JSON-fixture contract.

HONEST SCOPE: this proves the credential-blind shim genuinely PRODUCES the committed
`tests/fixtures/bundle_ref_proposal.json` contract (byte-equivalent under
`json.dumps(sort_keys=True)`) and that it stays credential-blind (a literal-secret arg ->
ValueError, fail-closed). It is a
FIXTURE / JSON-boundary proof, NOT a live Python-runtime integration with the TS governance core
(that is R11). Python never runs the governance core; it only emits the bundleRef-only proposal that
the TS `python-boundary.e2e.test.ts` consumes from the SAME committed fixture.

The "secret canary" is ASSEMBLED AT RUNTIME (never a literal on disk in this file / the fixture /
any snapshot), per the credential-never-on-disk rule.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentos_shim import to_bundle_ref_tool_call

# The committed cross-language contract. The SAME file the TS boundary test reads.
FIXTURE_PATH = Path(__file__).parent / "fixtures" / "bundle_ref_proposal.json"


def _canonical(obj: object) -> str:
    """The canonical byte form of a proposal: sorted keys, default compact separators."""
    return json.dumps(obj, sort_keys=True)


def _runtime_secret() -> str:
    """Assemble a secret-shaped value at runtime — never a literal on disk."""
    return "sk-" + "".join(chr(c) for c in (108, 105, 118, 101)) + "-" + str(0xDEADBEEF)


def test_shim_output_is_byte_equivalent_to_committed_fixture() -> None:
    """The shim genuinely produces the committed fixture (byte-equivalent canonical form).

    NON-VACUITY: if the fixture drifts from what the shim emits (a stale or hand-edited contract),
    the two canonical strings diverge and this assertion flips RED — so the committed JSON is a
    live contract, not decoration.
    """
    # Build the proposal via the credential-blind shim (the SAME helper the TS side trusts).
    proposal = to_bundle_ref_tool_call("dev:deploy", {"config": "bundle://prod/app-config"})

    # Load the committed fixture and canonicalize BOTH sides identically.
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    assert _canonical(proposal) == _canonical(fixture)

    # And the shape the TS boundary guard relies on: tool + bundleRef-only args.
    assert proposal["tool"] == "dev:deploy"
    assert proposal["args"] == {"config": "bundle://prod/app-config"}


def test_literal_secret_arg_is_rejected_fail_closed() -> None:
    """A runtime-assembled literal secret in an arg -> ValueError; never echoed into output.

    NON-VACUITY: if `_assert_bundle_ref_only` stopped rejecting non-bundleRef values, the shim would
    emit a proposal carrying the plaintext secret and this `pytest.raises` would flip RED.
    """
    secret = _runtime_secret()
    with pytest.raises(ValueError):
        to_bundle_ref_tool_call("dev:deploy", {"config": secret})


def test_empty_args_proposal_is_allowed() -> None:
    """A proposal with no credential-bearing args is allowed (no bundleRef to validate)."""
    proposal = to_bundle_ref_tool_call("dev:deploy", {})
    assert proposal == {"tool": "dev:deploy", "args": {}}
