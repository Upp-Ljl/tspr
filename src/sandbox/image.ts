import Dockerode from 'dockerode';
import { SandboxError, ERROR_CODES } from './errors.js';
import * as os from 'os';

/** Module-level cache of verified image digests */
const imageDigestCache: Map<string, string> = new Map();

/**
 * Creates a Dockerode instance using platform-appropriate socket path.
 */
export function createDockerClient(): Dockerode {
  const socketPath =
    process.env.DOCKER_SOCKET_PATH ??
    (os.platform() === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock');

  return new Dockerode({ socketPath });
}

/**
 * Verifies Docker daemon is reachable within 2000ms.
 * Throws SandboxError(ERR_DOCKER_UNAVAILABLE) on failure.
 */
export async function checkDockerAlive(docker: Dockerode): Promise<void> {
  const timeout = 2000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    await Promise.race([
      docker.info(),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener('abort', () =>
          reject(new Error('Docker info timed out'))
        )
      ),
    ]);
  } catch (err) {
    throw new SandboxError(
      ERROR_CODES.DOCKER_UNAVAILABLE,
      'Docker daemon not reachable within 2 s. Install Docker Desktop to continue.',
      {
        cause: err,
        installUrl: 'https://docs.docker.com/get-docker/',
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ensures the sandbox image is available locally.
 * Checks imageDigestCache first; if not cached, inspects the image.
 * If image is missing, throws ERR_IMAGE_BUILD_FAILED.
 */
export async function checkAndEnsureImage(docker: Dockerode): Promise<void> {
  const imageName =
    process.env.LOCALSPRITE_SANDBOX_IMAGE ?? 'localsprite/sandbox-node:24';

  if (imageDigestCache.has(imageName)) {
    return;
  }

  try {
    const image = docker.getImage(imageName);
    const info = await image.inspect();
    const digest =
      (info.RepoDigests && info.RepoDigests[0]) ?? info.Id;
    imageDigestCache.set(imageName, digest);
  } catch (err) {
    // Image not found locally — try to pull
    try {
      await pullImage(docker, imageName);
      const image = docker.getImage(imageName);
      const info = await image.inspect();
      const digest =
        (info.RepoDigests && info.RepoDigests[0]) ?? info.Id;
      imageDigestCache.set(imageName, digest);
    } catch (pullErr) {
      throw new SandboxError(
        ERROR_CODES.IMAGE_BUILD_FAILED,
        `Could not find or pull image "${imageName}". Run scripts/build-sandbox-image.sh first.`,
        { cause: pullErr }
      );
    }
  }
}

async function pullImage(docker: Dockerode, image: string): Promise<void> {
  return new Promise((resolve, reject) => {
    docker.pull(image, {}, (err: Error | null, stream?: NodeJS.ReadableStream) => {
      if (err) {
        reject(err);
        return;
      }
      if (!stream) {
        reject(new Error('No stream returned from docker.pull'));
        return;
      }
      docker.modem.followProgress(stream, (finishErr: Error | null) => {
        if (finishErr) reject(finishErr);
        else resolve();
      });
    });
  });
}

/** Clear image cache (for testing) */
export function clearImageCache(): void {
  imageDigestCache.clear();
}
