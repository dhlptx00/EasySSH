import fs from 'fs';
import { TransferCancelled } from './errors';

/**
 * Parallel SFTP transfers. ssh2's stream API keeps one request in flight, so its
 * speed is about one chunk per round trip. These helpers keep several reads or
 * writes outstanding (like ssh2's fastGet/fastPut) but stay cancellable, report
 * progress, and check that every byte arrived.
 */

/** The part of ssh2's SFTPWrapper the transfers use. */
export interface SftpHandleApi {
  open(path: string, flags: string, attrs: { mode?: number }, cb: (err: Error | null | undefined, handle: Buffer) => void): void;
  close(handle: Buffer, cb: (err: Error | null | undefined) => void): void;
  read(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: (err: Error | null | undefined, bytesRead: number) => void,
  ): void;
  write(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, cb: (err: Error | null | undefined) => void): void;
  fstat(handle: Buffer, cb: (err: Error | null | undefined, stats: { size?: number | bigint; mode?: number }) => void): void;
  fchmod?(handle: Buffer, mode: number, cb: (err: Error | null | undefined) => void): void;
}

export const CHUNK_SIZE = 32 * 1024;
export const DEFAULT_CONCURRENCY = 32;

export interface ChunkOptions {
  concurrency: number;
  signal: AbortSignal;
  /** Called with the number of new bytes after each chunk. */
  onBytes: (bytes: number) => void;
  chunkSize?: number;
}

export interface CopyResult {
  /** Bytes copied. */
  bytes: number;
  /** Size reported when the copy started. */
  expected: number;
}

/** Thrown when fewer bytes arrived than the source said it had. */
export class IncompleteTransfer extends Error {
  override readonly name = 'IncompleteTransfer';
  constructor(readonly bytes: number, readonly expected: number) {
    super(`incomplete transfer: ${bytes} of ${expected} bytes`);
  }
}

function count(value: number | bigint | undefined): number {
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function call<T>(run: (done: (err: Error | null | undefined, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    run((err, value) => (err ? reject(err) : resolve(value)));
  });
}

export function sftpOpen(sftp: SftpHandleApi, path: string, flags: string, mode?: number): Promise<Buffer> {
  return call((done) => sftp.open(path, flags, mode === undefined ? {} : { mode }, done));
}

export function sftpClose(sftp: SftpHandleApi, handle: Buffer): Promise<void> {
  return call<void>((done) => sftp.close(handle, (err) => done(err, undefined))).catch(() => undefined);
}

export function sftpFstat(sftp: SftpHandleApi, handle: Buffer): Promise<{ size: number; mode?: number }> {
  return call<{ size?: number | bigint; mode?: number }>((done) => sftp.fstat(handle, done)).then((stats) => ({
    size: count(stats.size),
    mode: stats.mode,
  }));
}

function readAt(sftp: SftpHandleApi, handle: Buffer, buffer: Buffer, length: number, position: number): Promise<number> {
  return call<number>((done) => sftp.read(handle, buffer, 0, length, position, (err, bytes) => done(err, bytes ?? 0)));
}

function writeAt(sftp: SftpHandleApi, handle: Buffer, buffer: Buffer, length: number, position: number): Promise<void> {
  return call<void>((done) => sftp.write(handle, buffer, 0, length, position, (err) => done(err, undefined)));
}

/** A local destination or source with positional I/O. */
export interface LocalFile {
  write(buffer: Buffer, offset: number, length: number, position: number): Promise<unknown>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
}

export function localFile(handle: fs.promises.FileHandle): LocalFile {
  return {
    write: (buffer, offset, length, position) => handle.write(buffer, offset, length, position),
    read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
  };
}

/**
 * Run `work(position, length)` for every chunk of [0, size) with at most
 * `concurrency` chunks outstanding. Stops at the first error or on cancel and
 * waits for the chunks already in flight before it settles.
 */
async function eachChunk(
  size: number,
  options: ChunkOptions,
  work: (position: number, length: number) => Promise<void>,
): Promise<void> {
  const chunk = options.chunkSize ?? CHUNK_SIZE;
  const limit = Math.max(1, Math.floor(options.concurrency) || 1);
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (failure === undefined && next < size) {
      if (options.signal.aborted) {
        failure = new TransferCancelled();
        return;
      }
      const position = next;
      const length = Math.min(chunk, size - position);
      next += length;
      try {
        await work(position, length);
      } catch (err) {
        if (failure === undefined) failure = err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, Math.ceil(size / chunk) || 0) }, worker));
  if (failure !== undefined) throw failure;
  if (options.signal.aborted) throw new TransferCancelled();
}

/**
 * Copy an open remote file into a local file. Reads [0, size) in parallel, then
 * keeps reading sequentially from `size` until end of file, so files that report
 * size 0 (/proc) or grew meanwhile arrive whole. Fewer bytes than `size` throw
 * IncompleteTransfer.
 */
export async function downloadHandle(
  sftp: SftpHandleApi,
  handle: Buffer,
  size: number,
  local: LocalFile,
  options: ChunkOptions,
): Promise<CopyResult> {
  let bytes = 0;
  let shortAt = Infinity;
  const chunk = options.chunkSize ?? CHUNK_SIZE;
  await eachChunk(size, options, async (position, length) => {
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const got = await readAt(sftp, handle, filled === 0 ? buffer : buffer.subarray(filled), length - filled, position + filled);
      if (got <= 0) {
        shortAt = Math.min(shortAt, position + filled);
        break;
      }
      filled += got;
    }
    if (filled > 0) {
      await local.write(buffer, 0, filled, position);
      bytes += filled;
      options.onBytes(filled);
    }
  });
  if (shortAt !== Infinity) throw new IncompleteTransfer(Math.min(bytes, shortAt), size);
  // Sequential tail: whatever is past the reported size.
  let position = size;
  const buffer = Buffer.allocUnsafe(chunk);
  for (;;) {
    if (options.signal.aborted) throw new TransferCancelled();
    const got = await readAt(sftp, handle, buffer, chunk, position);
    if (got <= 0) break;
    await local.write(buffer, 0, got, position);
    position += got;
    bytes += got;
    options.onBytes(got);
  }
  return { bytes, expected: size };
}

/** Copy `size` bytes of a local file into an open remote file, in parallel. */
export async function uploadHandle(
  sftp: SftpHandleApi,
  handle: Buffer,
  size: number,
  local: LocalFile,
  options: ChunkOptions,
): Promise<CopyResult> {
  let bytes = 0;
  let shortAt = Infinity;
  await eachChunk(size, options, async (position, length) => {
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await local.read(buffer, filled, length - filled, position + filled);
      if (bytesRead <= 0) break;
      filled += bytesRead;
    }
    if (filled < length) shortAt = Math.min(shortAt, position + filled);
    if (filled > 0) {
      await writeAt(sftp, handle, buffer, filled, position);
      bytes += filled;
      options.onBytes(filled);
    }
  });
  if (shortAt !== Infinity) throw new IncompleteTransfer(bytes, size);
  return { bytes, expected: size };
}

/** A unique, hard-to-guess suffix for temporary .part names. */
export function partSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
