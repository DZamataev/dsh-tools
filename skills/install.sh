#!/usr/bin/env bash
# Install dsh-tools skills.
#
#   ./install.sh [--target agents|claude|codex] [--force] [<skill>...]
#
# --target agents (default) installs into ~/.agents/skills/ (every DSH home reads it), claude into
# ~/.claude/skills/, codex into ${CODEX_HOME:-~/.codex}/skills/. Without names: every skill here.
# An installed copy is replaced only with --force; the old copy moves to <root>/backups/skills/.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TARGET=agents FORCE=false NAMES=()
while [ $# -gt 0 ]; do
  case $1 in
    --target) TARGET=${2:?--target needs a value}; shift 2 ;;
    --force) FORCE=true; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    -*) echo "install.sh: unknown option $1" >&2; exit 2 ;;
    *) NAMES+=("$1"); shift ;;
  esac
done
case $TARGET in
  agents) ROOT=$HOME/.agents ;;
  claude) ROOT=$HOME/.claude ;;
  codex) ROOT=${CODEX_HOME:-$HOME/.codex} ;;
  *) echo "install.sh: --target must be agents, claude or codex" >&2; exit 2 ;;
esac
if [ ${#NAMES[@]} -eq 0 ]; then
  for d in "$HERE"/*/; do if [ -f "$d/SKILL.md" ]; then NAMES+=("$(basename "$d")"); fi; done
fi
[ ${#NAMES[@]} -gt 0 ] || { echo "install.sh: no skills in $HERE" >&2; exit 1; }
mkdir -p "$ROOT/skills"
for name in "${NAMES[@]}"; do
  src=$HERE/$name dst=$ROOT/skills/$name
  [ -f "$src/SKILL.md" ] || { echo "install.sh: no skill $name in $HERE" >&2; exit 1; }
  if [ -e "$dst" ]; then
    if ! $FORCE; then echo "skip $name: $dst exists (--force replaces it)"; continue; fi
    mkdir -p "$ROOT/backups/skills"
    mv "$dst" "$ROOT/backups/skills/$name-$(date +%Y%m%d-%H%M%S)"
  fi
  cp -R "$src" "$dst"
  echo "installed $name → $dst"
done
