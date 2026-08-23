# Inferval MCP server

Connects your coding agent (Claude Code, Codex, …) to Inferval: it learns
the platform via `get_started`, defines your repo's evals with
`create_eval`, starts reviews, and reads verdicts. Runs locally over stdio;
every tool is one HTTP call to the deployed API.

Add to Claude Code:

```bash
claude mcp add inferval -- /path/to/inferval/.venv/bin/python /path/to/inferval/mcp_server/server.py
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "inferval": {
      "command": "/path/to/inferval/.venv/bin/python",
      "args": ["/path/to/inferval/mcp_server/server.py"],
      "env": { "INFERVAL_API": "https://atlas-verification--atlas-api.modal.run" }
    }
  }
}
```

Tools: `get_started`, `list_repos`, `connect_repo`, `list_evals`,
`create_eval`, `submit_review`, `get_run`, `get_report`.
