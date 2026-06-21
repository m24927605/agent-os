"""Forbidden target: reads a credential directly from the process environment.

A real secret-bearing helper would pull an API key out of `os.environ`. The shim must never
import a module shaped like this — credentials enter only at the OpenShell SecretResolver
egress, referenced by bundleRef, never read by the brain/shim.
"""

import os


def read_credential_from_env(var_name: str) -> str | None:
    """Return whatever the environment holds for `var_name` (a credential-bearing edge)."""
    return os.environ.get(var_name)
