# dsh-tools

Denis Zamataev's tools for DeepSeek Harness (DSH).

- `skills/dz-dsh-rollout/`: roll the DSH fork out to the live Desktop (merge → verify → deploy). Install with `skills/install.sh --target agents` (DSH reads `~/.agents/skills`); `--target claude|codex` for those harnesses.
- `presets/team-pair/`: Team mode, Codex mode and Codex teammate mode Agent Presets for the Desktop profile; dz-dsh-rollout installs them on every verify and deploy (`ROLLOUT_PROFILE_SETUP`).
- `plugins/provider-limits/`: composer-dock chip with the remaining quota of TeamClaude, codex-lb and OpenCode Go routes. `plugins/install.sh` points a Desktop profile's link plugins here and connects the plugins a profile lacks (`PLUGINS_ENSURE` narrows the list); rollout runs it after each deploy.
- `plugins/device-reservations/`: composer-dock icon opening a panel of rn-looky test devices (`~/.looky` ledger) grouped by the reserving project, with live runs, connection state, and reserve / hand over / release / stop controls.
- `mcp/sudo39/`: submodule of the hardened sudo39 fork (DZamataev/sudo39, branch `main`): an MCP server that runs allowlisted root-owned programs as root after the user approves a native macOS dialog naming the command; the policy is read-only and comes from the `mcp-sudo39` entry in `$DSH_HOME/cordis.patch.yml`. Build: `cargo build --release --locked`, install to `~/.local/bin/sudo39`.

Design: `docs/specs/2026-10-21-dz-dsh-rollout-design.md`.
