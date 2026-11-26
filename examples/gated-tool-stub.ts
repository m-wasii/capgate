/**
 * Reference: gate a non-demo MCP tool with Capgate.
 * Not imported by npm start — copy `registerExampleGatedTools` into your server entry.
 *
 * Policy must list each tool name (see ../policy.example.yaml → shell_exec).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerGatedTool } from "../src/gate.js";

export function registerExampleGatedTools(server: McpServer): void {
  registerGatedTool(
    server,
    "shell_exec",
    "Run a shell command (stub). Spend risk; needs approval when risk is spend.",
    { command: z.string().describe("Shell command to run (stub only)") },
    ({ command }) =>
      JSON.stringify({
        ok: true,
        stub: true,
        message: "Replace this handler with your real shell integration.",
        command,
      }),
  );
}