#!/usr/bin/env node
/**
 * CLI entry point: tspr mcp — starts the MCP server.
 */
import { startMcpServer } from '../mcp/server.js';

const subcommand = process.argv[2];

if (subcommand === 'mcp' || subcommand === undefined) {
  const argv = subcommand ? process.argv.slice(3) : process.argv.slice(2);
  startMcpServer(argv).catch((err) => {
    process.stderr.write(`[tspr] fatal: ${String(err)}\n`);
    process.exit(1);
  });
} else {
  process.stderr.write(`[tspr] unknown subcommand: ${subcommand}\nUsage: tspr mcp [options]\n`);
  process.exit(1);
}
