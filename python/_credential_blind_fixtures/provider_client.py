"""Forbidden target: dials a model provider directly with a client-held key.

A module that constructs a provider client with an inline key holds a credential. The shim must
never import it — provider calls go through the governed PDP -> lease -> commit-before-effect ->
sandbox path, with the key injected at egress, never held by the brain/shim.
"""


def call_provider(endpoint: str, api_key: str, prompt: str) -> str:
    """Pretend to dial a provider holding `api_key` (a credential-holding edge)."""
    # No real network call; this only models the forbidden capability shape.
    return f"would POST to {endpoint} (len(prompt)={len(prompt)}, key_held={bool(api_key)})"
