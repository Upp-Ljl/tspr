#!/usr/bin/env node
/**
 * CLI entry point. Subcommands:
 *   tspr mcp          — start the MCP server (stdio transport, for cc/Cursor/etc)
 *   tspr dashboard    — open local web dashboard (http://127.0.0.1:7654)
 *   tspr pr-comment   — post a markdown summary of the latest run to a GitHub PR
 */
import { startMcpServer } from '../mcp/server.js';
import { runDashboardCommand } from '../dashboard/cli-command.js';
import { runPrCommentCommand } from './pr-comment-command.js';

const subcommand = process.argv[2];
const args = process.argv.slice(3);

function usage(): never {
  process.stderr.write(
    [
      `Usage: tspr <subcommand> [options]`,
      ``,
      `Subcommands:`,
      `  mcp                 start MCP server over stdio`,
      `  dashboard           open local web dashboard (default :7654)`,
      `  pr-comment <pr#>    post latest run summary to a GitHub PR via gh CLI`,
      ``,
      `Examples:`,
      `  tspr mcp`,
      `  tspr dashboard --port 8080 --no-open`,
      `  tspr pr-comment 42 --repo owner/name --dry-run`,
      ``,
    ].join('\n'),
  );
  process.exit(subcommand ? 1 : 0);
}

(async () => {
  try {
    switch (subcommand) {
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        usage();
        return;

      case 'mcp':
        await startMcpServer(args);
        return;

      case 'dashboard': {
        const code = await runDashboardCommand(args);
        process.exit(code);
      }

      case 'pr-comment': {
        const code = await runPrCommentCommand(args);
        process.exit(code);
      }

      default:
        process.stderr.write(`[tspr] unknown subcommand: ${subcommand}\n`);
        usage();
    }
  } catch (err) {
    process.stderr.write(`[tspr] fatal: ${String(err)}\n`);
    process.exit(1);
  }
})();
