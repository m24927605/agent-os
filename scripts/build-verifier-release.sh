#!/usr/bin/env bash
# SLICE-P2R-R9-S5: build the standalone evidence-chain verifier as a VERSIONED, REPRODUCIBLE,
# CROSS-PLATFORM + WASM release artifact.
#
# WHY: kernel/cmd/verifier is the small binary an auditor trusts INSTEAD of our platform
# (kernel/cmd/verifier/main.go:1-5). Source-only is not enough for an external auditor — they want a
# versioned, reproducible artifact runnable in ANY environment (incl. the browser, via WASM). This
# script produces exactly that. It does NOT change the verifier's trust semantics: the Ed25519
# public key is still supplied by the auditor at verify time; pubkey pinning / external root = P4.
#
# REPRODUCIBLE by construction: -trimpath (strip absolute build paths), CGO_ENABLED=0 (no host C
# toolchain), GOFLAGS=-mod=readonly, GOTOOLCHAIN=local (pin to installed Go), and a DETERMINISTIC
# version label (git commit, not a wallclock timestamp). Two runs of the same commit produce
# byte-identical binaries -> identical SHA-256SUMS.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLANE="$ROOT/kernel"
OUTDIR="$ROOT/dist/verifier"
PKG="./cmd/verifier"

command -v go >/dev/null 2>&1 || { echo "FAIL: 'go' toolchain not installed" >&2; exit 1; }
[ -d "$PLANE" ] || { echo "FAIL: kernel plane absent ($PLANE)" >&2; exit 1; }

# Deterministic version label: explicit override > git describe > short commit > "dev".
VERSION="${VERIFIER_VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || true)"
fi
[ -z "$VERSION" ] && VERSION="dev"

# Reproducible-build environment (do NOT inherit a stray GOROOT; pin the toolchain).
export CGO_ENABLED=0
export GOFLAGS="-mod=readonly"
export GOTOOLCHAIN=local
unset GOROOT 2>/dev/null || true

LDFLAGS="-s -w -buildid= -X main.buildVersion=${VERSION}"

# Clean output so artefact listing is exactly the matrix (reproducible directory contents).
rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"

# Cross-platform native binaries.
build_native() {
  local goos="$1" goarch="$2" ext="$3"
  local out="$OUTDIR/verifier-${goos}-${goarch}${ext}"
  echo "build: ${goos}/${goarch} -> $(basename "$out")"
  ( cd "$PLANE" && GOOS="$goos" GOARCH="$goarch" go build -trimpath -ldflags "$LDFLAGS" -o "$out" "$PKG" ) \
    || { echo "FAIL: go build ${goos}/${goarch}" >&2; exit 1; }
}

build_native linux   amd64 ""
build_native linux   arm64 ""
build_native darwin  amd64 ""
build_native darwin  arm64 ""
build_native windows amd64 ".exe"

# Browser/offline WASM build (reuses the same verifyChainBytes core via wasm_main.go).
echo "build: js/wasm -> verifier.wasm"
( cd "$PLANE" && GOOS=js GOARCH=wasm go build -trimpath -ldflags "$LDFLAGS" -o "$OUTDIR/verifier.wasm" "$PKG" ) \
  || { echo "FAIL: go build js/wasm" >&2; exit 1; }

# Checksums over every produced artefact (sorted for a stable SHA-256SUMS file).
(
  cd "$OUTDIR"
  # shellcheck disable=SC2012
  ls -1 | LC_ALL=C sort | while read -r f; do
    [ "$f" = "SHA-256SUMS" ] && continue
    shasum -a 256 "$f"
  done > SHA-256SUMS
)

echo "ok: release artefacts in dist/verifier/ (version=${VERSION})"
echo "    $(grep -c . "$OUTDIR/SHA-256SUMS") files checksummed"
