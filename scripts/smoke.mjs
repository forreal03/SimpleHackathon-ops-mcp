// Starts the built server over stdio, lists its tools and runs the offline ones against a temp folder.
// Usage: npm run build && node scripts/smoke.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(path.join(tmpdir(), "hackathon-ops-smoke-"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "index.js")],
  env: { ...process.env, HACKATHON_OPS_HOME: home, GITHUB_TOKEN: "", GITHUB_APP_ID: "" },
  stderr: "pipe",
});
const client = new Client({ name: "smoke", version: "0.0.0" });

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  return { isError: !!res.isError, text: res.content[0]?.text ?? "" };
};

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(", "));

  const init = await call("event_init", { event_id: "smoke-test", org: "some-org" });
  console.log("event_init:", init.isError ? "ERROR " + init.text : `${JSON.parse(init.text).status}, valid=${JSON.parse(init.text).valid}`);

  // Fill the placeholder sheet link the way an operator would.
  const yamlFile = path.join(home, "events", "smoke-test", "event.yaml");
  writeFileSync(yamlFile, readFileSync(yamlFile, "utf8").replace("<id>", "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"));

  const again = await call("event_init", { event_id: "smoke-test", org: "some-org" });
  console.log("event_init again:", again.isError ? "ERROR " + again.text : `${JSON.parse(again.text).status}, valid=${JSON.parse(again.text).valid}`);

  const audit = await call("audit_query", { event: "smoke-test" });
  console.log("audit_query:", audit.isError ? "ERROR " + audit.text : `${JSON.parse(audit.text).length} rows`);

  const badId = await call("audit_query", { event: "../etc" });
  console.log("path traversal refused:", badId.isError);

  const noCreds = await call("org_check", { event: "smoke-test" });
  console.log("org_check without credentials:", noCreds.isError ? noCreds.text.split("\n")[0] : "unexpectedly ok");
} finally {
  await client.close();
  rmSync(home, { recursive: true, force: true });
}
