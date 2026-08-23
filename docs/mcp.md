# Connecting to the Inferval MCP server

The MCP server is hosted at `https://inferval.vercel.app/api/mcp` (streamable
HTTP). No install, no local process — point your coding agent at the URL.

Claude Code:

```bash
claude mcp add -t http inferval https://inferval.vercel.app/api/mcp
```

Cursor, Codex, or any client with JSON config:

```json
{
  "mcpServers": {
    "inferval": {
      "url": "https://inferval.vercel.app/api/mcp"
    }
  }
}
```

The tools connect a repo, define its evals, start GPU-verified reviews of a
change, and read the verdict and report; agents should call `get_started`
first for the concepts and eval format.

Tools: `get_started`, `list_repos`, `connect_repo`, `list_evals`,
`create_eval`, `submit_review`, `get_run`, `get_report`.

Source: `web/app/api/mcp/route.ts` — each tool is one HTTP call to the
deployed API.
