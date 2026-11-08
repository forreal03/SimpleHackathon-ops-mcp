// Calls one tool on the built server over stdio (a real MCP client) and prints the result.
//
//   node scripts/call.mjs <tool> [json-args | @file.json] [--gh-token]
//
// --gh-token uses the GitHub CLI's login (`gh auth token`) as GITHUB_TOKEN for this run only.
// That is token mode, meant for trying things out; use the GitHub App for a real event.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
const useGh = args.includes("--gh-token");
const [tool, rawArgs = "{}"] = args.filter((a) => a !== "--gh-token");
if (!tool) {
  console.error("usage: node scripts/call.mjs <tool> [json-args | @file.json] [--gh-token]");
  process.exit(2);
}
const toolArgs = JSON.parse(rawArgs.startsWith("@") ? readFileSync(rawArgs.slice(1), "utf8") : rawArgs);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env, HACKATHON_OPS_HOME: process.env.HACKATHON_OPS_HOME ?? root };
if (useGh) env.GITHUB_TOKEN = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();

const client = new Client({ name: "hackathon-ops-call", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "index.js")], env, stderr: "inherit" }));
try {
  const res = await client.callTool({ name: tool, arguments: toolArgs });
  for (const c of res.content) console.log(c.type === "text" ? c.text : c);
  if (res.isError) process.exitCode = 1;
} finally {
  await client.close();
}
