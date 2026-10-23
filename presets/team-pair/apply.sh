#!/usr/bin/env bash
# Install Team mode, Codex mode and Codex teammate mode into a DSH home (default: the test home ~/.dsh-dev).
#   - adds the Agent Teams bundle and @local/dsh-apply-patch (the dsh-apply-patch submodule next to this
#     script, as a plain `file:` dependency, never a bundle) to profiles/desktop/package.json, drops the
#     earlier npm `dsh-patch-edit-plus`, and installs with the app's bundled pnpm
#   - generates the presets from the DSH sources and the roles file and writes them between
#     `# >>> team-pair` markers in profiles/desktop/cordis.patch.yml
#   - installs the team-pair skill into <home>/skills/team-pair
#
# dz-dsh-rollout runs it as ROLLOUT_PROFILE_SETUP: verify.sh on the test home, deploy.sh on the live
# home, each time with that home's Desktop closed and ROLLOUT_SRC at the built sha.
#
# Environment:
#   ROLLOUT_SRC / SRC    DSH checkout whose shipped presets are the base (default ~/dev/deepseek-harness);
#                        it must contain Agent Teams roles with agentPreset (fork branch feat/agent-team-models)
#   TEAM_PAIR_ROLES      roles and models (default ~/.config/dz-dsh-rollout/team-roles.yml when it
#                        exists, else pair-roles.yml next to this script)
#   ROLLOUT_APP          DSH app whose bundled Node and pnpm are used (default ~/Applications/DeepSeek Harness.app)
#   ALLOW_LIVE=1         required for the live home ~/.dsh; quit DSH first
# Idempotent.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${1:-$HOME/.dsh-dev}"
case "$HOME_DIR" in "$HOME/.dsh"|"$HOME/.dsh/") [ "${ALLOW_LIVE:-0}" = 1 ] || { echo "apply.sh: refusing live home $HOME_DIR (ALLOW_LIVE=1 to override)" >&2; exit 2; } ;; esac
PROFILE="$HOME_DIR/profiles/desktop"
[ -f "$PROFILE/package.json" ] || { echo "apply.sh: no $PROFILE/package.json" >&2; exit 2; }
BUNDLE='@deepseek-ai/dsh-experimental-agent-team-profile'

SRC="${ROLLOUT_SRC:-${SRC:-$HOME/dev/deepseek-harness}}"
BUNDLE_PATCH="$SRC/packages/experimental/agent-team-profile/cordis.patch.yml"
STANDARD_PATCH="$SRC/packages/bundle/web-app/presets/standard.patch.yml"
for f in "$BUNDLE_PATCH" "$STANDARD_PATCH"; do
  [ -f "$f" ] || { echo "apply.sh: no $f (set ROLLOUT_SRC to a DSH checkout)" >&2; exit 2; }
done
grep -q 'agentPreset' "$SRC/packages/experimental/tool-agent-team/src/routes.ts" 2>/dev/null \
  || { echo "apply.sh: $SRC has no agentPreset on Agent Teams roles (needs fork branch feat/agent-team-models)" >&2; exit 2; }
ROLES="${TEAM_PAIR_ROLES:-${XDG_CONFIG_HOME:-$HOME/.config}/dz-dsh-rollout/team-roles.yml}"
[ -f "$ROLES" ] || ROLES="$HERE/pair-roles.yml"
APP="${ROLLOUT_APP:-$HOME/Applications/DeepSeek Harness.app}"
RT="$APP/Contents/Resources/runtime/primary-runtime/dependencies"
NODE="$RT/node/bin/node"
[ -x "$NODE" ] || { echo "apply.sh: no Node at $NODE (set ROLLOUT_APP)" >&2; exit 2; }
PATCH_PKG="$HERE/dsh-apply-patch"
[ -f "$PATCH_PKG/lib/index.js" ] || { echo "apply.sh: $PATCH_PKG is empty; run: git -C $(cd "$HERE/../.." && pwd) submodule update --init" >&2; exit 2; }
[ ! -e "$PATCH_PKG/node_modules" ] || { echo "apply.sh: $PATCH_PKG has node_modules; develop in a separate clone, the profile must not see dev dependencies" >&2; exit 2; }

# Generate both presets before touching the profile, so a generator failure changes nothing.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
python3 "$HERE/make-pair-preset.py" "$BUNDLE_PATCH" "$ROLES" "$work/pair.yml" >/dev/null
python3 "$HERE/make-codex-presets.py" "$STANDARD_PATCH" "$BUNDLE_PATCH" "$work/codex.yml" >/dev/null
echo "presets: generated from $SRC with roles $ROLES"

"$NODE" - "$PROFILE/package.json" "$BUNDLE" "$PATCH_PKG" <<'EOF'
const fs = require('node:fs')
const [file, bundle, patchPkg] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
const bundles = (((pkg.dsh ??= {}).profile ??= {}).bundles ??= [])
if (!bundles.includes(bundle)) bundles.push(bundle)
const deps = (pkg.dependencies ??= {})
delete deps['dsh-patch-edit-plus']
deps['@local/dsh-apply-patch'] = `file:${patchPkg}`
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
EOF
pnpm() { (cd "$PROFILE" && "$NODE" "$RT/pnpm/bin/pnpm.mjs" "$@"); }
pnpm install --silent
INSTALLED="$PROFILE/node_modules/@local/dsh-apply-patch"
# pnpm keeps an earlier copy of a file: directory; reinstall when it differs from the submodule.
if ! diff -rq "$PATCH_PKG/lib" "$INSTALLED/lib" >/dev/null 2>&1; then pnpm install --silent --force; fi
diff -rq "$PATCH_PKG/lib" "$INSTALLED/lib" >/dev/null || { echo "apply.sh: $INSTALLED does not match $PATCH_PKG" >&2; exit 4; }
echo "profile: Agent Teams bundle and @local/dsh-apply-patch ($(git -C "$PATCH_PKG" rev-parse --short HEAD 2>/dev/null || echo local)) in $PROFILE/package.json"

PATCH="$PROFILE/cordis.patch.yml"
touch "$PATCH"
BEGIN='# >>> team-pair (managed by dsh-tools presets/team-pair/apply.sh; generated, do not edit)'
END='# <<< team-pair'
# Any `# >>> team-pair` marker counts, so a block written by an older version is replaced too.
awk -v e="$END" 'index($0, "# >>> team-pair") == 1 {skip=1; next} $0==e {skip=0; next} !skip' "$PATCH" > "$work/rest.yml"
{ cat "$work/rest.yml"; echo "$BEGIN"; cat "$work/pair.yml" "$work/codex.yml"; echo "$END"; } > "$PATCH"
echo "patch: $PATCH (team-pair block refreshed)"

mkdir -p "$HOME_DIR/skills"
rm -rf "$HOME_DIR/skills/team-pair"
cp -R "$HERE/skill-team-pair" "$HOME_DIR/skills/team-pair"
echo "skill: $HOME_DIR/skills/team-pair/SKILL.md"
