"""The ONE deployed Modal app: controller function + mounted API.

Deploy from atlas_v1/ (repo files must resolve at deploy time):
  .venv/bin/modal deploy atlas/controller/app.py
"""
import os

import modal

from atlas.contracts.names import (APP_NAME, CHAT_TURN_FUNCTION,
                                   CONTROLLER_FUNCTION, SECRET_OPENROUTER)
from atlas.runner.volumes import cache_volume, runs_volume

# atlas_v1/ locally; /root inside the container.
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

app = modal.App(APP_NAME)
cache = cache_volume()
runs = runs_volume()
openrouter = modal.Secret.from_name(SECRET_OPENROUTER)

# github-oauth is optional until Rohit registers the OAuth app; attach it
# only when it exists so deploys never fail on the missing secret.
API_SECRETS = [openrouter]
try:
    _gh = modal.Secret.from_name("github-oauth")
    _gh.hydrate()
    API_SECRETS.append(_gh)
except Exception:
    pass

# demo/ rides along so the controller can hydrate the GPU sandbox image
# (harness_image(ROOT)) from inside its own container.
CONTROLLER_IMAGE = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi==0.141.1", "pyyaml==6.0.3", "httpx==0.28.1",
                 "openai==3.3.1",
                 "openai-agents==0.22.0")
    .env({"ATLAS_ON_MODAL": "1",  # api.py: reload the runs Volume on reads
          "ATLAS_FRONTEND_URL": "https://inferval.vercel.app"})
    .add_local_python_source("atlas")  # .py files only —
    .add_local_file(f"{ROOT}/atlas/api/repos.json",  # data rides separately
                    "/root/atlas/api/repos.json")
    .add_local_dir(f"{ROOT}/demo", "/root/demo")
)


@app.function(name=CONTROLLER_FUNCTION, image=CONTROLLER_IMAGE,
              volumes={"/runs": runs, "/cache": cache},
              secrets=[openrouter], timeout=3600)
def run_controller(spec: dict) -> dict:
    from atlas.controller.controller import run
    return run(spec, volume=runs)


@app.function(name=CHAT_TURN_FUNCTION, image=CONTROLLER_IMAGE,
              volumes={"/runs": runs, "/cache": cache},
              secrets=[openrouter], timeout=900)
def chat_turn(chat_id: str, text: str, directive: bool = False) -> dict:
    try:  # a warm container's mount is stale; the session was just written
        runs.reload()
    except Exception:
        pass
    try:  # session module lands in parallel; a broken import must not crash
        from atlas.session.loop import run_turn
    except Exception as e:
        return {"chat": chat_id, "ok": False,
                "error": f"session module unavailable: {e}"}
    try:
        return run_turn(chat_id, "/runs", text, volume=runs, directive=directive)
    except Exception as e:  # never die invisibly: leave an error event behind
        try:
            from atlas.referee.events import append_event
            append_event("/runs/chats", chat_id, "system", "error",
                         {"error": f"turn crashed: {e}"[:2000]})
            runs.commit()
        except Exception:
            pass
        return {"chat": chat_id, "ok": False, "error": str(e)[:500]}


@app.function(image=CONTROLLER_IMAGE,
              volumes={"/runs": runs, "/cache": cache},
              secrets=API_SECRETS)
@modal.asgi_app()
def api():
    try:
        from atlas.api.api import web_app
        return web_app
    except Exception:  # api module lands in parallel; deploy must survive
        from fastapi import FastAPI
        stub = FastAPI()
        stub.get("/api/health")(lambda: {"ok": True, "api": "placeholder"})
        return stub
