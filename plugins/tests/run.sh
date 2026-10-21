#!/usr/bin/env bash
# Bench for plugins/install.sh against a sandbox profile. Needs a Node and the pnpm entry Desktop
# pins: ROLLOUT_NODE / ROLLOUT_PNPM, defaulting to `node` on PATH and the deepseek-harness
# checkout's apps/desktop/node_modules/pnpm/bin/pnpm.mjs.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; P="$(cd "$HERE/.." && pwd)"
SB="$(mktemp -d)"; SB="$(cd "$SB" && pwd -P)"; trap 'rm -rf "$SB"' EXIT
FAILS=0
ok()  { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; FAILS=$((FAILS + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
ROLLOUT_NODE=${ROLLOUT_NODE:-$(command -v node)}
ROLLOUT_PNPM=${ROLLOUT_PNPM:-$HOME/dev/deepseek-harness/apps/desktop/node_modules/pnpm/bin/pnpm.mjs}
export ROLLOUT_NODE ROLLOUT_PNPM
[ -f "$ROLLOUT_PNPM" ] || { echo "skip: no pnpm entry at $ROLLOUT_PNPM"; exit 0; }

OLD="$SB/old-plugins"; mkdir -p "$OLD/provider-limits"
cp "$P/provider-limits/package.json" "$OLD/provider-limits/package.json"
H="$SB/home"; PR="$H/profiles/desktop"; mkdir -p "$PR"
cat > "$PR/package.json" <<EOT
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "@local/dsh-provider-limits": "link:$OLD/provider-limits"
  }
}
EOT
printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "$PR/pnpm-workspace.yaml"
"$ROLLOUT_NODE" "$ROLLOUT_PNPM" --dir "$PR" install >/dev/null 2>&1

run() { DSH_TOOLS_OLD_PLUGINS="$OLD" ROLLOUT_LIVE_HOME="$H" ROLLOUT_TEST_HOME="$SB/none" bash "$P/install.sh" 2>&1; }
out=$(run)
check "install.sh reports the relinked plugin"          '[[ $out == *"1 link plugin(s) now under $P"* ]]'
check "package.json points at dsh-tools/plugins"        'grep -q "\"link:$P/provider-limits\"" "$PR/package.json"'
check "node_modules resolves to dsh-tools/plugins"      '[ "$(cd "$PR/node_modules/@local/dsh-provider-limits" && pwd -P)" = "$P/provider-limits" ]'
out=$(run)
check "a second run changes nothing"                    '[[ $out == *"no link plugin under $OLD"* ]]'
out=$(ROLLOUT_LIVE_HOME="$SB/none" ROLLOUT_TEST_HOME="$SB/none2" bash "$P/install.sh" 2>&1); rc=$?
check "homes without a desktop profile are skipped, exit 0" '[ $rc -eq 0 ]'

# pnpm failure: package.json is restored, the failure is not swallowed on retry
echo 'process.exit(1)' > "$SB/pnpm-fail.mjs"; echo 'process.exit(0)' > "$SB/pnpm-ok.mjs"
H2="$SB/home2"; PR2="$H2/profiles/desktop"; mkdir -p "$PR2"
cat > "$PR2/package.json" <<EOT
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "@local/a": "link:$OLD/provider-limits",
    "@local/b": "link:$OLD-other/x",
    "left-pad": "^1.0.0"
  }
}
EOT
cp "$PR2/package.json" "$SB/before.json"
out=$(DSH_TOOLS_OLD_PLUGINS="$OLD" ROLLOUT_PNPM="$SB/pnpm-fail.mjs" ROLLOUT_LIVE_HOME="$H2" ROLLOUT_TEST_HOME="$SB/none" bash "$P/install.sh" 2>&1); rc=$?
check "a failing pnpm makes install.sh exit non-zero"   '[ $rc -ne 0 ]'
check "a failing pnpm leaves package.json byte-identical" 'cmp -s "$PR2/package.json" "$SB/before.json"'
check "a failing pnpm leaves no backup file"            '[ -z "$(ls "$PR2" | grep -F .bak)" ]'
out=$(DSH_TOOLS_OLD_PLUGINS="$OLD" ROLLOUT_PNPM="$SB/pnpm-ok.mjs" ROLLOUT_LIVE_HOME="$H2" ROLLOUT_TEST_HOME="$SB/none" bash "$P/install.sh" 2>&1); rc=$?
check "the retry after a failure reruns pnpm and succeeds" '[ $rc -eq 0 ] && [[ $out == *"1 link plugin(s) now under $P"* ]]'
check "only the exact old root is rewritten"            'grep -q "\"@local/a\": \"link:$P/provider-limits\"" "$PR2/package.json" && grep -q "\"@local/b\": \"link:$OLD-other/x\"" "$PR2/package.json" && grep -q "\"left-pad\": \"^1.0.0\"" "$PR2/package.json"'
check "a successful run leaves no backup file"          '[ -z "$(ls "$PR2" | grep -F .bak)" ]'

echo
if [ $FAILS -eq 0 ]; then echo "all passed"; else echo "$FAILS failed"; fi
exit $FAILS
