import { execSync, exec as execCb } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(execCb);

/**
 * Runs `docker inspect <id>` and parses JSON.
 * Returns null if the container doesn't exist.
 */
export async function dockerInspect(id: string): Promise<Record<string, unknown> | null> {
  try {
    const result = execSync(`docker inspect ${id}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const parsed = JSON.parse(result);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    return null;
  }
}

/**
 * Returns list of all container IDs with label tspr.managed=true
 */
export async function listManagedContainers(): Promise<string[]> {
  try {
    const result = execSync(
      'docker ps -a --filter label=tspr.managed=true --format {{.ID}}',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return result.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Creates a temp dir with a minimal package.json.
 * Optionally adds extra files via the files parameter.
 */
export async function makeTempProject(files?: Record<string, string>): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-'));
  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({ name: 'test-project', version: '1.0.0' })
  );
  if (files) {
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(tmpDir, name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
  }
  return tmpDir;
}

/**
 * Creates a temp project with a TCP server script that listens on the given port.
 * The server listens on process.env.PORT if set.
 */
export async function makeProjectWithServerScript(port: number): Promise<string> {
  const serverJs = `
const net = require('net');
const p = parseInt(process.env.PORT || '${port}', 10);
const server = net.createServer((s) => { s.pipe(s); });
server.listen(p, '0.0.0.0', () => {
  process.stdout.write('TCP server listening on port ' + p + '\\n');
});
server.on('error', (e) => { process.stderr.write(e.message + '\\n'); process.exit(1); });
`;
  return makeTempProject({ 'server.js': serverJs });
}

/**
 * Creates a temp project with an HTTP server that responds with the given status.
 */
export async function makeProjectWithHttpServer(
  port: number,
  status = 200
): Promise<string> {
  const serverJs = `
const http = require('http');
const p = parseInt(process.env.PORT || '${port}', 10);
const server = http.createServer((req, res) => {
  res.writeHead(${status});
  res.end('${status === 204 ? '' : 'OK'}\\n');
});
server.listen(p, '0.0.0.0', () => {
  process.stdout.write('HTTP server listening on port ' + p + '\\n');
});
server.on('error', (e) => { process.stderr.write(e.message + '\\n'); process.exit(1); });
`;
  return makeTempProject({ 'http-server.js': serverJs });
}

/**
 * Cleans up any leaked managed containers.
 */
export async function cleanupLeakedContainers(): Promise<void> {
  const leaked = await listManagedContainers();
  if (leaked.length > 0) {
    console.warn(`[test teardown] Removing ${leaked.length} leaked managed containers`);
    await Promise.all(
      leaked.map((id) => execAsync(`docker rm -f ${id}`).catch(() => {}))
    );
  }
}
