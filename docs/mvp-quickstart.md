# MVP quickstart (zero → gated MCP call)

Get from a fresh clone to a **gated tool call** in Cursor—either against a **hosted control plane** (Railway) or **fully local** YAML policy.

| Piece | Repo / role |
| --- | --- |
| MCP server (this repo) | Gates tool calls; talks to cloud or local policy |
| Control plane (`capgate-cloud`, private) | Caps, kill switch, approvals, audit (hosted path only) |

Demo tools in `policy.example.yaml` match the cloud seed policy (`capgate_demo_search` @ $0.01, `capgate_demo_refund` @ $0.05 spend/approval). The MCP server also registers **`capgate_dogfood_ping`** (non-demo); add it in the cloud dashboard before calling it on Path A.

---

## 0. Clone and build (both paths)

```bash
git clone <your-capgate-oss-remote> capgate
cd capgate
npm install
npm run self-check
```

`self-check` exercises policy + gating with `policy.example.yaml`. Keep the absolute path to `dist/index.js` for Cursor (below).

---

## Path A — Hosted (control plane on Railway)

### 1. Deploy or use a control plane

**Run your own:** use the private **`capgate-cloud`** repo. Railway deploy, volumes, and env vars are documented there under **Deploy on Railway**—do not duplicate that guide here. Ongoing releases: connect GitHub on `master` with **Wait for CI** (see **GitHub auto-deploy** and **Auto deploy unavailable** in that README).

**Dogfood instance (if you have a Bearer key):** `https://capgate.up.railway.app` (health: `GET /api/health`).

You need one **active API key** (`Authorization: Bearer …`)—from the dashboard **API keys**, or the one-time seed from `CAPGATE_DEV_KEY` on a fresh volume.

### 2. Cursor MCP (stdio → cloud)

**Cursor Settings → MCP** (or `.cursor/mcp.json`), adjust paths and secrets:

```json
{
  "mcpServers": {
    "capgate": {
      "command": "node",
      "args": ["C:/path/to/capgate/dist/index.js"],
      "env": {
        "CAPGATE_API_URL": "https://capgate.up.railway.app",
        "CAPGATE_API_KEY": "<your-bearer-key>"
      }
    }
  }
}
```

Omit `CAPGATE_API_URL` only for the local path (Path B). Restart the MCP server after env changes.

### 3. First gated calls

In a Cursor chat with **capgate** tools enabled:

1. **`capgate_status`** — confirms kill switch, daily cap ($5 default), and spend so far from the control plane.
2. **`capgate_demo_search`** — low risk; should **allow** and charge **$0.01** against the daily meter.
3. **`capgate_demo_refund`** — spend risk; should **block** with `needs_approval` until you approve in the **capgate-cloud dashboard** (then the MCP polls and completes the call).
4. **`capgate_dogfood_ping`** — non-demo stub (registered in OSS `src/index.ts`). In the dashboard **Tool policies**, add `capgate_dogfood_ping` with risk **low** and cost **0.005** USD, then call it from Cursor with an optional `message`. It should **allow** without approval and charge against the daily meter.

If a tool name is not in policy, Capgate returns **`unknown_tool`**—that is intentional.

---

## Path B — Local only (YAML, no cloud)

No Railway required. Policy and meter live on disk next to this repo.

### 1. Run MCP with local policy

```bash
set CAPGATE_POLICY=./policy.example.yaml
set CAPGATE_LOCAL_APPROVE=1
npm start
```

`CAPGATE_LOCAL_APPROVE=1` auto-approves local `needs_approval` tools (demo refund) so you can feel the gate without a dashboard.

### 2. Cursor MCP (no `CAPGATE_API_URL`)

```json
{
  "mcpServers": {
    "capgate": {
      "command": "node",
      "args": ["C:/path/to/capgate/dist/index.js"],
      "env": {
        "CAPGATE_POLICY": "C:/path/to/capgate/policy.example.yaml",
        "CAPGATE_LOCAL_APPROVE": "1"
      }
    }
  }
}
```

Optional: set `CAPGATE_METER` to a writable file (default `.capgate/meter.json` under the repo).

### 3. First gated calls

Same tool sequence as Path A:

1. **`capgate_status`** — prints local policy + meter JSON.
2. **`capgate_demo_search`** — allows; meter increases by $0.01.
3. **`capgate_demo_refund`** — would need approval in cloud; locally it runs when `CAPGATE_LOCAL_APPROVE=1` and adds $0.05.

---

## Gate your own tools next

`capgate_demo_*` tools are teaching stubs. Register real MCP tools with `registerGatedTool` and add matching entries under `tools:` in policy (local YAML or cloud dashboard). See [examples/gated-tool-stub.ts](../examples/gated-tool-stub.ts) and [README](../README.md#gate-your-own-mcp-tools).

Contributor workflow (worktrees, Linear, PR titles): [parallel-agents.md](./parallel-agents.md).