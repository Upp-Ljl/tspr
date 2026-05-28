#!/usr/bin/env node
/**
 * CLI entry point. Subcommands:
 *   tspr mcp               — start the MCP server (stdio transport, for cc/Cursor/etc)
 *   tspr dashboard         — open local web dashboard (http://127.0.0.1:7654)
 *   tspr pr-comment        — post a markdown summary of the latest run to a GitHub PR
 *   tspr apply-fix <id>    — apply a suggested patch from the latest run
 */
import { startMcpServer } from '../mcp/server.js';
import { runDashboardCommand } from '../dashboard/cli-command.js';
import { runPrCommentCommand } from './pr-comment-command.js';
import { runApplyFixCommand } from './apply-fix-command.js';

const subcommand = process.argv[2];
const args = process.argv.slice(3);

function usage(): never {
  process.stderr.write(
    [
      `Usage: tspr <subcommand> [options]`,
      ``,
      `Subcommands:`,
      `  mcp                          start MCP server over stdio`,
      `  dashboard                    open local web dashboard (default :7654)`,
      `  pr-comment <pr#>             post latest run summary to a GitHub PR via gh CLI`,
      `  apply-fix <id> [<id2>...]    apply one or more suggested patches from the latest run`,
      ``,
      `dashboard options:`,
      `  --port <n>                   HTTP port (default: 7654)`,
      `  --no-open                    do not auto-open browser`,
      `  --watch                      watch project source files; re-run affected scenarios on change`,
      `  --project <path>             project path to watch (default: cwd)`,
      ``,
      `apply-fix options:`,
      `  --no-commit                  apply patch only, skip git branch/commit`,
      `  --branch <name>              custom branch name (default: tspr/fix-<id>)`,
      `  --dry-run                    show what would happen without doing it`,
      `  --project <path>             target project path (default: cwd)`,
      `  --open / --no-open           open VS Code at fix location after apply (default: open)`,
      ``,
      `Examples:`,
      `  tspr mcp`,
      `  tspr dashboard --port 8080 --no-open`,
      `  tspr dashboard --watch --project /path/to/project`,
      `  tspr pr-comment 42 --repo owner/name --dry-run`,
      `  tspr apply-fix a1b2c3d4e5f6 --no-commit`,
      `  tspr apply-fix a1b2c3d4e5f6 --branch fix/meme-weather-settle --open`,
      `  tspr apply-fix id1 id2 id3   (batch: one commit for all three)`,
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

      case 'apply-fix': {
        const code = await runApplyFixCommand(args);
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
