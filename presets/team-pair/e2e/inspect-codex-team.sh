#!/usr/bin/env bash
# Per-session evidence for a mixed Agent Teams run with a `team-codex` teammate:
# preset (header + agent-preset/selected), LLM route, key tools present in the request,
# system-prompt opening, tool-call counts, and failed apply_patch results.
#
# Usage: inspect-codex-team.sh <sessions dir of the workspace> [minutes, default 90]
# Read-only. Requires zstd and python3.
set -euo pipefail
DIR="${1:?usage: inspect-codex-team.sh <sessions dir> [minutes]}"
MIN="${2:-90}"
exec python3 - "$DIR" "$MIN" <<'PY'
import json, os, subprocess, sys, time
from collections import Counter

root, minutes = sys.argv[1], float(sys.argv[2])
KEY = ['apply_patch', 'read', 'edit', 'write', 'bash', 'grep', 'glob', 'exec_command',
       'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'subagent', 'todo_write']

def events(path):
    raw = subprocess.run(['zstd', '-dc', path], check=True, capture_output=True).stdout.decode('utf-8', 'replace')
    return [json.loads(l) for l in raw.splitlines() if l.strip()]

def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return ' '.join(b.get('text', '') for b in content if isinstance(b, dict))
    return ''

for name in sorted(os.listdir(root), key=lambda n: os.path.getmtime(os.path.join(root, n))):
    path = os.path.join(root, name, 'session.v4.jsonl.zstd')
    if not os.path.exists(path) or time.time() - os.path.getmtime(path) > minutes * 60:
        continue
    ev = events(path)
    header = ev[0]
    selected = [e['data'] for e in ev if e.get('type') == 'agent-preset/selected']
    req = [e['data']['header'] for e in ev if e.get('type') == 'request/header']
    if not req:
        continue
    tools = [t.get('name') for t in (req[-1].get('tools') or []) if isinstance(t, dict)]
    system = next((text_of(e['data'].get('message', {}).get('content')) for e in ev if e.get('type') == 'system/message'), '')
    calls = Counter(e['data'].get('name') for e in ev if e.get('type') == 'tool/call')
    failed_patch = []
    call_names = {e['data'].get('callId'): e['data'].get('name') for e in ev if e.get('type') == 'tool/call'}
    for e in ev:
        if e.get('type') == 'tool/result':
            m = e['data'].get('message', {})
            if call_names.get(m.get('toolCallId')) == 'apply_patch' and m.get('isError'):
                failed_patch.append(text_of(m.get('content'))[:160])
    cfg = req[-1].get('config', {})
    print(f"== {name}")
    print(f"   parent={header.get('parentSession', '-')} headerPreset={header.get('agentPreset')} selected={[s.get('agentPreset', s) for s in selected]}")
    print(f"   route={cfg.get('provider')}/{cfg.get('model')} effort={cfg.get('reasoningEffort', '-')} tools={len(tools)}")
    print(f"   key tools present: {[k for k in KEY if k in tools]}")
    print(f"   system prompt: {system[:110]!r}")
    print(f"   tool calls: {dict(calls.most_common(12))}")
    if failed_patch:
        print(f"   failed apply_patch ({len(failed_patch)}): {failed_patch[:3]}")
PY
