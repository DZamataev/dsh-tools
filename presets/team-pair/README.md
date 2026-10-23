# team-pair: Team mode and Codex presets

Agent Presets for the DSH Desktop profile `desktop`, applied on top of the Agent Teams bundle (`@deepseek-ai/dsh-experimental-agent-team-profile`):

| Picker name | id | What it is |
|---|---|---|
| Team mode | `team` | Standard mode plus Agent Teams. The Lead (Claude) adds teammates by role from `pair-roles.yml`: `gpt-coder`, `gpt-reviewer` (both in Codex teammate mode) and `claude-reviewer`. |
| Codex mode | `codex` | For GPT models in an ordinary session: Standard mode tools, a Codex prompt, and `apply_patch` in Codex format instead of `edit`/`write`. |
| Codex teammate mode | `team-codex` | The same on top of Team mode, without subagents; selected by the GPT roles (`agentPreset: team-codex`), not by hand. |

Needs a DSH build with `agentPreset` on Agent Teams roles (fork branch `feat/agent-team-models`, from `0a71536e66`; preset role routes stay behind their role from `9af5727498`).

## Use

```sh
./apply.sh [home]                            # apply to a home (default ~/.dsh-dev)
ALLOW_LIVE=1 ./apply.sh ~/.dsh               # live; quit DSH first
```

Live has the presets since 2026-10-23 (build `0b7312b59d`). They live in the profile and survive deploys, so later builds go out with the ordinary `deploy.sh` of dz-dsh-rollout; rerun `apply.sh` only after changing roles, the Codex prompt, or after an upstream preset change makes it report a stale copy.

`apply.sh` adds the Agent Teams bundle and `dsh-patch-edit-plus@0.4.3` (a plain profile dependency: never enable it in Plugins, that mounts `apply_patch` for every agent) to `profiles/desktop/package.json`, installs with the app's bundled pnpm, writes both preset files between `# >>> team-pair` markers in `profiles/desktop/cordis.patch.yml`, and installs the `team-pair` skill into `<home>/skills`.

## Change

- Roles and models: edit `pair-roles.yml`, then `python3 make-pair-preset.py <SRC>/packages/experimental/agent-team-profile/cordis.patch.yml pair-roles.yml pair-preset.cordis.patch.yml`.
- Codex prompt or rows: edit `make-codex-presets.py`, then run it with `<SRC>/packages/bundle/web-app/presets/standard.patch.yml` and the bundle patch.
- `apply.sh` regenerates both files from the DSH sources in `SRC` (default `~/dev/deepseek-harness`) and refuses a stale copy, printing the command that refreshes it.

GPT routes are not listed under `models`, so a GPT teammate can only be created by role, and therefore in Codex teammate mode.

## Do not install

`@shuind/dsh-codex-harness` 0.2.21 breaks DSH startup ([shuind/dsh-codex-harness#3](https://github.com/shuind/dsh-codex-harness/issues/3)).

## Check a run

- `e2e/make-fixture.sh <dir under /tmp>`: a small repo with failing tests.
- `gui-smoke/smoke.mjs`: drives the test instance's Web UI with Playwright (env: `WORKSPACE`, `PRESET`, `LEAD_MODEL`, `PROMPT`, `OUT`; results go to `gui-smoke/out-*`, ignored by git). A workspace must be registered with its real path (`/private/tmp/...`, not `/tmp/...`).
- `e2e/inspect-codex-team.sh <sessions dir of the workspace> [minutes]`: preset, route, tools, prompt opening and failed `apply_patch` calls per session.
