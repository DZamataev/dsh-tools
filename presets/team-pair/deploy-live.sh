#!/usr/bin/env bash
# One-shot rollout of the Team mode / Codex presets to the live DSH Desktop (home ~/.dsh):
#   1. refuses while any DSH turn is running (deploy.sh --dry-run reads the open turns);
#   2. quits the test instance and the live app (the app's own quit dialog guards running tasks);
#   3. backs up the live profile and runs apply.sh on ~/.dsh (pair + Codex presets, dsh-patch-edit-plus);
#   4. runs deploy.sh (installs the verified build, runs plugins/install.sh, reopens the app);
#   5. checks the deployed sha and the signature.
# On a failure in step 3 the profile backups are restored and the old app is reopened.
#
# Run from Terminal or Ghostty, not from inside DSH:   ~/dev/dsh-tools/presets/team-pair/deploy-live.sh
#   --dry-run   check everything (turns, apply.sh on a copy of the live profile) and change nothing
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROLLOUT="$HOME/.agents/skills/dz-dsh-rollout/scripts"
APP="$HOME/Applications/DeepSeek Harness.app"
PROFILE="$HOME/.dsh/profiles/desktop"
dry_run=false
[ "${1:-}" = "--dry-run" ] && dry_run=true

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nDEPLOY-LIVE FAILED: %s\n' "$*" >&2; osascript -e "display notification \"$*\" with title \"DSH deploy-live failed\"" >/dev/null 2>&1 || true; exit 1; }
app_pids() { ps -axo pid=,comm= | awk -v dir="$APP/Contents/MacOS/" '{ pid=$1; sub(/^ *[0-9]+ /, ""); if (index($0, dir) == 1 && index(substr($0, length(dir) + 1), "/") == 0) print pid }'; }

if [ -n "${DSH_SESSION_ID:-}" ] || [ "${DSH_SHELL:-}" = 1 ]; then
  $dry_run || die "run this from Terminal or Ghostty, not from inside DSH (it quits DSH)"
fi

say "preconditions"
plan=$("$ROLLOUT/deploy.sh" --dry-run 2>&1) || die "deploy.sh --dry-run failed:
$plan"
printf '%s\n' "$plan" | grep -E '^(live |would:)' || true
if printf '%s\n' "$plan" | grep -q 'still running in a DSH window'; then
  printf '%s\n' "$plan" | sed -n '/running turns:/,/WARNING/p'
  $dry_run || die "a DSH turn is still running; wait for it to finish and run this again"
  echo "(dry run: a running turn would stop the real run)"
fi

say "apply.sh on a copy of the live profile"
copy="$(mktemp -d /tmp/dsh-live-apply.XXXXXX)"
mkdir -p "$copy/profiles/desktop"
cp "$PROFILE/package.json" "$PROFILE/cordis.patch.yml" "$copy/profiles/desktop/"
for f in pnpm-workspace.yaml pnpm-lock.yaml; do [ -f "$PROFILE/$f" ] && cp "$PROFILE/$f" "$copy/profiles/desktop/"; done
bash "$HERE/apply.sh" "$copy" >/dev/null || die "apply.sh fails on a copy of the live profile ($copy); nothing changed"
rm -rf "${copy:?}"
echo "ok"

if $dry_run; then echo; echo "DEPLOY-LIVE OK: dry run, nothing changed"; exit 0; fi

say "quit the test instance and DSH"
"$ROLLOUT/verify.sh" --stop >/dev/null 2>&1 || true
if [ -n "$(app_pids)" ]; then
  osascript -e "tell application \"$APP\" to quit" >/dev/null 2>&1 \
    || die "macOS refused to quit DSH from this terminal (System Settings → Privacy & Security → Automation); nothing changed"
  for _ in $(seq 1 120); do [ -z "$(app_pids)" ] && break; sleep 1; done
  [ -z "$(app_pids)" ] || die "DSH is still running after 120 s (answer its quit dialog); nothing changed"
fi
echo "closed"

say "presets and dsh-patch-edit-plus in the live profile"
ts=$(date +%Y%m%d-%H%M%S)
cp "$PROFILE/package.json" "$PROFILE/package.json.bak-deploy-live-$ts"
cp "$PROFILE/cordis.patch.yml" "$PROFILE/cordis.patch.yml.bak-deploy-live-$ts"
if ! ALLOW_LIVE=1 bash "$HERE/apply.sh" "$HOME/.dsh"; then
  cp "$PROFILE/package.json.bak-deploy-live-$ts" "$PROFILE/package.json"
  cp "$PROFILE/cordis.patch.yml.bak-deploy-live-$ts" "$PROFILE/cordis.patch.yml"
  open "$APP"
  die "apply.sh failed on ~/.dsh; profile restored from *.bak-deploy-live-$ts, old DSH reopened"
fi
echo "backups: $PROFILE/{package.json,cordis.patch.yml}.bak-deploy-live-$ts"

say "deploy the verified build"
"$ROLLOUT/deploy.sh" || die "deploy.sh failed (see above); the profile already has the new presets, backups: *.bak-deploy-live-$ts"

say "checks"
deployed=$("$ROLLOUT/state.sh" 2>/dev/null | sed -n 's/^deployed=\([0-9a-f]*\).*/\1/p')
develop=$(git -C "$HOME/dev/deepseek-harness" rev-parse develop)
[ "$deployed" = "$develop" ] || die "deployed sha $deployed differs from develop $develop"
codesign -d -r- "$APP" 2>&1 | grep -q 'subject.OU] = "68QJJA7HK9"' || die "the installed app is not signed by 68QJJA7HK9"
echo "deployed ${deployed:0:10}, signed by 68QJJA7HK9"
echo
echo "DEPLOY-LIVE OK: DSH reopened on ${deployed:0:10} with Team mode, Codex mode and Codex teammate mode."
echo "Check: a TeamClaude chat answers; the preset picker lists the three new modes."
osascript -e 'display notification "DSH reopened with Team mode and Codex mode" with title "DSH deploy-live OK"' >/dev/null 2>&1 || true
