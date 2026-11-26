# Capgate (OSS)

Agent spend + approval gate as an MCP server. Apache-2.0.

Hosted control plane lives in the private sibling repo `capgate-cloud`.

## Quickstart

**[docs/mvp-quickstart.md](docs/mvp-quickstart.md)** — clone → Railway control plane (or local YAML) → Cursor MCP → first gated call.

## Install

```bash
npm install
npm run self-check
npm start
```

## Modes

**Local** (YAML policy, no cloud):

```bash
set CAPGATE_POLICY=./policy.example.yaml
set CAPGATE_LOCAL_APPROVE=1
npm start
```

**Cloud** (approvals + meter on control plane):

Local control plane:

```bash
set CAPGATE_API_URL=http://localhost:3000
set CAPGATE_API_KEY=dev-key
npm start
```

Hosted control plane: set `CAPGATE_API_URL` to your deployed `capgate-cloud` HTTPS origin and `CAPGATE_API_KEY` to an active Bearer key. Step-by-step: [mvp-quickstart.md](docs/mvp-quickstart.md) (hosted path). **Deploy on Railway:** see the `capgate-cloud` repository README (*Deploy on Railway*)—not duplicated here.

```bash
set CAPGATE_API_URL=https://capgate.up.railway.app
set CAPGATE_API_KEY=<your-bearer-key>
npm start
```

### MCP environment (trust)

| Variable | Role |
| --- | --- |
| `CAPGATE_API_URL` | Hosted control plane origin (`https://…`). When set, all spend/approval decisions come from that deployment. |
| `CAPGATE_API_KEY` | `Authorization: Bearer` secret (`cg_…` from the dashboard). **One deployment, one shared meter and policy** — see trust notes below. |
| `CAPGATE_POLICY` | Local YAML path when **`CAPGATE_API_URL` is unset** (Path B in [mvp-quickstart](docs/mvp-quickstart.md)). |
| `CAPGATE_LOCAL_APPROVE` | **`1` only for local dev:** auto-runs `needs_approval` tools against YAML policy with **no** operator approval. Emits a **stderr** warning on MCP start. **Never set** on hosted/production MCP (use dashboard approvals instead). Ignored when `CAPGATE_API_URL` is set. |

#### Who can use a `cg_…` key? (hosted path)

A Bearer API key is **not** a separate tenant or sandbox. Every **active** `cg_…` key on one control-plane deployment can:

- Read the same policy and daily spend meter
- Call any registered tool the policy allows (subject to cap, kill switch, and approvals)
- Create approvals that an operator must clear on the **shared** dashboard

There is **no** per-key spend cap or policy partition in the MVP. Treat each key like **root access to that deployment’s agent budget**.

**If a key leaks:** revoke it in the dashboard, rotate MCP env to a new key, and assume the attacker could have spent up to the daily cap or queued high-risk work. Do **not** give a `cg_…` key to a third party you would not trust with your control plane. One org → one Railway service → one volume; run a second deployment if you need isolation.

Full operator threat model: **`capgate-cloud`** [docs/threat-model-mvp.md](https://github.com/m-wasii/capgate-cloud/blob/master/docs/threat-model-mvp.md) (private repo).

#### Local YAML path (no `cg_` key)

Without `CAPGATE_API_URL`, policy and meter files on disk define the gate. Anyone who can edit those files or run the MCP process with your env can bypass caps. Use only on a trusted machine; do not point untrusted users at the same policy file.

## Cursor MCP config

Local:

```json
{
  "mcpServers": {
    "capgate": {
      "command": "node",
      "args": ["C:/Users/Murta/Projects/capgate/dist/index.js"],
      "env": {
        "CAPGATE_API_URL": "http://localhost:3000",
        "CAPGATE_API_KEY": "dev-key"
      }
    }
  }
}
```

Hosted: same shape as above; env details in [mvp-quickstart.md](docs/mvp-quickstart.md). Restart the MCP server in Cursor after changing env.

## Gate your own MCP tools

Demos (`capgate_demo_*`) ship with `npm start` for teaching only. **`capgate_dogfood_ping`** is a non-demo stub on the default MCP server for hosted dogfood (see [mvp-quickstart.md](docs/mvp-quickstart.md)). For your own tools, use [`registerGatedTool`](./src/gate.ts) and add matching names under `tools:` in policy (local YAML or cloud). Unregistered names are blocked with `unknown_tool`.

Copy-paste pattern: **[examples/gated-tool-stub.ts](examples/gated-tool-stub.ts)** (`shell_exec` is registered in [policy.example.yaml](policy.example.yaml)).

## Cloud execution order

On the hosted path, [`gatedRun`](./src/gate.ts) calls **`POST /api/v1/authorize`** (kill switch + cap + charge), runs your tool, then **`settle`** on success or **`release`** to refund the meter when the tool throws. [`cloudDecide`](./src/client.ts) is still available when a caller only needs a decision preview.

**Crash windows** (no generic idempotency for arbitrary downstream tools):

- Crash **after authorize, before** your tool runs → budget is charged; the side effect did not run.
- Crash **after** your tool runs, **before settle** → budget stays charged; the side effect may have completed.

`POST /api/v1/commit` remains for legacy integrations; the bundled MCP server uses authorize → run → settle/release.