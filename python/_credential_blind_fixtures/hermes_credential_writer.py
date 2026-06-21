"""Forbidden target: writes a credential to a `~/.hermes`-style client-held credential file.

This is exactly the client-held-credential pattern Agent OS structurally rejects (Hermes lands
profile/skill/credentials under `~/.hermes`). The shim must never import a module that can
persist a credential to disk.
"""

from pathlib import Path


def write_credential_file(relative_path: str, contents: str) -> Path:
    """Persist `contents` under the user home (a credential-landing edge)."""
    target = Path.home() / relative_path
    target.write_text(contents)
    return target
