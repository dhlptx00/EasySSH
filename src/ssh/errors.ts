export class TransferCancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'TransferCancelled';
  }
}

export class HostKeyChangedError extends Error {
  override readonly name = 'HostKeyChangedError';
  constructor(
    readonly host: string,
    readonly port: number,
    readonly fingerprint: string,
  ) {
    super(`Host key changed for ${host}:${port}`);
  }
}

/** Why a local file operation failed, in words. Node's own message repeats the path. */
function localReason(err: NodeJS.ErrnoException, platform: NodeJS.Platform): string {
  switch (err.code) {
    case 'EACCES':
    case 'EPERM':
      return platform === 'darwin'
        ? 'permission denied (allow the editor to use this folder in System Settings > Privacy & Security)'
        : 'permission denied';
    case 'ENOENT':
      return 'not found';
    case 'EBUSY':
      return 'the file is in use by another program';
    case 'EINVAL':
      return 'invalid file name';
    case 'ENOSPC':
      return 'the disk is full';
    case 'EISDIR':
      return 'a folder has that name';
    default:
      return err.message || String(err.code ?? 'failed');
  }
}

/**
 * A transfer step that failed, with the operation and path it failed on,
 * e.g. "Cannot write /srv/app/runtime/app.jar: Permission denied".
 */
export class TransferError extends Error {
  override readonly name = 'TransferError';
  /** SFTP status code (number) or Node error code (string) of the cause. */
  readonly code: string | number | undefined;
  readonly reason: string;

  constructor(
    readonly action: string,
    readonly target: string,
    readonly side: 'local' | 'remote',
    override readonly cause: unknown,
    platform: NodeJS.Platform = process.platform,
  ) {
    const errno = cause as NodeJS.ErrnoException & { code?: string | number };
    const reason = side === 'local' && typeof errno?.code === 'string'
      ? localReason(errno as NodeJS.ErrnoException, platform)
      : cause instanceof Error ? cause.message || 'failed' : String(cause);
    super(`${action} ${target}: ${reason}`);
    this.code = errno?.code;
    this.reason = reason;
  }

  /** True when the SSH server refused the operation (SFTP status 3). */
  get remotePermissionDenied(): boolean {
    return this.side === 'remote' && (this.code === 3 || /permission denied/i.test(this.reason));
  }
}

export function humanizeSshError(err: unknown): string {
  if (err instanceof TransferCancelled) return 'Cancelled';
  if (err instanceof TransferError) return err.message;
  if (err instanceof HostKeyChangedError) return err.message;
  if (!(err instanceof Error)) return 'Something went wrong';
  const code = (err as NodeJS.ErrnoException).code;
  const message = err.message || '';
  if (code === 'ENOTFOUND' || /getaddrinfo/i.test(message)) return 'Could not resolve the host';
  if (code === 'ECONNREFUSED') return 'Connection refused';
  if (code === 'ETIMEDOUT' || /timed out/i.test(message)) return 'Connection timed out';
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'Network unreachable';
  if (code === 'EACCES' || code === 'EPERM') return 'Cannot write to the download folder. Allow the editor to access the Desktop.';
  if (/authentication methods failed/i.test(message) || /all configured authentication/i.test(message)) {
    return 'Authentication failed';
  }
  if (/unsupported key format|cannot parse privatekey|bad passphrase|encrypted/i.test(message)) {
    return 'Could not read the private key. Check the path and passphrase.';
  }
  if (/host verification failed/i.test(message)) return 'Host key was rejected';
  if (message && message.length < 180) return message;
  return 'Connection failed';
}
