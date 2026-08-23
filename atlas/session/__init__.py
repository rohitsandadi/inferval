"""The repo-agent session: a conversation attached to a change (PR/branch),
stored and served exactly like a run (chats/<chat_id>/events.jsonl, same
Event contract). See v2/AGENT_WORKSPACE.md.
"""
from atlas.session.loop import run_turn  # noqa: F401
