import assert from 'node:assert/strict';
import { Readable, Writable } from 'stream';
import { describe, it } from 'node:test';
import { pipeTransfer } from './session';
import { TransferCancelled } from './errors';

/** Matches ssh2's write stream: destroy inside _final, then close and no finish. */
class RemoteWrite extends Writable {
  constructor() {
    super({ emitClose: false, autoDestroy: false });
  }

  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.destroy();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    callback(error);
    if (!error) this.emit('close');
  }
}

describe('file transfer', () => {
  it('finishes an upload when the remote stream only emits close', async () => {
    let done = 0;
    await pipeTransfer(
      Readable.from([Buffer.from('hello')]),
      new RemoteWrite(),
      5,
      (transferred) => {
        done = transferred;
      },
      new AbortController().signal,
    );
    assert.equal(done, 5);
  });

  it('stops when the transfer is cancelled', async () => {
    const abort = new AbortController();
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        abort.abort();
        callback();
      },
    });
    await assert.rejects(
      pipeTransfer(Readable.from([Buffer.from('hello')]), destination, 5, () => {}, abort.signal),
      TransferCancelled,
    );
  });
});
