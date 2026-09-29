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

export function humanizeSshError(err: unknown): string {
  if (err instanceof TransferCancelled) return 'Cancelled';
  if (err instanceof HostKeyChangedError) return err.message;
  if (!(err instanceof Error)) return 'Something went wrong';
  const code = (err as NodeJS.ErrnoException).code;
  const message = err.message || '';
  if (code === 'ENOTFOUND' || /getaddrinfo/i.test(message)) return 'Could not resolve the host';
  if (code === 'ECONNREFUSED') return 'Connection refused';
  if (code === 'ETIMEDOUT' || /timed out/i.test(message)) return 'Connection timed out';
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'Network unreachable';
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
