"""Independent validation agent — built on microsoft/agent-framework
(agent-framework-core + agent-framework-openai, Python), driven by the same
Azure OpenAI deployment the Trade Assistant uses.

Purpose: cross-examine the claims made during the 2026-07-04 work session
against the LIVE system (running dev server, real SQLite DB, actual replay
script) and emit a PASS/FAIL verdict per claim with quoted evidence. The
agent chooses which tools to call; every tool is read-only.

Run:  .venv/Scripts/python.exe scripts/validate_agent.py
Requires: dev server on :5001, data/project-r.db, .env.local Azure creds.
"""

import asyncio
import json
import sqlite3
import subprocess
import sys
import urllib.request
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent


def load_env() -> dict:
    env = {}
    for line in (ROOT / ".env.local").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


# ── Tools (plain callables — agent-framework wraps them as function tools) ──

def http_get(path: str) -> str:
    """GET an API path on the local simulator dev server (http://localhost:5001).
    `path` must start with /api/. Returns the response body (truncated)."""
    if not path.startswith("/api/"):
        return "REFUSED: only /api/ paths are allowed."
    try:
        with urllib.request.urlopen(f"http://localhost:5001{path}", timeout=30) as r:
            body = r.read().decode("utf-8")
            return body[:6000] + ("\n…TRUNCATED" if len(body) > 6000 else "")
    except Exception as e:  # noqa: BLE001 — the agent needs the failure text
        return f"HTTP ERROR: {e}"


def sql_query(query: str) -> str:
    """Run a read-only SELECT against the simulator SQLite DB (data/project-r.db).
    Only SELECT statements are allowed. Returns up to 20 rows as JSON lines."""
    if not query.lstrip().upper().startswith("SELECT"):
        return "REFUSED: only SELECT queries are allowed."
    try:
        conn = sqlite3.connect(f"file:{ROOT / 'data' / 'project-r.db'}?mode=ro", uri=True)
        cur = conn.execute(query)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchmany(20)
        conn.close()
        return "\n".join(json.dumps(dict(zip(cols, r)), default=str) for r in rows) or "(0 rows)"
    except Exception as e:  # noqa: BLE001
        return f"SQL ERROR: {e}"


def run_replay(date: str = "2026-07-03") -> str:
    """Execute the point-in-time replay benchmark (scripts/replay-window.ts)
    for the given date and return the tail of its output."""
    try:
        out = subprocess.run(
            f"npx tsx scripts/replay-window.ts {date}",
            shell=True, cwd=ROOT, capture_output=True, text=True, timeout=180, encoding="utf-8", errors="replace",
        )
        # From the START — the 'shipped' variant prints first; tailing hid it.
        return (out.stdout + out.stderr)[:6000]
    except Exception as e:  # noqa: BLE001
        return f"REPLAY ERROR: {e}"


_ALLOWED_FILES = {"lib/trade-suggest/config.ts", "tracking/autoresearch-log.jsonl", "tracking/ml-roadmap.md"}


def read_project_file(relpath: str) -> str:
    """Read one of the allowed project files (first 8000 chars). Allowed:
    lib/trade-suggest/config.ts, tracking/autoresearch-log.jsonl,
    tracking/ml-roadmap.md. For big files, prefer grep_file to find specific
    text — this read may truncate."""
    if relpath not in _ALLOWED_FILES:
        return f"REFUSED: only {sorted(_ALLOWED_FILES)} are readable."
    p = ROOT / relpath
    if not p.exists():
        return f"MISSING: {relpath} does not exist."
    text = p.read_text(encoding="utf-8", errors="replace")
    return text[:8000] + ("\n…TRUNCATED — use grep_file for targeted checks" if len(text) > 8000 else "")


def grep_file(relpath: str, pattern: str) -> str:
    """Return every line of an allowed project file containing `pattern`
    (plain substring, case-sensitive), prefixed with its line number. Use this
    instead of read_project_file when checking whether specific text exists —
    it never truncates away a match."""
    if relpath not in _ALLOWED_FILES:
        return f"REFUSED: only {sorted(_ALLOWED_FILES)} are readable."
    p = ROOT / relpath
    if not p.exists():
        return f"MISSING: {relpath} does not exist."
    hits = [
        f"{i}: {line[:400]}"
        for i, line in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1)
        if pattern in line
    ]
    return "\n".join(hits[:30]) or f"(no lines contain {pattern!r})"


CLAIMS = """Verify each claim with tools. For every claim output exactly:
CLAIM <n>: PASS or FAIL — <the exact observed value(s) you used as evidence>

1. GET /api/bhavcopy reports latest synced session 2026-07-02 and a boolean `stale` field.
2. The trade_suggestions table contains exactly 3 rows, all dated 2026-07-03: DMART PE, MUTHOOTFIN CE, POLICYBZR PE — each with non-null outcome columns (maxUpPct, maxDownPct, closePct).
3. Data coverage gap: fyers_candles has rows for exactly 1 distinct date (2026-07-03) while oi_intraday has rows for 9 distinct dates.
4. GET /api/trade-suggest currently reports the suggestion window inactive and the market closed.
5. GET /api/trade-suggest?view=leaderboard returns a leaderboard for session 2026-07-02 with a universe greater than 100 names.
6. The replay benchmark for 2026-07-03 (run_replay) shows the 'shipped' variant producing 2 picks: DMART PE hitting TARGET and POLICYBZR PE hitting SL, net ΣR +1.00.
7. tracking/autoresearch-log.jsonl exists and contains a baseline record plus experiment records with accepted true/false fields.
8. lib/trade-suggest/config.ts sets EXCLUDE_EXTENDED = true and MIN_RFACTOR = 3.6.

After the 8 verdicts, output one line: SUMMARY: <passCount>/8 PASS."""


async def main() -> None:
    env = load_env()
    from agent_framework import Agent
    from agent_framework.openai import OpenAIChatClient

    client = OpenAIChatClient(
        model=env["AZURE_OPENAI_CHAT_DEPLOYMENT"],
        api_key=env["AZURE_OPENAI_API_KEY"],
        azure_endpoint=f"https://{env['AZURE_OPENAI_INSTANCE_NAME']}.openai.azure.com",
        # agent-framework's client targets Azure's next-gen v1 surface, which
        # takes 'preview'/'latest' instead of the classic dated api-version.
        api_version="preview",
    )
    agent = Agent(
        client=client,
        name="validation-agent",
        instructions=(
            "You are an independent verification agent for a trading simulator. "
            "You NEVER assume — every verdict must come from a tool observation made in this run. "
            "If a tool errors, retry once, then mark the claim FAIL with the error as evidence."
        ),
        tools=[http_get, sql_query, run_replay, read_project_file, grep_file],
    )
    print(f"agent-framework validation agent · model={env['AZURE_OPENAI_CHAT_DEPLOYMENT']} · 5 read-only tools\n")
    resp = await agent.run(CLAIMS)
    print(resp.text if hasattr(resp, "text") else str(resp))


if __name__ == "__main__":
    asyncio.run(main())
