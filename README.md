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