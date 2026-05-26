import * as net from 'net';
import { SandboxError, ERROR_CODES } from './errors.js';

/** Module-level set of ports currently allocated by this process */
const allocatedPorts: Set<number> = new Set();

/**
 * Allocates an ephemeral TCP port by binding a server on port 0,
 * recording the assigned OS port, then closing the server.
 * Stores the port in allocatedPorts to prevent collision.
 */
export async function allocateEphemeralPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new SandboxError(ERROR_CODES.PORT_UNAVAILABLE, 'Could not determine assigned port'));
        return;
      }
      const port = addr.port;
      server.close(() => {
        if (allocatedPorts.has(port)) {
          // Retry
          allocateEphemeralPort().then(resolve, reject);
          return;
        }
        if (port < 1024) {
          reject(new SandboxError(ERROR_CODES.PORT_UNAVAILABLE, `Allocated port ${port} is in reserved range`));
          return;
        }
        allocatedPorts.add(port);
        resolve(port);
      });
    });
    server.on('error', (err) => {
      reject(new SandboxError(ERROR_CODES.PORT_UNAVAILABLE, 'Port allocation failed', err));
    });
  });
}

/** Release a port from the allocated set (called on dispose) */
export function releasePort(port: number): void {
  allocatedPorts.delete(port);
}

/** Returns the current set of allocated ports (for testing/debugging) */
export function getAllocatedPorts(): ReadonlySet<number> {
  return allocatedPorts;
}
