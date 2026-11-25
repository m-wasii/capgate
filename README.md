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
