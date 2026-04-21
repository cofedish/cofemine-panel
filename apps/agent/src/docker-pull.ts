import type Docker from "dockerode";

/**
 * Pull a Docker image if it isn't already present locally. No-op if the
 * image already exists. Resolves once the pull stream completes so the
 * caller can safely `docker.createContainer` after.
 *
 * This is what fixes the "no such image: itzg/minecraft-server:latest"
 * 404 when creating a server on a fresh host — the daemon won't
 * auto-pull on create, so we have to do it explicitly.
 */
export async function ensureImagePulled(
  docker: Docker,
  image: string,
  log: (msg: string) => void = () => {}
): Promise<void> {
  try {
    const info = docker.getImage(image);
    await info.inspect();
    return; // already present
  } catch {
    // fall through to pull
  }

  log(`pulling ${image}`);
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    (docker as any).modem.followProgress(
      stream,
      (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      },
      // onProgress — we don't surface layer-by-layer progress to the
      // client; the API call blocks until pull is done.
      () => {}
    );
  });
  log(`pulled ${image}`);
}
