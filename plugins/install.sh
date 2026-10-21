#!/usr/bin/env bash
# Point the DSH Desktop profiles' link plugins at this directory and reinstall the profiles with the
# app's bundled pnpm. dz-dsh-rollout runs it after each deploy, while every DSH window is closed
# (Desktop never runs pnpm at startup). Idempotent. A failed pnpm install restores package.json from
# a backup, so a retry sees the old links again.
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

for home in "${ROLLOUT_LIVE_HOME:-$HOME/.dsh}" "${ROLLOUT_TEST_HOME:-$HOME/.dsh-dev}"; do
  profile=$home/profiles/desktop
  [ -f "$profile/package.json" ] || continue
  backup=$profile/package.json.dz-relink.bak
  cp "$profile/package.json" "$backup"
  changed=$("$NODE" -e '
    const fs = require("fs")
    const [file, oldRoot, newRoot] = process.argv.slice(1)
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
    let n = 0
    for (const deps of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]) {
      for (const [name, spec] of Object.entries(deps || {})) {
        if (typeof spec === "string" && spec.startsWith(`link:${oldRoot}/`)) {
          deps[name] = `link:${newRoot}/${spec.slice(`link:${oldRoot}/`.length)}`
          n++
        }
      }
    }
    if (n > 0) fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n")
    console.log(n)' "$profile/package.json" "$OLD" "$HERE")
  if [ "$changed" = 0 ]; then rm -f "$backup"; echo "$profile: no link plugin under $OLD"; continue; fi
  if ! "$NODE" "$PNPM" --dir "$profile" install --no-frozen-lockfile; then
    mv "$backup" "$profile/package.json"
    echo "plugins/install.sh: pnpm install failed in $profile; package.json restored" >&2
    exit 1
  fi
  rm -f "$backup"
  echo "$profile: $changed link plugin(s) now under $HERE"
done
