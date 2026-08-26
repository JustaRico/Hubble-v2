#!/usr/bin/env node
/**
 * Hubble file-scanner MCP server (stdio).
 *
 * Phase 4 tool aggregated through MCPHub: safe, read-only listing of a
 * directory tree. Rooted at FILE_SCANNER_ROOT and refuses to escape it.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const ROOT = resolve(process.env.FILE_SCANNER_ROOT ?? "/data");
const MAX_ENTRIES = Number(process.env.FILE_SCANNER_MAX ?? "500");

function listDir(rel) {
  const target = resolve(ROOT, rel === "" ? "." : rel);
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    throw new Error(`path escapes scanner root: ${rel}`);
  }
  let st;
  try {
    st = statSync(target);
  } catch {
    throw new Error(`not found: ${rel}`);
  }
  if (!st.isDirectory()) throw new Error(`not a directory: ${rel}`);

  const entries = [];
  for (const name of readdirSync(target).sort()) {
    if (entries.length >= MAX_ENTRIES) break;
    const full = join(target, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    entries.push({
      name,
      type: s.isDirectory() ? "directory" : "file",
      size: s.isFile() ? s.size : undefined,
      modified: s.mtime.toISOString(),
    });
  }
  return { root: ROOT, path: rel || ".", entry_count: entries.length, entries };
}

const server = new Server(
  { name: "hubble-file-scanner", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "scan_directory",
      description:
        "List files and subdirectories of a path relative to the scanner root (read-only).",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "relative path, default '.'" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "scan_directory") {
    return {
      content: [{ type: "text", text: `unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }
  const rel = request.params.arguments?.path ?? ".";
  try {
    return {
      content: [{ type: "text", text: JSON.stringify(listDir(rel), null, 2) }],
    };
  } catch (err) {
    return { content: [{ type: "text", text: String(err.message) }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[hubble-file-scanner] serving ${ROOT} over stdio`);
