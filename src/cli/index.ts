#!/usr/bin/env node
/**
 * CLI entry point: localsprite mcp — starts the MCP server.
 */
import { startMcpServer } from '../mcp/server.js';

const subcommand = process.argv[2];

if (subcommand === 'mcp' || subcommand === undefined) {
  const argv = subcommand ? process.argv.slice(3) : process.argv.slice(2);
  startMcpServer(argv).catch((err) => {
    process.stderr.write(`[localsprite] fatal: ${String(err)}\n`);
    process.exit(1);
  });
} else {
  process.stderr.write(`[localsprite] unknown subcommand: ${subcommand}\nUsage: localsprite mcp [options]\n`);
  process.exit(1);
}
