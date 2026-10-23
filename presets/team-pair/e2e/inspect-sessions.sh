#!/usr/bin/env bash
# List the sessions under $DSH_HOME/sessions and print per-session evidence:
#   - header facts (parentSession, origin, cwd) and the subagent descriptor route
#   - LLM routes actually requested: `request/header` events carry
#     data.header.config {provider, model, reasoningEffort, ...}; `request/context`
#     carries the resolved route metadata (provider, model, contextWindow)
#   - assistant message count and token usage
#   - tool calls (spawn_teammate arguments are shown)
#   - occurrences of `Team message from <name>:` in user/message and
#     agent/inbox/spliced events (messages that reached this session's model)
# and a final PASS/FAIL table for the e2e acceptance checks.
#
# Usage: inspect-sessions.sh [DSH_HOME]      (default $DSH_HOME)
# Read-only. Session logs are zstd-compressed JSONL (session.v4.jsonl.zstd).
set -euo pipefail

HOME_DIR="${1:-${DSH_HOME:-}}"
if [ -z "$HOME_DIR" ] || [ ! -d "$HOME_DIR/sessions" ]; then
  echo "usage: inspect-sessions.sh <DSH_HOME>   (no $HOME_DIR/sessions)" >&2; exit 2
fi
command -v zstd >/dev/null || { echo "inspect-sessions: zstd not found" >&2; exit 2; }

exec python3 - "$HOME_DIR" <<'PY'
import json, os, re, subprocess, sys
from collections import Counter, OrderedDict

home = sys.argv[1]
MARK = re.compile(r"Team message from ([a-z][a-z0-9-]*):")

def read_events(path):
    if path.endswith(".zstd"):
        raw = subprocess.run(["zstd", "-dc", path], check=True, capture_output=True).stdout.decode("utf-8", "replace")
    else:
        raw = open(path, encoding="utf-8", errors="replace").read()
    events = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            events.append({"type": "<unparsable>", "raw": line[:200]})
    return events

def texts(value):
    """Yield every text block string in a UserMessage-ish structure."""
    if isinstance(value, dict):
        if value.get("type") == "text" and isinstance(value.get("text"), str):
            yield value["text"]
        for child in value.values():
            yield from texts(child)
    elif isinstance(value, list):
        for child in value:
            yield from texts(child)

paths = []
for root, _dirs, files in os.walk(os.path.join(home, "sessions")):
    for name in files:
        if re.fullmatch(r"session(\.v\d+)?\.jsonl(\.zstd)?", name):
            paths.append(os.path.join(root, name))
paths.sort(key=os.path.getmtime)
if not paths:
    print("no session logs found under", os.path.join(home, "sessions"))
    sys.exit(1)

summaries = []
for path in paths:
    events = read_events(path)
    head = next((e for e in events if e.get("type") == "session"), {})
    sid = head.get("id") or os.path.basename(os.path.dirname(path))
    routes = OrderedDict()
    for e in events:
        t = e.get("type")
        if t == "request/header":
            cfg = (e.get("data", {}).get("header") or {}).get("config") or {}
            key = (cfg.get("provider"), cfg.get("model"), str(cfg.get("reasoningEffort")))
            routes.setdefault(("request/header",) + key, []).append(e.get("seq"))
        elif t == "request/context":
            d = e.get("data", {})
            key = (d.get("provider"), d.get("model"), "ctx=%s" % d.get("contextWindow"))
            routes.setdefault(("request/context",) + key, []).append(e.get("seq"))
    descriptor = next((e.get("data") for e in events if e.get("type") == "subagent/descriptor"), None)
    usage_in = usage_out = messages = 0
    tools = Counter()
    spawns = []
    marks = Counter()          # (sender, event type) -> count
    snippets = []
    for e in events:
        t = e.get("type")
        d = e.get("data", {})
        if t == "assistant/message":
            messages += 1
            u = d.get("usage") or {}
            usage_in += u.get("inputTokens", 0) or 0
            usage_out += u.get("outputTokens", 0) or 0
        elif t == "tool/call":
            tools[d.get("name")] += 1
            if d.get("name") == "spawn_teammate":
                try:
                    a = json.loads(d.get("arguments") or "{}")
                    spawns.append({k: a.get(k) for k in ("name", "role", "provider", "model", "reasoning_effort", "context") if k in a})
                except json.JSONDecodeError:
                    spawns.append({"unparsable": (d.get("arguments") or "")[:120]})
        if t in ("user/message", "agent/inbox/spliced"):
            for text in texts(d):
                for m in MARK.finditer(text):
                    marks[(m.group(1), t)] += 1
                    snippets.append((m.group(1), e.get("seq"), text[m.end():m.end() + 160].replace("\n", " ").strip()))
    summaries.append({
        "path": path, "id": sid, "head": head, "descriptor": descriptor, "routes": routes,
        "messages": messages, "in": usage_in, "out": usage_out, "tools": tools, "spawns": spawns,
        "marks": marks, "snippets": snippets, "events": len(events),
    })

print("== sessions under %s (oldest first) ==" % os.path.join(home, "sessions"))
for s in summaries:
    h = s["head"]
    print("\n-- %s" % s["id"])
    print("   file:    %s (%d events)" % (os.path.relpath(s["path"], home), s["events"]))
    print("   parent=%s origin=%s cwd=%s" % (h.get("parentSession"), h.get("origin"), h.get("cwd")))
    if s["descriptor"]:
        d = s["descriptor"]
        print("   subagent descriptor: mode=%s provider=%s label=%r agentProvider=%s agentModel=%s" % (
            d.get("mode"), d.get("provider"), d.get("label"), d.get("agentProvider"), d.get("agentModel")))
    for (source, provider, model, extra), seqs in s["routes"].items():
        print("   %-15s %s / %s  %s  (x%d, first seq %s)" % (source, provider, model, extra, len(seqs), seqs[0]))
    print("   assistant messages=%d tokens in=%d out=%d" % (s["messages"], s["in"], s["out"]))
    print("   tool calls: %s" % (dict(s["tools"]) or "none"))
    for spawn in s["spawns"]:
        print("   spawn_teammate args: %s" % json.dumps(spawn))
    for (sender, etype), n in sorted(s["marks"].items()):
        print("   'Team message from %s:' x%d in %s" % (sender, n, etype))
    seen = set()
    for sender, seq, snippet in s["snippets"]:
        if (sender, seq) in seen:
            continue
        seen.add((sender, seq))
        print("     seq %s from %s: %s" % (seq, sender, snippet))

def routes_of(s):
    return {(src, p, m) for (src, p, m, _x) in s["routes"]}

def is_child(s):
    return s["head"].get("parentSession") is not None
lead = [s for s in summaries if not is_child(s)]
kids = [s for s in summaries if is_child(s)]
checks = [
    ("Lead session requested anthropic/claude-sonnet-5-5",
     any(("request/header", "anthropic", "claude-sonnet-5-5") in routes_of(s) for s in lead)),
    ("a teammate session requested codex-lb/gpt-6.1-sol (request/header)",
     any(("request/header", "codex-lb", "gpt-6.1-sol") in routes_of(s) for s in kids)),
    ("that teammate's resolved route metadata is codex-lb/gpt-6.1-sol (request/context)",
     any(("request/context", "codex-lb", "gpt-6.1-sol") in routes_of(s) for s in kids)),
    ("Lead session received 'Team message from gpt-reviewer:'",
     any(sender == "gpt-reviewer" for s in lead for (sender, _t) in s["marks"])),
    ("a teammate session received 'Team message from lead:'",
     any(sender == "lead" for s in kids for (sender, _t) in s["marks"])),
    ("Lead called spawn_teammate with role gpt-reviewer",
     any(sp.get("role") == "gpt-reviewer" for s in lead for sp in s["spawns"])),
]
print("\n== acceptance checks ==")
for label, ok in checks:
    print("  [%s] %s" % ("PASS" if ok else "FAIL", label))
sys.exit(0 if all(ok for _l, ok in checks) else 1)
PY
