"""M3 — the Tier-2 investigator. Only the controller imports this."""
from atlas.investigator.loop import InvestigatorFailed, investigate, plan

__all__ = ["InvestigatorFailed", "investigate", "plan"]
