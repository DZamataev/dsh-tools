# team-pair: Team mode and Codex presets

Agent Presets for the DSH Desktop profile `desktop`, on top of the Agent Teams bundle (`@deepseek-ai/dsh-experimental-agent-team-profile`):

| Picker name | id | What it is |
|---|---|---|
| Team mode | `team` | Standard mode plus Agent Teams. The Lead adds teammates by role: by default `gpt-coder`, `gpt-reviewer` (both in Codex teammate mode) and `claude-reviewer`. |
| Codex mode | `codex` | For GPT models in an ordinary session: Standard mode tools, a Codex prompt, and `apply_patch` in Codex format instead of `edit`/`write`. |
| Codex teammate mode | `team-codex` | The same on top of Team mode, without subagents; selected by roles with `agentPreset: team-codex`, not by hand. |

## Requirements

- A DSH fork that contains branch `feat/agent-team-models` (Agent Teams roles with `agentPreset`; a preset role's route stays behind its role). `apply.sh` refuses a checkout without it.
- dz-dsh-rollout (`skills/dz-dsh-rollout` in this repository) for verify and deploy, or a manual `apply.sh` run.

## Install

With dz-dsh-rollout this is automatic: `ROLLOUT_PROFILE_SETUP` (template default) runs `apply.sh` on the test home in every `verify.sh` and on the live home in every `deploy.sh`, with DSH closed and the presets generated from the fork checkout at the built sha.

By hand, with the home's DSH closed:

```sh
./apply.sh [home]                 # default ~/.dsh-dev
ALLOW_LIVE=1 ./apply.sh ~/.dsh    # live
```

`apply.sh` adds the Agent Teams bundle and `dsh-patch-edit-plus@0.4.3` to `profiles/desktop/package.json` and installs them with the app's bundled pnpm, generates both preset files (`make-pair-preset.py`, `make-codex-presets.py`) and writes them between `# >>> team-pair` markers in `profiles/desktop/cordis.patch.yml`, and installs the `team-pair` skill into `<home>/skills`. It is idempotent; a run that fails before the profile edits changes nothing.

`dsh-patch-edit-plus` stays a plain profile dependency: never enable it in Plugins or install it with `dsh plugin install`, which mounts `apply_patch` for every agent.

## Roles and models

Roles live in `~/.config/dz-dsh-rollout/team-roles.yml` when that file exists, else in `pair-roles.yml` here (the author's TeamClaude `anthropic` and `codex-lb` routes). For your own setup, copy `pair-roles.yml` there and set each role's `provider` (a key under `llm-pi-ai` `providers` in your profile), `model`, and optional `reasoningEffort`, `instructions` and `agentPreset`. Keep GPT routes out of `models`, so a GPT teammate can only be created by a role and therefore in Codex teammate mode. The next verify or deploy applies the change; `TEAM_PAIR_ROLES` points `apply.sh` at another file.

The Codex prompt and the rows of both Codex presets are in `make-codex-presets.py`.

## Do not install

`@shuind/dsh-codex-harness` 0.2.21 breaks DSH startup ([shuind/dsh-codex-harness#3](https://github.com/shuind/dsh-codex-harness/issues/3)).

## Check a run

- `e2e/make-fixture.sh <dir under /tmp>`: a small repo with failing tests.
- `gui-smoke/smoke.mjs`: drives the test instance's Web UI with Playwright (env: `WORKSPACE`, `PRESET`, `LEAD_MODEL`, `PROMPT`, `OUT`; results go to `gui-smoke/out-*`, ignored by git). A workspace must be registered with its real path (`/private/tmp/...`, not `/tmp/...`).
- `e2e/inspect-codex-team.sh <sessions dir of the workspace> [minutes]`: preset, route, tools, prompt opening and failed `apply_patch` calls per session.
