# Capgate (OSS)

Agent spend + approval gate as an MCP server. Apache-2.0.

Hosted control plane lives in the private sibling repo `capgate-cloud`.

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

```bash
set CAPGATE_API_URL=http://localhost:3000
set CAPGATE_API_KEY=dev-key
npm start
```

## Cursor MCP config

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
