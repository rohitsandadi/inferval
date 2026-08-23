"""Shared resource names and the run-dir layout. Frozen with the contracts.

Modules never import each other; they may import contracts. These constants
are the only cross-module strings, so the four packets can't drift apart.

Run directory layout on the atlas-runs Volume (mounted at /runs):

  <runs root>/<run_id>/
    spec.json                         RunSpec, frozen at submit
    events.jsonl                      append-only Event per line (the UI feed)
    blocks/b{i}_{label}_{eval}.json   BlockResult per primary bench block
    experiments/<eid>/                probe evidence (block JSONs, trace files)
    verdict.json                      Verdict
    investigation.json                Investigation
    report.json                       Report
"""

APP_NAME = "atlas"                      # the one deployed Modal app
CONTROLLER_FUNCTION = "run_controller"  # spawned per run; atlas/controller/app.py
VOLUME_CACHE = "atlas-cache"            # weights; mounted at /cache
VOLUME_RUNS = "atlas-runs"              # evidence + run state; mounted at /runs
DICT_APPROVALS = "atlas-approvals"      # f"{run_id}:{proposal_id}" -> "approved" | "denied"
DICT_SANDBOXES = "atlas-sandboxes"      # sandbox_id -> {repo, gpu, state, deadline, run}
CHAT_TURN_FUNCTION = "chat_turn"        # spawned per user message; controller/app.py
SECRET_OPENROUTER = "openrouter-secret" # holds OPENROUTER_API_KEY

WEIGHTS_PATH = "/cache/gpt2_124m.pt"

# Env vars (all optional, with these defaults)
ENV_RUNS_ROOT = "ATLAS_RUNS_ROOT"       # runs root override for local tests (default /runs)
ENV_MODEL = "ATLAS_MODEL"               # default "stealth/ox-alpha"
ENV_MODEL_BASE_URL = "ATLAS_MODEL_BASE_URL"  # default "https://openrouter.ai/api/v1"
