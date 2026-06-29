#!/usr/bin/env bash
# PKG1 §E — packaged-tarball acceptance: build, pack for real, scan the ACTUAL produced tarball, assert
# only the intended files ship and no forbidden artifact leaks. A publish-time gate (not in the 14-leg
# `verify`, like the consumer smoke). Self-cleaning.
set -uo pipefail
cd "$(dirname "$0")/.."

pnpm run build >/dev/null 2>&1 || { echo "pkg-pack-check: FAIL — build failed" >&2; exit 1; }

TGZ="$(npm pack --silent 2>/dev/null | tail -1)"
[ -n "$TGZ" ] && [ -f "$TGZ" ] || { echo "pkg-pack-check: FAIL — npm pack produced no tarball" >&2; exit 1; }
trap 'rm -f "$TGZ"' EXIT

LIST="$(tar -tf "$TGZ" | sed 's#^package/##' | grep -vE '^$')"
fail=0
note() { echo "  pkg-pack-check: $1"; fail=1; }

# (1) no top-level member outside the allowed set (order/locale-independent).
ALLOWED_TOP=" dist LICENSE README.md package.json "
while IFS= read -r m; do
  [ -z "$m" ] && continue
  case "$ALLOWED_TOP" in *" $m "*) ;; *) note "unexpected top-level member: $m" ;; esac
done < <(printf '%s\n' "$LIST" | cut -d/ -f1 | sort -u)

# (2) required files present.
printf '%s\n' "$LIST" | grep -qx "README.md" || note "missing README.md"
printf '%s\n' "$LIST" | grep -qx "LICENSE"   || note "missing LICENSE"
printf '%s\n' "$LIST" | grep -qx "package.json" || note "missing package.json"

# (3) denylist — no forbidden artifact may ship.
DENY='\.map$|\.test\.|/__tests__/|fixture|\.env|\.pem$|\.key$|\.wasm$|/verifier($|/)'
HITS="$(printf '%s\n' "$LIST" | grep -nE "$DENY" || true)"
[ -z "$HITS" ] || note "forbidden artifacts in tarball:
$HITS"

# (4) the shipped CLI bin must start with a shebang (installed `agentos` would fail otherwise).
SHEBANG="$(tar -xOf "$TGZ" package/dist/cli/main.js 2>/dev/null | head -1)"
[ "$SHEBANG" = "#!/usr/bin/env node" ] || note "dist/cli/main.js missing shebang (got: '$SHEBANG')"

if [ "$fail" -ne 0 ]; then echo "pkg-pack-check: FAIL" >&2; exit 1; fi
echo "pkg-pack-check: clean — only dist/ + README.md + LICENSE + package.json; no map/test/fixture/secret/wasm; bin shebang ok."
