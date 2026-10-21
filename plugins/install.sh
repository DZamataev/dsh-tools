#!/usr/bin/env bash
# Point the DSH Desktop profiles' link plugins at this directory and reinstall the profiles with the
# app's bundled pnpm. dz-dsh-rollout runs it after each deploy, while every DSH window is closed
# (Desktop never runs pnpm at startup). Idempotent.
#
# Before rewriting a profile's package.json the script saves the original as
# package.json.dz-relink.bak (copied to .bak.tmp first, so a .bak is always complete). A failed pnpm
# install puts the original back and removes the backup. A run killed (signal, power loss) after the
# backup and before the end of pnpm install leaves the backup; the next run restores it and relinks
# again, but only while package.json is exactly the rewrite of the backup. Anything else (edits
# since, a backup that is not valid JSON) stops with exit 1 and both files untouched.
#
# Refuses while a DSH Desktop runs (a process whose executable sits directly in <bundle>.app/Contents/MacOS/
# of a bundle whose CFBundleIdentifier starts with ROLLOUT_BUNDLE_ID, default com.deepseek.harness):
# it holds the profiles open. PLUGINS_ALLOW_RUNNING_DESKTOP=1 skips the check (for the bench).
#
# Environment: ROLLOUT_LIVE_HOME, ROLLOUT_TEST_HOME (homes whose profiles/desktop is fixed),
# ROLLOUT_APP (bundled Node and pnpm; ROLLOUT_NODE / ROLLOUT_PNPM override them),
# DSH_TOOLS_OLD_PLUGINS (the retired plugin root, default ~/dev/dsh-plugins).
set -euo pipefail
case ${1:-} in -h|--help) sed -n '2,/^[^#]/p' "$0" | sed '$d'; exit 0 ;; esac
HERE=$(cd "$(dirname "$0")" && pwd)
OLD=${DSH_TOOLS_OLD_PLUGINS:-$HOME/dev/dsh-plugins}
APP=${ROLLOUT_APP:-$HOME/Applications/DeepSeek Harness.app}
RT="$APP/Contents/Resources/runtime/primary-runtime/dependencies"
NODE=${ROLLOUT_NODE:-$RT/node/bin/node}
PNPM=${ROLLOUT_PNPM:-$RT/pnpm/bin/pnpm.mjs}
[ -x "$NODE" ] || { echo "plugins/install.sh: no Node at $NODE" >&2; exit 1; }
[ -f "$PNPM" ] || { echo "plugins/install.sh: no pnpm at $PNPM" >&2; exit 1; }

# First running DSH Desktop bundle, if any.
running_desktop() {
  local bundle id
  while IFS= read -r bundle; do
    id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$bundle/Contents/Info.plist" 2>/dev/null || true)
    if [[ "$id" == "${ROLLOUT_BUNDLE_ID:-com.deepseek.harness}"* ]]; then printf '%s\n' "$bundle"; return 0; fi
  done < <(ps -axo comm= | sed -E 's/^ +//' | awk '{
    i = index($0, "/Contents/MacOS/"); if (i == 0) next
    bundle = substr($0, 1, i - 1); rest = substr($0, i + 16)
    if (rest == "" || index(rest, "/") > 0) next
    if (bundle !~ /\.app$/ || index(bundle, "/Contents/") > 0) next
    print bundle }' | sort -u)
}
if [ "${PLUGINS_ALLOW_RUNNING_DESKTOP:-0}" != 1 ]; then
  desk=$(running_desktop)
  if [ -n "$desk" ]; then echo "plugins/install.sh: a DSH Desktop is running ($desk) — quit it first" >&2; exit 1; fi
fi

# Node script, args: SRC DST OLD NEW. Writes SRC's package.json with link plugins moved from OLD to NEW
# to DST (via rename keeping DST's file mode, only when a link moved; otherwise DST gets SRC's bytes) and prints how many moved.
REWRITE='
  const fs = require("fs")
  const [src, dst, oldRoot, newRoot] = process.argv.slice(1)
  const pkg = JSON.parse(fs.readFileSync(src, "utf8"))
  let n = 0
  for (const deps of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]) {
    for (const [name, spec] of Object.entries(deps || {})) {
      if (typeof spec === "string" && spec.startsWith(`link:${oldRoot}/`)) {
        deps[name] = `link:${newRoot}/${spec.slice(`link:${oldRoot}/`.length)}`
        n++
      }
    }
  }
  if (n > 0) {
    fs.writeFileSync(`${dst}.tmp`, JSON.stringify(pkg, null, 2) + "\n")
    if (fs.existsSync(dst)) fs.chmodSync(`${dst}.tmp`, fs.statSync(dst).mode & 0o777)
    fs.renameSync(`${dst}.tmp`, dst)
  } else if (src !== dst) {
    fs.copyFileSync(src, dst)
  }
  console.log(n)'

for home in "${ROLLOUT_LIVE_HOME:-$HOME/.dsh}" "${ROLLOUT_TEST_HOME:-$HOME/.dsh-dev}"; do
  profile=$home/profiles/desktop
  backup=$profile/package.json.dz-relink.bak
  rm -f "$backup.tmp"
  if [ -f "$backup" ]; then
    expected=$(mktemp)
    if "$NODE" -e "$REWRITE" "$backup" "$expected" "$OLD" "$HERE" >/dev/null 2>&1 \
        && cmp -s "$expected" "$profile/package.json"; then
      rm -f "$expected"
      mv "$backup" "$profile/package.json"
      echo "$profile: restored package.json from an unfinished relink"
    else
      rm -f "$expected"
      echo "plugins/install.sh: $profile/package.json changed after an unfinished relink — compare it with $backup, then remove the backup" >&2
      exit 1
    fi
  fi
  [ -f "$profile/package.json" ] || continue
  cp "$profile/package.json" "$backup.tmp"
  mv "$backup.tmp" "$backup"
  if ! changed=$("$NODE" -e "$REWRITE" "$profile/package.json" "$profile/package.json" "$OLD" "$HERE"); then
    rm -f "$backup"
    echo "plugins/install.sh: cannot relink $profile/package.json" >&2
    exit 1
  fi
  if [ "$changed" = 0 ]; then rm -f "$backup"; echo "$profile: no link plugin under $OLD"; continue; fi
  if ! "$NODE" "$PNPM" --dir "$profile" install --no-frozen-lockfile; then
    mv "$backup" "$profile/package.json"
    echo "plugins/install.sh: pnpm install failed in $profile; package.json restored" >&2
    exit 1
  fi
  rm -f "$backup"
  echo "$profile: $changed link plugin(s) now under $HERE"
done
