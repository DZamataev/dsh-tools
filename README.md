# dsh-tools

Denis Zamataev's tools for DeepSeek Harness (DSH).

- `skills/dz-dsh-rollout/`: roll the DSH fork out to the live Desktop (merge → verify → deploy). Install with `skills/install.sh --target agents` (DSH reads `~/.agents/skills`); `--target claude|codex` for those harnesses.
- `presets/team-pair/`: Team mode, Codex mode and Codex teammate mode Agent Presets for the Desktop profile; `deploy-live.sh` applies them and deploys the verified build in one run.
- `plugins/provider-limits/`: composer-dock chip with the remaining quota of TeamClaude, codex-lb and OpenCode Go routes. `plugins/install.sh` points a Desktop profile's link plugins here; rollout runs it after each deploy.

Design: `docs/specs/2026-10-21-dz-dsh-rollout-design.md`.
