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

Demos (`capgate_demo_*`) are examples. Wrap real tools with `registerGatedTool` so spend and approval apply. Names not listed under `tools:` in policy are blocked with `unknown_tool`.

```ts
import { z } from "zod";
import { registerGatedTool } from "./gate.js";

// policy.example.yaml (or cloud policy) must include this name:
//   shell_exec:
//     risk: spend
//     costUsd: 0.02

registerGatedTool(
  server,
  "shell_exec",
  "Run a shell command (stub). High-risk; needs approval.",
  { command: z.string() },
  ({ command }) => JSON.stringify({ ok: true, stub: true, command }),
);
```