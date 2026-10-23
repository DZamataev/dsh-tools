#!/usr/bin/env bash
# Install Team mode, Codex mode and Codex teammate mode into a DSH home (default: the test home ~/.dsh-dev).
#   - adds the Agent Teams bundle and dsh-patch-edit-plus@0.4.3 (plain dependency, never a bundle) to
#     profiles/desktop/package.json and installs it with the app's bundled pnpm
#   - writes pair-preset.cordis.patch.yml (the bundle's `team` preset as "Team mode" with the roles of
#     pair-roles.yml) and codex-presets.cordis.patch.yml between markers in profiles/desktop/cordis.patch.yml
#   - installs the team-pair skill into <home>/skills/team-pair
# Both preset files are generated (make-pair-preset.py, make-codex-presets.py) from the DSH sources in
# SRC (default: the fork checkout ~/dev/deepseek-harness); a copy that no longer matches its sources is
# refused. Idempotent. Quit the DSH Desktop that uses the home first; the live home needs ALLOW_LIVE=1.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${1:-$HOME/.dsh-dev}"
case "$HOME_DIR" in "$HOME/.dsh"|"$HOME/.dsh/") [ "${ALLOW_LIVE:-0}" = 1 ] || { echo "apply.sh: refusing live home $HOME_DIR (ALLOW_LIVE=1 to override)" >&2; exit 2; } ;; esac
PROFILE="$HOME_DIR/profiles/desktop"
[ -f "$PROFILE/package.json" ] || { echo "apply.sh: no $PROFILE/package.json" >&2; exit 2; }
BUNDLE='@deepseek-ai/dsh-experimental-agent-team-profile'

# Drift check: both preset files are copies of shipped presets. Regenerate them into temp files and
# refuse a stale copy; the message names the command that refreshes it.
SRC="${SRC:-$HOME/dev/deepseek-harness}"
BUNDLE_PATCH="$SRC/packages/experimental/agent-team-profile/cordis.patch.yml"
STANDARD_PATCH="$SRC/packages/bundle/web-app/presets/standard.patch.yml"
for f in "$BUNDLE_PATCH" "$STANDARD_PATCH"; do
  [ -f "$f" ] || { echo "apply.sh: no $f (set SRC to a DSH checkout)" >&2; exit 2; }
done
check_fresh() {  # $1 = committed copy, rest = generator and its inputs
  local copy=$1 fresh; shift
  fresh="$(mktemp)"
  python3 "$@" "$fresh" >/dev/null
  if ! cmp -s "$fresh" "$copy"; then
    rm -f "$fresh"
    echo "apply.sh: $(basename "$copy") is stale against $SRC; run: python3 $* $copy" >&2
    exit 3
  fi
  rm -f "$fresh"
}
check_fresh "$HERE/pair-preset.cordis.patch.yml" "$HERE/make-pair-preset.py" "$BUNDLE_PATCH" "$HERE/pair-roles.yml"
check_fresh "$HERE/codex-presets.cordis.patch.yml" "$HERE/make-codex-presets.py" "$STANDARD_PATCH" "$BUNDLE_PATCH"


node - "$PROFILE/package.json" "$BUNDLE" <<'EOF'
const fs = require('node:fs')
const [file, bundle] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
const profile = ((pkg.dsh ??= {}).profile ??= {})
const bundles = (profile.bundles ??= [])
if (!bundles.includes(bundle)) bundles.push(bundle)
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
console.log('bundles:', bundles.join(', '))
EOF

# Codex teammates: dsh-patch-edit-plus as a plain dependency (exact, audited 0.4.3), never a bundle.
node - "$PROFILE/package.json" <<'EOF2'
const fs = require('node:fs')
const [file] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
const deps = (pkg.dependencies ??= {})
deps['dsh-patch-edit-plus'] = '0.4.3'
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
console.log('dependency: dsh-patch-edit-plus@0.4.3')
EOF2
RT="${ROLLOUT_APP:-$HOME/Applications/DeepSeek Harness.app}/Contents/Resources/runtime/primary-runtime/dependencies"
(cd "$PROFILE" && "$RT/node/bin/node" "$RT/pnpm/bin/pnpm.mjs" install --silent)
[ -f "$PROFILE/node_modules/dsh-patch-edit-plus/package.json" ] || { echo "apply.sh: dsh-patch-edit-plus did not install" >&2; exit 4; }

PATCH="$PROFILE/cordis.patch.yml"
touch "$PATCH"
BEGIN='# >>> team-pair (managed by ~/dev/dsh-tools/presets/team-pair/apply.sh)'
END='# <<< team-pair'
tmp="$(mktemp)"
# Any earlier `# >>> team-pair` marker counts, so a block written from the old location is replaced too.
awk -v e="$END" 'index($0, "# >>> team-pair") == 1 {skip=1; next} $0==e {skip=0; next} !skip' "$PATCH" > "$tmp"
{ cat "$tmp"; echo "$BEGIN"; cat "$HERE/pair-preset.cordis.patch.yml"; cat "$HERE/codex-presets.cordis.patch.yml"; echo "$END"; } > "$PATCH"
rm -f "$tmp"
echo "patch: $PATCH (team-pair block refreshed)"

mkdir -p "$HOME_DIR/skills"
rm -rf "$HOME_DIR/skills/team-pair"
cp -R "$HERE/skill-team-pair" "$HOME_DIR/skills/team-pair"
echo "skill: $HOME_DIR/skills/team-pair/SKILL.md"
