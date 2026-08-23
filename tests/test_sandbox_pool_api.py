"""Sandboxes router tests: hooks monkeypatched, no Modal, no network."""
import datetime

import pytest
from fastapi.testclient import TestClient

from atlas.api import api, sandboxes


def iso_ago(seconds: int) -> str:
    t = (datetime.datetime.now(datetime.timezone.utc)
         - datetime.timedelta(seconds=seconds))
    return t.isoformat(timespec="seconds")


@pytest.fixture
def entries():
    return {
        "sb-1": {"repo": "https://github.com/karpathy/nanoGPT", "gpu": "A10G",
                 "state": "cooldown", "deadline": 1756000000,
                 "attached": {"run": "r_1"}, "created_at": iso_ago(120)},
        "sb-2": {"repo": "acme/whisper-stream", "gpu": "H100",
                 "state": "running", "deadline": None,
                 "attached": {"session": "s_9"}, "created_at": iso_ago(30)},
        "sb-3": {"repo": "https://github.com/karpathy/nanoGPT.git",
                 "gpu": "A10G", "state": "terminated", "deadline": 1755000000,
                 "attached": None, "created_at": iso_ago(4000)},
    }


@pytest.fixture
def client(entries, monkeypatch):
    calls = []
    monkeypatch.setattr(sandboxes, "pool_entries", lambda: entries)

    def control(sid, action):
        calls.append((sid, action))
        e = dict(entries[sid])
        if action == "stop":
            e["state"] = "terminated"
        else:
            e["deadline"] = (e.get("deadline") or 0) + 600
        entries[sid] = e
        return e

    monkeypatch.setattr(sandboxes, "sandbox_control", control)
    c = TestClient(api.web_app)  # proves api.py auto-mounted the router
    c.calls = calls
    return c


def test_list_shape_and_repo_filter(client):
    rows = client.get("/api/repos/karpathy/nanoGPT/sandboxes").json()
    assert [r["id"] for r in rows] == ["sb-1", "sb-3"]  # .git stripped; newest first
    r = rows[0]
    assert set(r) == {"id", "gpu", "state", "created_at", "deadline",
                      "attached", "uptime_s"}
    assert r["gpu"] == "A10G" and r["state"] == "cooldown"
    assert r["deadline"] == 1756000000
    assert r["attached"] == {"run": "r_1"}
    assert 118 <= r["uptime_s"] <= 125
    assert rows[1]["uptime_s"] is None  # terminated: no live uptime
    # suffix match, like api.py: bare repo name also resolves
    assert len(client.get("/api/repos/nanoGPT/sandboxes").json()) == 2


def test_list_includes_session_entries_unchanged(client):
    rows = client.get("/api/repos/acme/whisper-stream/sandboxes").json()
    assert len(rows) == 1
    assert rows[0]["attached"] == {"session": "s_9"}
    assert rows[0]["state"] == "running" and rows[0]["deadline"] is None


def test_list_no_match_is_empty(client):
    assert client.get("/api/repos/unknown/repo/sandboxes").json() == []


def test_stop_calls_hook(client):
    r = client.post("/api/sandboxes/sb-1", json={"action": "stop"})
    assert r.status_code == 200
    assert client.calls == [("sb-1", "stop")]
    body = r.json()
    assert body["ok"] is True and body["action"] == "stop"
    assert body["sandbox"]["state"] == "terminated"


def test_extend_calls_hook(client):
    r = client.post("/api/sandboxes/sb-1", json={"action": "extend"})
    assert r.status_code == 200
    assert client.calls == [("sb-1", "extend")]
    assert r.json()["sandbox"]["deadline"] == 1756000000 + 600


def test_unknown_sandbox_404(client):
    r = client.post("/api/sandboxes/sb-nope", json={"action": "stop"})
    assert r.status_code == 404
    assert client.calls == []  # hook untouched


def test_bad_action_422(client):
    r = client.post("/api/sandboxes/sb-1", json={"action": "reboot"})
    assert r.status_code == 422
    r = client.post("/api/sandboxes/sb-1", json={})
    assert r.status_code == 422
    assert client.calls == []
