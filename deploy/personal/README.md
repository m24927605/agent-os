# Agent OS — Personal surface launcher

One command starts and stops the whole **Personal zero-skill shell** (R7) on a single
machine: the intent → plan-preview → approval-inbox → task-timeline shell, plus the existing
audit kernel and execution substrate.

## Start / stop

Set your host UID/GID so files the containers create stay owned by you on the host:

```sh
PERSONAL_UID=$(id -u) PERSONAL_GID=$(id -g) \
  docker compose -f deploy/personal/docker-compose.yml up -d

# stop
docker compose -f deploy/personal/docker-compose.yml down
```

## Configure (one declarative file → native configs)

The brain/substrate switches (OpenShell + kernel endpoints, the `net.fetch` egress allowlist,
SpendGuard budget, AGT advisory) come from a single **non-secret** `agent-os.config.json`. Scaffold,
compile, and drift-check it with the `agentos` CLI — you never hand-edit each system's native format:

```sh
agentos setup --init --profile personal   # scaffold a starter agent-os.config.json (no blank page)
agentos setup --explain                    # value-free map: which config field → which native output
agentos config render                      # compile → .agentos/rendered/* + .agentos/render.lock.json
agentos config check                       # re-render + fail-closed (non-zero) on drift — run in CI
agentos doctor --secrets                   # preflight + value-blind SET/UNSET inventory of secret env KEYs
```

`config render` writes, e.g., `openshell-egress.json` from `openshell.networkPolicy.egressAllow`
(the same hosts the egress auto-provisioner applies live) and a `nemoclaw-onboard.txt` stanza. Every
rendered artifact is **non-secret** (a secret-shaped value fails closed, value-free); secrets stay in
the host environment / `.env` (below) and are resolved only at the egress boundary. `.agentos/rendered/`
is git-ignored; commit `.agentos/render.lock.json` to gate drift in CI. Full reference:
[`docs/configuration.md`](../../docs/configuration.md).

## Security contract (enforced by `pnpm run launcher:check`)

`pnpm run launcher:check` (a sub-gate of `pnpm run verify`) statically lints the compose file
and exits non-zero if either invariant is broken:

1. **Network deny-by-default.** Every published port is pinned to `127.0.0.1`. The Personal
   surface is single-machine — it is never exposed on the LAN. Do **not** use `0.0.0.0` or a
   bare `"8080:8080"` map (that binds all interfaces). For remote access, tunnel instead:

   ```sh
   ssh -L 8080:localhost:8080 <your-host>
   ```

   LAN exposure, reverse proxies, and TLS termination belong to the Enterprise surface (R8).

2. **Credentials never on disk.** The compose file contains **zero** plaintext secrets. Every
   secret is injected at runtime — either via `${ENV}` interpolation or a read-only volume
   mount from the host. Provide secrets one of two ways:

   - **Host environment:** export them in the shell that runs `docker compose`
     (e.g. `export SHELL_SESSION_KEY=...`), or
   - **Local `.env`:** create a git-ignored `.env` next to the compose file. **Never commit
     it.** Mounted credentials live under `~/.agent-os/secrets` and are surfaced read-only at
     `/run/secrets` inside the container.

   Secrets must never be written into this file, the image, or the logs.

## Why a launcher and not a new engine

The governance authority (PDP deny, commit-before-effect, WORM evidence root) already lives in
`src/{policy,commitgate,audit,orchestration}` and is proven by `pnpm run verify`. This launcher
only **starts and stops** that existing surface in a deny-by-default network posture — it adds
no new runtime behavior and imports no `src` module.
