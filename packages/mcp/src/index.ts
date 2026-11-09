#!/usr/bin/env node
// node:sqlite still prints an ExperimentalWarning on Node 22/24. It goes to stderr, but keep the logs clean.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === "string" ? warning : warning?.message;
  if (msg?.includes("SQLite is an experimental feature")) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { createServer, VERSION } = await import("./server.js");

const server = createServer();
await server.connect(new StdioServerTransport());
console.error(`[simple-hackathon-ops] v${VERSION} ready on stdio (home: ${process.env.HACKATHON_OPS_HOME ?? process.cwd()})`);
