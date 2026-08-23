"""Turn context for the session agent: a compact factual brief, hard-capped.

Reads meta.json, pr.diff, triage.json, drafts.json and events.jsonl under
chats/<chat_id>/ and renders: the session header, the PR, the diff (capped),
the declared eval suite, triage state, drafts, sandbox state, and a compact
tail of the prior conversation.
"""
import json
import os

DIFF_CAP = 8192
BODY_CAP = 2000
TAIL_EVENTS = 15
TEXT_CAP = 220          # per event line in the tail
CAP_BYTES = 24000
TRUNCATION_MARK = "\n...[context truncated]"


def chat_dir(runs_root: str, chat_id: str) -> str:
    return os.path.join(runs_root, "chats", chat_id)


def _read_json(path: str):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return None


def _read_text(path: str) -> str:
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        return ""


def _event_line(e: dict) -> str:
    kind = e.get("kind", "?")
    tier = e.get("tier", "?")
    detail = e.get("detail", {})
    if kind in ("user_message", "agent_message", "thinking"):
        body = str(detail.get("text", ""))
    else:
        body = json.dumps(detail, separators=(",", ":"))
    if len(body) > TEXT_CAP:
        body = body[:TEXT_CAP] + "..."
    return f"- [{tier}/{kind}] {body}"


def _annotation_line(a: dict) -> str:
    cov = a.get("coverage")
    cov_s = "GAP" if cov == "gap" else ", ".join(cov or [])
    return (f"- {a.get('id')} {a.get('path')}:{a.get('start_line')}-"
            f"{a.get('end_line')} [{a.get('risk')}] {a.get('note')} "
            f"(coverage: {cov_s})")


def build_context(runs_root: str, chat_id: str, repo: dict,
                  sandbox_line: str = "none", cap_bytes: int = CAP_BYTES) -> str:
    d = chat_dir(runs_root, chat_id)
    meta = _read_json(os.path.join(d, "meta.json")) or {}
    pr = meta.get("pr")

    lines = [f"# Session {chat_id} — repo {meta.get('repo', repo.get('name', '?'))}"]
    if meta.get("branch"):
        lines.append(f"branch: {meta['branch']}")

    if pr:
        lines += ["", f"## PR #{pr.get('number')}: {pr.get('title') or '(no title)'}",
                  f"url: {pr.get('url')}  base {str(pr.get('base'))[:10]} -> "
                  f"head {str(pr.get('head'))[:10]}"]
        if pr.get("body"):
            lines.append(str(pr["body"])[:BODY_CAP])

    diff = _read_text(os.path.join(d, "pr.diff"))
    lines += ["", "## Diff"]
    if diff:
        lines.append(diff[:DIFF_CAP] +
                     ("\n...[diff truncated]" if len(diff) > DIFF_CAP else ""))
    else:
        lines.append("(no diff attached)")

    lines += ["", f"## Declared eval suite (gpu default: {repo.get('gpu', '?')})"]
    suite = repo.get("evals", [])
    if suite:
        lines += [f"- {e['name']}: `{e['cmd']}` checks {e.get('checks', {})}"
                  for e in suite]
    else:
        lines.append("(none declared)")
    if repo.get("overrides"):
        lines.append(f"declared overrides: {repo['overrides']}")
    if suite:
        lines.append(f"run_eval work trees (must exist in the sandbox BEFORE "
                     f"run_eval; prepare with exec): "
                     f"/work/chats/{chat_id}/base and /work/chats/{chat_id}/head")

    triage = _read_json(os.path.join(d, "triage.json"))
    lines += ["", "## Triage"]
    if triage:
        lines += [_annotation_line(a) for a in triage]
    else:
        lines.append("(not yet done)")

    drafts = _read_json(os.path.join(d, "drafts.json")) or []
    if drafts:
        lines += ["", "## Eval drafts"]
        lines += [f"- {dr.get('id')} {dr.get('name')} (origin {dr.get('origin')}, "
                  f"{dr.get('status')}, ~{dr.get('est_gpu_seconds')}s GPU)"
                  for dr in drafts]

    lines += ["", f"## Sandbox: {sandbox_line}"]

    events = []
    try:
        with open(os.path.join(d, "events.jsonl")) as f:
            for line in f:
                try:
                    events.append(json.loads(line))
                except ValueError:
                    continue
    except FileNotFoundError:
        pass
    if events:
        lines += ["", f"## Conversation tail (last {min(len(events), TAIL_EVENTS)} events)"]
        lines += [_event_line(e) for e in events[-TAIL_EVENTS:]]

    text = "\n".join(lines)
    if len(text.encode()) > cap_bytes:
        keep = cap_bytes - len(TRUNCATION_MARK.encode())
        text = text.encode()[:keep].decode(errors="ignore") + TRUNCATION_MARK
    return text
