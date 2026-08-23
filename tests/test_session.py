"""Session tests: storage/meta creation, route parity, the spawn hook, triage
validation, tool ceilings, and turn-loop survival. No network, no Modal —
GitHub fetch, sandbox, model call and review POST are all mocked."""
import json
import os
import pathlib
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from atlas.api import api, sessions
from atlas.referee.events import append_event
from atlas.session import loop as sloop
from atlas.session import tools as stools
from atlas.session.loop import AnnotationOut, TriageOut, validate_triage
from atlas.session.tools import SessionContext

REPO = "rohitsandadi/nanoGPT"

FAKE_PR = {"number": 1, "title": "Optimize generation",
           "url": f"https://github.com/{REPO}/pull/1",
           "body": "~2x faster generation", "head": "9c2b11d0aa",
           "base": "3adf61e1bb", "head_ref": "opt-sampling",
           "base_ref": "atlas-base",
           "diff": ("--- a/model.py\n+++ b/model.py\n"
                    "@@ -322,8 +322,13 @@\n+probs_host = probs.to('cpu')\n")}


def fake_fetch(repo, number, cache_dir):
    meta = {k: v for k, v in FAKE_PR.items() if k != "diff"}
    (pathlib.Path(cache_dir) / "pr.json").write_text(json.dumps(meta))
    (pathlib.Path(cache_dir) / "pr.diff").write_text(FAKE_PR["diff"])
    return dict(FAKE_PR)


@pytest.fixture
def runs_root(tmp_path, monkeypatch):
    root = tmp_path / "runs"
    monkeypatch.setenv("ATLAS_RUNS_ROOT", str(root))
    return root


@pytest.fixture
def client(runs_root):
    return TestClient(api.web_app)


@pytest.fixture
def chat_id(client, monkeypatch):
    monkeypatch.setattr(sessions, "fetch_pr", fake_fetch)
    r = client.post(f"/api/repos/{REPO}/sessions", json={"pr": 1})
    assert r.status_code == 200
    return r.json()["session"]


def read_events(runs_root, chat_id):
    p = runs_root / "chats" / chat_id / "events.jsonl"
    if not p.exists():
        return []
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]


# --- session creation / storage ---------------------------------------------

def test_create_session_pr_meta(client, monkeypatch, runs_root):
    monkeypatch.setattr(sessions, "fetch_pr", fake_fetch)
    r = client.post(f"/api/repos/{REPO}/sessions", json={"pr": 1})
    assert r.status_code == 200
    cid = r.json()["session"]
    assert cid.startswith("c_") and len(cid) == 10
    meta = json.loads((runs_root / "chats" / cid / "meta.json").read_text())
    assert set(meta) == {"session", "repo", "pr", "branch", "created_at", "status"}
    assert meta["repo"] == REPO and meta["status"] == "created"
    assert set(meta["pr"]) == {"number", "title", "url", "body", "head", "base"}
    assert meta["branch"] == "opt-sampling"
    assert (runs_root / "chats" / cid / "pr.diff").exists()


def test_create_session_unknown_repo(client):
    assert client.post("/api/repos/nope/xyz/sessions",
                       json={"pr": 1}).status_code == 404


def test_create_session_branch_only(client, runs_root):
    r = client.post(f"/api/repos/{REPO}/sessions", json={"branch": "fix-sampling"})
    assert r.status_code == 200
    meta = json.loads((runs_root / "chats" / r.json()["session"] /
                       "meta.json").read_text())
    assert meta["pr"] is None and meta["branch"] == "fix-sampling"


def test_create_session_pr_fallback_to_repos_json(client, monkeypatch, runs_root):
    def boom(repo, number, cache_dir):
        raise OSError("offline")
    monkeypatch.setattr(sessions, "fetch_pr", boom)
    r = client.post(f"/api/repos/{REPO}/sessions", json={"pr": 1})
    assert r.status_code == 200
    meta = json.loads((runs_root / "chats" / r.json()["session"] /
                       "meta.json").read_text())
    assert meta["pr"]["number"] == 1
    assert "host-side sampling" in meta["pr"]["title"]
    assert meta["branch"] == "opt-sampling"
    assert meta["pr"]["head"] == "6bf2e6f0"


# --- messages route / spawn hook --------------------------------------------

def test_post_message_spawns_turn(client, monkeypatch, chat_id):
    calls = []
    monkeypatch.setattr(sessions, "spawn_turn",
                        lambda cid, text: calls.append((cid, text)))
    r = client.post(f"/api/sessions/{chat_id}/messages", json={"text": "hi"})
    assert r.status_code == 200 and r.json() == {"turn": 1}
    assert calls == [(chat_id, "hi")]


def test_post_message_turn_number_advances(client, monkeypatch, chat_id, runs_root):
    monkeypatch.setattr(sessions, "spawn_turn", lambda cid, text: None)
    append_event(str(runs_root / "chats"), chat_id, "human", "user_message",
                 {"text": "hi", "turn": 1})
    append_event(str(runs_root / "chats"), chat_id, "system", "turn_done",
                 {"turn": 1, "ok": True})
    r = client.post(f"/api/sessions/{chat_id}/messages", json={"text": "again"})
    assert r.json() == {"turn": 2}


def test_post_message_validation(client, monkeypatch, chat_id):
    assert client.post("/api/sessions/c_missing0/messages",
                       json={"text": "x"}).status_code == 404
    assert client.post(f"/api/sessions/{chat_id}/messages",
                       json={"text": "  "}).status_code == 422

    def boom(cid, text):
        raise RuntimeError("no modal")
    monkeypatch.setattr(sessions, "spawn_turn", boom)
    assert client.post(f"/api/sessions/{chat_id}/messages",
                       json={"text": "x"}).status_code == 502


# --- events route parity ----------------------------------------------------

def test_events_route_cursor_semantics(client, chat_id, runs_root):
    croot = str(runs_root / "chats")
    for i in range(3):
        append_event(croot, chat_id, "agent", "thinking", {"text": f"t{i}"})
    # partially-written trailing line must not be served
    with open(runs_root / "chats" / chat_id / "events.jsonl", "a") as f:
        f.write('{"t": "2026-08-23T14:0')

    r = client.get(f"/api/sessions/{chat_id}/events")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/x-ndjson")
    lines = r.text.splitlines()
    assert len(lines) == 3
    assert json.loads(lines[0])["detail"]["text"] == "t0"

    r2 = client.get(f"/api/sessions/{chat_id}/events?since=2")
    assert len(r2.text.splitlines()) == 1
    assert json.loads(r2.text)["detail"]["text"] == "t2"
    assert client.get(f"/api/sessions/{chat_id}/events?since=99").text == ""
    assert client.get("/api/sessions/c_missing0/events").status_code == 404


# --- session detail ---------------------------------------------------------

def test_session_detail(client, chat_id, runs_root):
    r = client.get(f"/api/sessions/{chat_id}")
    body = r.json()
    assert body["session"] == chat_id and body["repo"] == REPO
    assert body["triage"] is None and body["drafts"] == []
    assert body["status"] == "created"

    d = runs_root / "chats" / chat_id
    ann = [{"id": "a1", "path": "model.py", "start_line": 322, "end_line": 335,
            "risk": "perf", "note": "host sync", "coverage": ["generate_short"]}]
    (d / "triage.json").write_text(json.dumps(ann))
    (d / "drafts.json").write_text(json.dumps(
        [{"id": "d1", "origin": "a1", "name": "sample_step", "cmd": "x",
          "checks": {}, "est_gpu_seconds": 20, "status": "proposed"}]))
    body = client.get(f"/api/sessions/{chat_id}").json()
    assert body["triage"] == ann and body["drafts"][0]["id"] == "d1"


# --- triage validation ------------------------------------------------------

def _ann(**kw):
    base = dict(id="x", path="model.py", start_line=1, end_line=2,
                risk="perf", note="n", coverage=["generate_short"])
    base.update(kw)
    return AnnotationOut(**base)


def test_validate_triage_coverage_and_ids():
    out = TriageOut(summary="s", annotations=[
        _ann(coverage=["generate_short", "made_up"]),
        _ann(coverage=["made_up"]),
        _ann(coverage="gap"),
        _ann(coverage="generate_long"),      # bare known name
        _ann(risk="weird", coverage=[]),
    ])
    anns = validate_triage(out, ["generate_short", "generate_long"])
    assert [a["id"] for a in anns] == ["a1", "a2", "a3", "a4", "a5"]
    assert anns[0]["coverage"] == ["generate_short"]   # unknown dropped
    assert anns[1]["coverage"] == "gap"                # all-unknown -> gap
    assert anns[2]["coverage"] == "gap"
    assert anns[3]["coverage"] == ["generate_long"]
    assert anns[4]["coverage"] == "gap" and anns[4]["risk"] == "none"
    assert set(anns[0]) == {"id", "path", "start_line", "end_line",
                            "risk", "note", "coverage"}


# --- tool ceilings / ledger -------------------------------------------------

NANO = {"name": REPO, "gpu": "A10G", "overrides": ["batch"],
        "evals": [{"name": "generate_short",
                   "cmd": "python /harness/bench.py --src {src} --eval "
                          "generate_short --tokens 128 --batch 2 --repeats 5 "
                          "--out {out}",
                   "checks": {"tokens_per_s": "-10%"}}]}


class FakeSandbox:
    def __init__(self, rc=0, out="ok", err=""):
        self.rc, self.out, self.err = rc, out, err

    def exec(self, *args, **kw):
        return SimpleNamespace(
            stdout=SimpleNamespace(read=lambda: self.out),
            stderr=SimpleNamespace(read=lambda: self.err),
            wait=lambda: None, returncode=self.rc)


@pytest.fixture
def ctx(runs_root):
    cid = "c_toolctx1"
    (runs_root / "chats" / cid).mkdir(parents=True)
    return SessionContext(chat_id=cid, runs_root=str(runs_root),
                          repo=dict(NANO), meta={"pr": None, "branch": None},
                          sandbox_factory=lambda c, k, g: (FakeSandbox(), "sb-fake1"),
                          sandbox_release=lambda sb, sid: None)


def kinds(runs_root, cid):
    return [e["kind"] for e in read_events(runs_root, cid)]


def test_env_decision_and_sandbox_ceiling(ctx, runs_root):
    assert "invalid kind" in stools.decide_environment(ctx, "H100", "why not")
    assert "decide_environment first" in stools.create_sandbox(ctx)
    assert "cpu" in stools.decide_environment(ctx, "cpu", "unit check")
    assert "live" in stools.create_sandbox(ctx)
    assert "already live" in stools.create_sandbox(ctx)  # max 1 per session
    ks = kinds(runs_root, ctx.chat_id)
    assert ks == ["env_decision", "sandbox_created"]
    ev = read_events(runs_root, ctx.chat_id)[0]
    assert ev["detail"]["est_cost"] == "~$0.01/run"


def test_env_none_creates_nothing(ctx, runs_root):
    stools.decide_environment(ctx, "none", "diff answers it")
    assert "'none'" in stools.create_sandbox(ctx)
    assert kinds(runs_root, ctx.chat_id) == ["env_decision"]


def test_gpu_sandbox_denied_via_approvals(ctx, runs_root):
    ctx.approvals = "manual"
    ctx.approval_lookup = lambda key: "denied"
    ctx.approval_timeout_s, ctx.poll_interval_s = 0.5, 0.01
    stools.decide_environment(ctx, "A10G", "gpu question")
    assert "not created (denied)" in stools.create_sandbox(ctx)
    assert ctx.sandbox is None
    ks = kinds(runs_root, ctx.chat_id)
    assert "sandbox_proposed" in ks and "sandbox_denied" in ks


def test_exec_requires_sandbox_then_emits(ctx, runs_root):
    assert "no live sandbox" in stools.exec_cmd(ctx, "echo hi")
    stools.decide_environment(ctx, "cpu", "r")
    stools.create_sandbox(ctx)
    out = stools.exec_cmd(ctx, "echo hi")
    assert out.startswith("exit 0")
    ev = read_events(runs_root, ctx.chat_id)[-1]
    assert ev["kind"] == "sandbox_exec"
    assert ev["detail"] == {"cmd": "echo hi", "exit": 0, "tail": "ok"}


def test_run_eval_ledger_and_result(ctx, runs_root):
    assert "unknown eval" in stools.run_eval(ctx, "bogus")
    assert "not allowed" in stools.run_eval(ctx, "generate_short",
                                            {"secret_knob": 1})
    ctx.gpu_seconds_budget = 10.0  # est for the declared cmd is ~56s
    assert "budget exhausted" in stools.run_eval(ctx, "generate_short")
    assert ctx.gpu_seconds_used == 0

    ctx.gpu_seconds_budget = 120.0
    blocks = [{"status": "completed", "label": "base", "block": 0,
               "samples": {"tokens_per_s": [400.0]}},
              {"status": "completed", "label": "head", "block": 1,
               "samples": {"tokens_per_s": [300.0]}}]
    ctx.eval_runner = lambda c, spec, ov, subdir: list(blocks)
    out = stools.run_eval(ctx, "generate_short")
    assert "experiment x1" in out and "-25.0%" in out
    assert ctx.gpu_seconds_used > 0 and ctx.evals_run == 1
    ev = read_events(runs_root, ctx.chat_id)[-1]
    assert ev["kind"] == "test_result"
    assert "delta tokens_per_s" in ev["detail"]["headline"]
    assert (runs_root / "chats" / ctx.chat_id / "experiments" / "x1" /
            "b0_base.json").exists()
    # second run within budget would exceed it now (2 * ~56s > 120 - no; 112 < 120)
    # so drain the ledger explicitly and confirm rejection
    ctx.gpu_seconds_used = 119.0
    assert "budget exhausted" in stools.run_eval(ctx, "generate_short")


def test_submit_review_once_per_turn(ctx, runs_root):
    posted = []
    ctx.post_run = lambda payload: posted.append(payload) or "r_new00001"
    out = stools.submit_review(ctx, "3adf61e1", "9c2b11d0")
    assert "r_new00001" in out
    assert posted[0]["repo"] == REPO and posted[0]["mode"] == "compare"
    assert "one formal review per turn" in stools.submit_review(
        ctx, "3adf61e1", "9c2b11d0")
    ev = read_events(runs_root, ctx.chat_id)[-1]
    assert ev["kind"] == "review_submitted" and ev["detail"]["run"] == "r_new00001"


def test_submit_review_failure_not_counted(ctx):
    def boom(payload):
        raise RuntimeError("api down")
    ctx.post_run = boom
    assert "failed" in stools.submit_review(ctx, "a", "b")
    assert ctx.reviews_submitted == 0


def test_draft_eval_validation_and_event(ctx, runs_root):
    d = runs_root / "chats" / ctx.chat_id
    (d / "triage.json").write_text(json.dumps(
        [{"id": "a1", "path": "model.py", "start_line": 1, "end_line": 2,
          "risk": "perf", "note": "n", "coverage": "gap"}]))
    assert "unknown origin" in stools.draft_eval(
        ctx, "a9", "sample_step", "cmd", {}, 20)
    assert "already exists in the suite" in stools.draft_eval(
        ctx, "a1", "generate_short", "cmd", {}, 20)
    out = stools.draft_eval(ctx, "a1", "sample_step",
                            "python bench.py --eval sample_step",
                            {"latency_ms_p95": "+15%"}, 20)
    assert "d1" in out
    drafts = json.loads((d / "drafts.json").read_text())
    assert drafts[0] == {"id": "d1", "origin": "a1", "name": "sample_step",
                         "cmd": "python bench.py --eval sample_step",
                         "checks": {"latency_ms_p95": "+15%"},
                         "est_gpu_seconds": 20, "status": "proposed"}
    assert "already exists" in stools.draft_eval(ctx, "a1", "sample_step",
                                                 "cmd", {}, 20)
    assert kinds(runs_root, ctx.chat_id)[-1] == "eval_draft"


def test_release_sandbox_cooldown_event(ctx, runs_root):
    released = []
    ctx.sandbox_release = lambda sb, sid: released.append(sid)
    stools.decide_environment(ctx, "cpu", "r")
    stools.create_sandbox(ctx)
    stools.release_sandbox(ctx)
    assert released == ["sb-fake1"] and ctx.sandbox is None
    ev = read_events(runs_root, ctx.chat_id)[-1]
    assert ev["kind"] == "sandbox_released"
    assert ev["detail"]["state"] == "cooldown"
    stools.release_sandbox(ctx)  # idempotent: no sandbox, no event
    assert kinds(runs_root, ctx.chat_id).count("sandbox_released") == 1


# --- the turn loop ----------------------------------------------------------

TRIAGE_OUT = TriageOut(summary="host-side sampling risk", annotations=[
    _ann(coverage=["generate_short", "invented_eval"]),
    _ann(path="model.py", start_line=330, end_line=335, coverage=["nope"])])


def fake_run_agent(reply="Looked at it."):
    calls = []

    def fake(agent, task, max_turns):
        calls.append(agent.name)
        if agent.name == "atlas-triage":
            return SimpleNamespace(final_output=TRIAGE_OUT)
        return SimpleNamespace(final_output=reply)
    return fake, calls


def test_run_turn_triage_then_reply(client, monkeypatch, chat_id, runs_root):
    fake, calls = fake_run_agent()
    monkeypatch.setattr(sloop, "_run_agent", fake)
    monkeypatch.setattr(sloop, "_model", lambda: None)
    res = sloop.run_turn(chat_id, str(runs_root), "what changed?")
    assert res == {"chat": chat_id, "turn": 1, "ok": True}
    assert calls == ["atlas-triage", "atlas-session"]
    ks = kinds(runs_root, chat_id)
    assert ks == ["user_message", "triage", "agent_message", "turn_done"]
    tri = json.loads((runs_root / "chats" / chat_id / "triage.json").read_text())
    assert tri[0]["coverage"] == ["generate_short"]
    assert tri[1]["coverage"] == "gap"
    meta = json.loads((runs_root / "chats" / chat_id / "meta.json").read_text())
    assert meta["status"] == "active"
    ev = read_events(runs_root, chat_id)
    assert ev[-2]["detail"]["text"] == "Looked at it."
    assert ev[-1]["detail"] == {"turn": 1, "ok": True}


def test_run_turn_second_turn_skips_triage(client, monkeypatch, chat_id, runs_root):
    fake, calls = fake_run_agent()
    monkeypatch.setattr(sloop, "_run_agent", fake)
    monkeypatch.setattr(sloop, "_model", lambda: None)
    sloop.run_turn(chat_id, str(runs_root), "first")
    res = sloop.run_turn(chat_id, str(runs_root), "second")
    assert res["turn"] == 2
    assert calls == ["atlas-triage", "atlas-session", "atlas-session"]


def test_run_turn_error_survives(client, monkeypatch, chat_id, runs_root):
    def boom(agent, task, max_turns):
        raise RuntimeError("model down")
    monkeypatch.setattr(sloop, "_run_agent", boom)
    monkeypatch.setattr(sloop, "_model", lambda: None)
    res = sloop.run_turn(chat_id, str(runs_root), "hello")
    assert res["ok"] is False
    ks = kinds(runs_root, chat_id)
    # triage fails first (non-fatal error event), then the main loop fails
    assert ks[0] == "user_message" and ks[-1] == "turn_done"
    errors = [e for e in read_events(runs_root, chat_id) if e["kind"] == "error"]
    assert errors and "model down" in errors[-1]["detail"]["error"]
    last = read_events(runs_root, chat_id)[-1]
    assert last["detail"]["ok"] is False


def test_run_turn_unknown_session_raises(runs_root):
    with pytest.raises(ValueError):
        sloop.run_turn("c_nope0000", str(runs_root), "hi")


def test_run_turn_releases_sandbox(client, monkeypatch, chat_id, runs_root):
    captured = {}
    orig = sloop.make_tools

    def spy(ctx):
        captured["ctx"] = ctx
        return orig(ctx)
    monkeypatch.setattr(sloop, "make_tools", spy)
    monkeypatch.setattr(sloop, "_model", lambda: None)

    def fake(agent, task, max_turns):
        if agent.name == "atlas-triage":
            return SimpleNamespace(final_output=TRIAGE_OUT)
        c = captured["ctx"]
        stools.decide_environment(c, "cpu", "cheap check")
        stools.create_sandbox(c)
        stools.exec_cmd(c, "echo hi")
        return SimpleNamespace(final_output="ran a check")
    monkeypatch.setattr(sloop, "_run_agent", fake)

    released = []
    res = sloop.run_turn(chat_id, str(runs_root), "check it",
                         sandbox_factory=lambda c, k, g: (FakeSandbox(), "sb-x"),
                         sandbox_release=lambda sb, sid: released.append(sid))
    assert res["ok"] is True and released == ["sb-x"]
    ks = kinds(runs_root, chat_id)
    assert ks == ["user_message", "triage", "env_decision", "sandbox_created",
                  "sandbox_exec", "agent_message", "sandbox_released",
                  "turn_done"]


def test_list_sessions_and_diff(client, chat_id, runs_root):
    rows = client.get(f"/api/repos/{REPO}/sessions").json()
    assert [r["session"] for r in rows] == [chat_id]
    row = rows[0]
    assert set(row) == {"session", "pr", "branch", "created_at", "status"}
    assert row["pr"] == {"number": 1, "title": "Optimize generation",
                         "url": f"https://github.com/{REPO}/pull/1"}
    assert client.get("/api/repos/ghost/repo/sessions").json() == []
    # fake_fetch cached pr.diff at attach time -> served as text/plain
    r = client.get(f"/api/sessions/{chat_id}/diff")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")
    assert r.text.startswith("--- a/model.py")
    # a session without a cached diff 404s
    (runs_root / "chats" / "c_nodiff00").mkdir(parents=True)
    (runs_root / "chats" / "c_nodiff00" / "meta.json").write_text("{}")
    assert client.get("/api/sessions/c_nodiff00/diff").status_code == 404
