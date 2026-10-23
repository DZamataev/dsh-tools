#!/usr/bin/env python3
"""Generate the operator's two Codex Agent Presets from the shipped preset lists.

- `codex` ("Codex mode"): the dsh-web-app `standard` preset for GPT models in an ordinary session.
- `team-codex` ("Codex teammate mode"): the Agent Teams bundle `team` preset for GPT teammates
  (pair roles select it with `agentPreset: team-codex`); its tool-agent-team row carries no roles,
  and the plugin manager and market rows are dropped.

Both get the same changes: a Codex persona (prefix per preset, shared working rules as suffix),
`read` without `write`/`edit`, and `apply_patch` from dsh-patch-edit-plus (audited 0.4.3 config).
dsh-patch-edit-plus must be a plain profile dependency, never a bundle (apply.sh adds it).

The source rows are copied line by line (they carry `!!js` tags), so the output stays in the
Loader's own YAML dialect. Any unexpected source layout fails loudly.

Usage: make-codex-presets.py <web-app presets/standard.patch.yml> <agent-team-profile cordis.patch.yml> <out yml>
"""
import json
import re
import sys

standard_path, bundle_path, out_path = sys.argv[1:4]

RULES = """# Codex working rules

## General
- Search text with `rg` and files with `rg --files` through the shell; fall back to `grep`/`find` only if `rg` is missing.
- Prefer dedicated tools over shell equivalents: `read` to read files, `apply_patch` to change them, `grep`/`glob` to search when they fit.
- Run independent reads and searches in parallel in one batch instead of one at a time.
- Deliver working code, not a plan. When details are missing, make reasonable assumptions within the scope you were given.

## Autonomy and persistence
- Once you have a task, gather context, implement, test and refine without waiting for more prompts.
- Carry the task through implementation, verification and a clear report in the same turn unless you are truly blocked.
- If you are re-reading or re-editing the same files without progress, stop and report what blocks you.

## Editing
- Make file changes with `apply_patch` in the Codex patch format (`*** Begin Patch` ... `*** End Patch`, with `*** Add File:`, `*** Update File:`, `@@` context and `-`/`+` lines). Batch the edits of one logical change into one patch.
- Read a file with the `read` tool before patching it: this harness refuses to change a file the session has not read through `read`, and reading it with `cat`/`sed` does not count.
- In `apply_patch` use paths relative to the working directory root; absolute paths fail for new files.
- `apply_patch` here only adds and updates files, and a multi-file patch is not atomic: a later file can fail after an earlier one was written. Delete or move files with the shell (`rm`, `git mv`), and patch one file per call when an edit is risky.
- Do not use `apply_patch` for generated output (formatters, code generators, lockfiles); run the generator instead.
- Default to ASCII; add a comment only where the code is not self-explanatory.
- The working copy may be dirty. Never revert changes you did not make, never run destructive git commands (`git reset --hard`, `git checkout --`), and do not commit unless asked.

## Reviews
- When asked to review, lead with findings ordered by severity, each with `path:line` and the evidence (command and output, or the code you read). If you find nothing, say so and list what you checked.

## Reporting
- Be concise. Lead with the outcome, then what changed and where, then the test commands and their results. Reference files as `path` or `path:line`; do not paste whole files.
"""

PRESETS = [
    {
        'source': (standard_path, 'preset-standard'),
        'row': 'preset-codex', 'id': 'codex', 'order': 6,
        'name': 'Codex mode',
        'description': 'For GPT models in an ordinary session: Standard mode tools with the Codex prompt and apply_patch in Codex format instead of edit/write. Pick a GPT model in the model picker.',
        'prefix': 'You are Codex, a coding agent based on the {{model}} model.',
        'drop': [],
        'replace': {},
    },
    {
        'source': (bundle_path, 'preset-team'),
        'row': 'preset-team-codex', 'id': 'team-codex', 'order': 90,
        'name': 'Codex teammate mode',
        'description': 'Used automatically for GPT teammates of Team mode; not meant to be picked by hand. Codex mode plus team tools, without subagents.',
        'prefix': 'You are Codex, a coding agent based on the {{model}} model, working as a teammate of a Team Lead in a shared working copy.',
        'drop': ['tool-plugin-manager', 'tool-plugin-market'],
        'replace': {'tool-agent-team': ["- id: tool-agent-team", "  name: '@deepseek-ai/dsh-experimental-tool-agent-team'"]},
    },
]

APPLY_PATCH = [
    '- id: apply-patch',
    '  name: dsh-patch-edit-plus',
    '  # Audited 0.4.3: fail loud on a name clash; Delete/Move are broken (ctx.shell without inject).',
    '  config:',
    '    toolName: apply_patch',
    '    allowCodexPatch: true',
    '    allowUnifiedDiff: true',
    '    conflictPolicy: fail',
    '    deleteBackend: none',
    '    followSymlinks: false',
]


def indent_of(line):
    return len(line) - len(line.lstrip())


def fail(message):
    sys.exit(f'make-codex-presets: {message}')


def row_lines(path, row_id):
    lines = open(path, encoding='utf-8').read().splitlines()
    starts = [i for i, l in enumerate(lines) if re.match(rf'^\s*- id: {re.escape(row_id)}\s*$', l)]
    if len(starts) != 1:
        fail(f'{path}: expected one row "{row_id}", found {len(starts)}')
    start = starts[0]
    base = indent_of(lines[start])
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if lines[j].strip() and indent_of(lines[j]) <= base:
            end = j
            break
    return lines[start:end]


def plugin_items(row):
    plugins = [i for i, l in enumerate(row) if re.match(r'^\s*plugins:\s*$', l)]
    if len(plugins) != 1:
        fail('expected one plugins: key in the source row')
    body = [l for l in row[plugins[0] + 1:]]
    while body and not body[-1].strip():
        body.pop()
    item_indent = indent_of(body[0])
    if not body[0].lstrip().startswith('- '):
        fail('plugins: is not followed by a list item')
    items = []
    for line in body:
        if line.strip() and indent_of(line) == item_indent and line.lstrip().startswith('- '):
            items.append([])
        items[-1].append(line[item_indent:] if line.strip() else '')
    return items


def item_id(item):
    match = re.match(r'^- id: (\S+)\s*$', item[0])
    if match is None:
        fail(f'list item without a leading id: {item[0]!r}')
    return match.group(1)


def persona_item(prefix):
    lines = ['- id: persona', "  name: '@deepseek-ai/dsh-persona'", '  config:', '    prefix: >-', f'      {prefix}', '    suffix: |']
    lines += [('      ' + l) if l else '' for l in RULES.rstrip('\n').split('\n')]
    return lines


def transform(items, preset):
    ids = [item_id(item) for item in items]
    for required in ['persona', 'tool-fs', *preset['replace']]:
        if ids.count(required) != 1:
            fail(f'{preset["source"][1]}: expected one "{required}" row, found {ids.count(required)}')
    out = []
    for item in items:
        rid = item_id(item)
        if rid in preset['drop']:
            continue
        if rid == 'persona':
            out.append(persona_item(preset['prefix']))
        elif rid == 'tool-fs':
            if len(item) != 2:
                fail('tool-fs row already has config; update the generator')
            out.append(item + ['  config:', '    write: false', '    edit: false'])
            out.append(APPLY_PATCH)
        elif rid in preset['replace']:
            out.append(preset['replace'][rid])
        else:
            out.append(item)
    return out


out = [
    '# Generated by dsh-tools presets/team-pair/make-codex-presets.py; do not edit by hand.',
    '# Codex mode (`codex`) from the dsh-web-app standard preset; Codex teammate mode (`team-codex`)',
    '# from the Agent Teams bundle team preset. Needs dsh-patch-edit-plus@0.4.3 as a plain profile dependency.',
    '- insert:',
]
for preset in PRESETS:
    items = transform(plugin_items(row_lines(*preset['source'])), preset)
    out += [
        f'    - id: {preset["row"]}',
        "      name: '@deepseek-ai/dsh-agent-preset'",
        '      config:',
        f'        id: {preset["id"]}',
        f'        name: {json.dumps(preset["name"])}',
        f'        description: {json.dumps(preset["description"])}',
        f'        order: {preset["order"]}',
        '        plugins:',
    ]
    for item in items:
        out += [('          ' + l) if l else '' for l in item]
open(out_path, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
print(f'wrote {out_path} ({len(out)} lines)')
