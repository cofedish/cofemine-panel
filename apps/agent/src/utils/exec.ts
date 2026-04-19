import type Dockerode from "dockerode";

/**
 * Run a command in a running container and return its combined stdout/stderr.
 * Uses docker exec, AttachStdout/Stderr, multiplexed stream demux via modem.
 */
export async function execInContainer(
  container: Dockerode.Container,
  cmd: string[]
): Promise<string> {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stdout = new PassThroughCollector(chunks);
    const stderr = new PassThroughCollector(chunks);
    (container as any).modem.demuxStream(stream, stdout, stderr);
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return Buffer.concat(chunks).toString("utf8");
}

/** Stream lines from a container exec to a callback. */
export async function streamExecOutput(
  container: Dockerode.Container,
  cmd: string[],
  onChunk: (chunk: string) => void
): Promise<void> {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  await new Promise<void>((resolve, reject) => {
    const out = new PassThroughCb(onChunk);
    const err = new PassThroughCb(onChunk);
    (container as any).modem.demuxStream(stream, out, err);
    stream.on("end", resolve);
    stream.on("error", reject);
  });
}

import { Writable } from "node:stream";

class PassThroughCollector extends Writable {
  constructor(private readonly chunks: Buffer[]) {
    super();
  }
  override _write(
    chunk: Buffer,
    _enc: BufferEncoding,
    cb: (error?: Error | null) => void
  ): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
}

class PassThroughCb extends Writable {
  constructor(private readonly cb: (chunk: string) => void) {
    super();
  }
  override _write(
    chunk: Buffer,
    _enc: BufferEncoding,
    next: (error?: Error | null) => void
  ): void {
    this.cb(chunk.toString("utf8"));
    next();
  }
}
