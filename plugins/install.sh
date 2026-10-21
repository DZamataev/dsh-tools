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
# Environment: ROLLOUT_LIVE_HOME, ROLLOUT_TEST_HOME (homes whose profiles/desktop is fixed),
# ROLLOUT_APP (bundled Node and pnpm; ROLLOUT_NODE / ROLLOUT_PNPM override them),
# DSH_TOOLS_OLD_PLUGINS (the retired plugin root, default ~/dev/dsh-plugins).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OLD=${DSH_TOOLS_OLD_PLUGINS:-$HOME/dev/dsh-plugins}
APP=${ROLLOUT_APP:-$HOME/Applications/DeepSeek Harness.app}
RT="$APP/Contents/Resources/runtime/primary-runtime/dependencies"
NODE=${ROLLOUT_NODE:-$RT/node/bin/node}
PNPM=${ROLLOUT_PNPM:-$RT/pnpm/bin/pnpm.mjs}
[ -x "$NODE" ] || { echo "plugins/install.sh: no Node at $NODE" >&2; exit 1; }
[ -f "$PNPM" ] || { echo "plugins/install.sh: no pnpm at $PNPM" >&2; exit 1; }

# Node script, args: SRC DST OLD NEW. Writes SRC's package.json with link plugins moved from OLD to NEW
# to DST (via rename, only when a link moved; otherwise DST gets SRC's bytes) and prints how many moved.
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
