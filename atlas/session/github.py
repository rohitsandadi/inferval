"""PR fetch from the public GitHub REST API. No auth, httpx, bounded.

httpx is imported lazily: it rides along with the openai dependency in every
environment we run in, but tests that mock this module never touch it.
"""
import json
import os

API = "https://api.github.com"
TIMEOUT_S = 10.0
BODY_CAP = 4000        # PR body chars kept
DIFF_CAP = 65536       # raw diff bytes cached; context caps further


def fetch_pr(repo_name: str, number: int, cache_dir: str | None = None) -> dict:
    """PR meta + unified diff for a public repo.

    Returns {number, title, url, body, head, base, head_ref, base_ref, diff}
    with head/base as full SHAs. When cache_dir is given, writes pr.json
    (meta) and pr.diff (diff text) into it.
    """
    import httpx  # lazy — see module docstring
    url = f"{API}/repos/{repo_name}/pulls/{number}"
    headers = {"User-Agent": "atlas-session",
               "Accept": "application/vnd.github+json"}
    with httpx.Client(timeout=TIMEOUT_S, follow_redirects=True) as client:
        r = client.get(url, headers=headers)
        r.raise_for_status()
        pr = r.json()
        rd = client.get(url, headers={"User-Agent": "atlas-session",
                                      "Accept": "application/vnd.github.v3.diff"})
        rd.raise_for_status()
        diff = rd.text
    if len(diff) > DIFF_CAP:
        diff = diff[:DIFF_CAP] + "\n...[diff truncated]"

    out = {"number": pr.get("number", number),
           "title": pr.get("title") or "",
           "url": pr.get("html_url") or f"https://github.com/{repo_name}/pull/{number}",
           "body": (pr.get("body") or "")[:BODY_CAP],
           "head": (pr.get("head") or {}).get("sha"),
           "base": (pr.get("base") or {}).get("sha"),
           "head_ref": (pr.get("head") or {}).get("ref"),
           "base_ref": (pr.get("base") or {}).get("ref"),
           "diff": diff}
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
        meta = {k: v for k, v in out.items() if k != "diff"}
        with open(os.path.join(cache_dir, "pr.json"), "w") as f:
            json.dump(meta, f)
        with open(os.path.join(cache_dir, "pr.diff"), "w") as f:
            f.write(diff)
    return out
