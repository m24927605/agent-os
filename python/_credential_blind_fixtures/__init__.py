"""Secret-bearing module set — the forbidden import targets for the credential-blind contract.

These modules represent the CAPABILITY of touching a credential (reading it from the
environment, writing a `~/.hermes`-style credential file, or dialing a model provider).
`agentos_shim` is forbidden by the import-linter contract from importing any of them, which
is what makes the shim credential-blind at import time.

They hold NO literal secrets themselves (secret-scan stays clean); they only model the edges
the shim must never have. The RED-proof fixture (tests/redfix) imports one of these to prove
the contract actually fails closed; production `agentos_shim` never imports them.
"""
