#!/usr/bin/env bash
# Point the DSH Desktop profiles' link plugins at this directory and reinstall the profiles with the
# app's bundled pnpm. dz-dsh-rollout runs it after each deploy, while every DSH window is closed
# (Desktop never runs pnpm at startup). Idempotent.
#
# It also connects every plugin of this directory (a subdirectory whose package.json declares
# dsh.bundle) that a profile lacks: a `link:` dependency plus its package name in dsh.profile.bundles,
# after the last @local/ bundle. A profile without a dsh.profile.bundles list gets no new plugin (a
# warning says so). PLUGINS_ENSURE="a b" limits this to the named subdirectories, PLUGINS_ENSURE=""
# to none; a plugin left out of the list is neither added nor removed.
#
# A plugin whose package.json declares dependencies gets them installed into its own node_modules
# (from its pnpm-lock.yaml) when any is missing or at another version than the exact pin.
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
# ROLLOUT_HOOK_SCOPE=test (verify.sh sets it) fixes only ROLLOUT_TEST_HOME and refuses only while a
# Desktop bundle inside that home runs (the test instance runs from <test home>/artifacts/), so the
# live app may stay open. The default, all, fixes both homes and refuses while any Desktop runs.
#
# Environment: ROLLOUT_LIVE_HOME, ROLLOUT_TEST_HOME (homes whose profiles/desktop is fixed),
# ROLLOUT_APP (bundled Node and pnpm; ROLLOUT_NODE / ROLLOUT_PNPM override them),
# DSH_TOOLS_OLD_PLUGINS (the retired plugin root, default ~/dev/dsh-plugins), PLUGINS_ENSURE,
# ROLLOUT_HOOK_SCOPE (all or test).
set -euo pipefail
case ${1:-} in -h|--help) sed -n '2,/^[^#]/p' "$0" | sed '$d'; exit 0 ;; esac
HERE=$(cd "$(dirname "$0")" && pwd)
LIVE_HOME=${ROLLOUT_LIVE_HOME:-$HOME/.dsh}
TEST_HOME=${ROLLOUT_TEST_HOME:-$HOME/.dsh-dev}
SCOPE=${ROLLOUT_HOOK_SCOPE:-all}
case $SCOPE in
  all) HOMES=("$LIVE_HOME" "$TEST_HOME") ;;
  test) HOMES=("$TEST_HOME") ;;
  *) echo "plugins/install.sh: ROLLOUT_HOOK_SCOPE must be all or test, not $SCOPE" >&2; exit 1 ;;
esac
OLD=${DSH_TOOLS_OLD_PLUGINS:-$HOME/dev/dsh-plugins}
APP=${ROLLOUT_APP:-$HOME/Applications/DeepSeek Harness.app}
RT="$APP/Contents/Resources/runtime/primary-runtime/dependencies"
NODE=${ROLLOUT_NODE:-$RT/node/bin/node}
PNPM=${ROLLOUT_PNPM:-$RT/pnpm/bin/pnpm.mjs}
[ -x "$NODE" ] || { echo "plugins/install.sh: no Node at $NODE" >&2; exit 1; }
[ -f "$PNPM" ] || { echo "plugins/install.sh: no pnpm at $PNPM" >&2; exit 1; }

# First running DSH Desktop bundle that holds a profile this run fixes, if any: with
# ROLLOUT_HOOK_SCOPE=test only a bundle inside the test home counts.
running_desktop() {
  local bundle id
  while IFS= read -r bundle; do
    if [ "$SCOPE" = test ] && [[ "$bundle" != "$TEST_HOME"/* ]]; then continue; fi
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

# The profile's pnpm does not install the dependencies of a link: package, so a plugin that declares
# dependencies (web-search-exa) keeps them in its own node_modules. Install them from the plugin's
# lockfile unless each one is already there at its exact pinned version.
DEPS_MISSING='
  const fs = require("fs")
  const path = require("path")
  const dir = process.argv[1]
  const deps = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).dependencies || {}
  const missing = Object.entries(deps).filter(([name, spec]) => {
    const manifest = path.join(dir, "node_modules", name, "package.json")
    return !fs.existsSync(manifest) || JSON.parse(fs.readFileSync(manifest, "utf8")).version !== spec
  })
  console.log(missing.map(([name]) => name).join(" "))'
for manifest in "$HERE"/*/package.json; do
  dir=$(dirname "$manifest")
  missing=$("$NODE" -e "$DEPS_MISSING" "$dir")
  [ -n "$missing" ] || continue
  if ! "$NODE" "$PNPM" --dir "$dir" install --frozen-lockfile; then
    echo "plugins/install.sh: pnpm install failed in $dir (missing: $missing)" >&2
    exit 1
  fi
  echo "$dir: installed $missing"
done

# Node script, args: SRC DST OLD NEW. Writes SRC's package.json to DST with link plugins moved from
# OLD to NEW and the missing NEW plugins connected (via rename keeping DST's file mode, only when
# something changed; otherwise DST gets SRC's bytes). Prints "<moved> <added> [added names…]".
REWRITE='
  const fs = require("fs")
  const path = require("path")
  const [src, dst, oldRoot, newRoot] = process.argv.slice(1)
  const pkg = JSON.parse(fs.readFileSync(src, "utf8"))
  let moved = 0
  for (const deps of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]) {
    for (const [name, spec] of Object.entries(deps || {})) {
      if (typeof spec === "string" && spec.startsWith(`link:${oldRoot}/`)) {
        deps[name] = `link:${newRoot}/${spec.slice(`link:${oldRoot}/`.length)}`
        moved++
      }
    }
  }
  const wanted = process.env.PLUGINS_ENSURE === undefined
    ? fs.readdirSync(newRoot).sort()
    : process.env.PLUGINS_ENSURE.split(/\s+/).filter(Boolean)
  const plugins = []
  for (const dir of wanted) {
    const manifest = path.join(newRoot, dir, "package.json")
    if (!fs.existsSync(manifest)) {
      if (process.env.PLUGINS_ENSURE !== undefined) throw new Error(`PLUGINS_ENSURE names ${dir}, which has no ${manifest}`)
      continue
    }
    const meta = JSON.parse(fs.readFileSync(manifest, "utf8"))
    if (meta.dsh && meta.dsh.bundle && typeof meta.name === "string") plugins.push({ name: meta.name, spec: `link:${newRoot}/${dir}` })
  }
  const bundles = pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : null
  const added = []
  for (const plugin of plugins) {
    const deps = [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]
    const hasDep = deps.some(d => d && Object.prototype.hasOwnProperty.call(d, plugin.name))
    if (hasDep && (bundles === null || bundles.includes(plugin.name))) continue
    if (bundles === null) {
      console.error(`${src}: no dsh.profile.bundles list; ${plugin.name} not connected`)
      continue
    }
    if (!hasDep) pkg.dependencies = { ...(pkg.dependencies || {}), [plugin.name]: plugin.spec }
    let at = -1
    bundles.forEach((bundle, i) => { if (typeof bundle === "string" && bundle.startsWith("@local/")) at = i })
    bundles.splice(at === -1 ? bundles.length : at + 1, 0, plugin.name)
    added.push(plugin.name)
  }
  if (moved + added.length > 0) {
    fs.writeFileSync(`${dst}.tmp`, JSON.stringify(pkg, null, 2) + "\n")
    if (fs.existsSync(dst)) fs.chmodSync(`${dst}.tmp`, fs.statSync(dst).mode & 0o777)
    fs.renameSync(`${dst}.tmp`, dst)
  } else if (src !== dst) {
    fs.copyFileSync(src, dst)
  }
  console.log([moved, added.length, ...added].join(" "))'

for home in "${HOMES[@]}"; do
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
  read -r moved added names <<<"$changed"
  if [ "$moved" = 0 ] && [ "$added" = 0 ]; then rm -f "$backup"; echo "$profile: no link plugin under $OLD, no plugin to connect"; continue; fi
  if ! "$NODE" "$PNPM" --dir "$profile" install --no-frozen-lockfile; then
    mv "$backup" "$profile/package.json"
    echo "plugins/install.sh: pnpm install failed in $profile; package.json restored" >&2
    exit 1
  fi
  rm -f "$backup"
  [ "$moved" = 0 ] || echo "$profile: $moved link plugin(s) now under $HERE"
  [ "$added" = 0 ] || echo "$profile: connected $names"
done
