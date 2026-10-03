import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatDuration, formatProgress, progressFraction, transferSpeed, wantsNotification } from './progress';
import type { TransferProgress } from '../types';

const MB = 1024 * 1024;

function state(extra: Partial<TransferProgress>): TransferProgress {
  return { phase: 'copy', bytes: 0, totalBytes: 0, files: 0, totalFiles: 1, ...extra };
}

describe('transfer progress (U1)', () => {
  it('formats durations', () => {
    assert.equal(formatDuration(5), '0:05');
    assert.equal(formatDuration(65), '1:05');
    assert.equal(formatDuration(3723), '1:02:03');
    assert.equal(formatDuration(-3), '0:00');
  });

  it('measures speed only once there is something to measure', () => {
    assert.equal(transferSpeed(MB, 100), 0);
    assert.equal(transferSpeed(0, 5000), 0);
    assert.equal(transferSpeed(4 * MB, 2000), 2 * MB);
  });

  it('shows size, speed, time left, files and the queue', () => {
    const text = formatProgress(state({ bytes: 10 * MB, totalBytes: 40 * MB, files: 3, totalFiles: 10 }), 5000, 2);
    assert.match(text, /^10(\.0)? MB \/ 40(\.0)? MB · 2(\.0)? MB\/s · 0:15 left · 3\/10 files · \+2 queued$/);
    assert.equal(formatProgress(state({ phase: 'scan', totalFiles: 120 }), 100), 'Listing… 120 files');
    assert.equal(formatProgress(state({ phase: 'scan', totalFiles: 0 }), 100), 'Listing…');
  });

  it('gives a fraction for the bar', () => {
    assert.equal(progressFraction(state({ bytes: 5, totalBytes: 10 })), 0.5);
    assert.equal(progressFraction(state({ files: 1, totalFiles: 4 })), 0.25);
    assert.equal(progressFraction(state({ phase: 'scan' })), undefined);
    assert.equal(progressFraction(state({ bytes: 20, totalBytes: 10 })), 1);
  });

  it('opens a notification for big or many-file transfers only', () => {
    assert.equal(wantsNotification(state({ totalBytes: MB })), false);
    assert.equal(wantsNotification(state({ totalBytes: 6 * MB })), true);
    assert.equal(wantsNotification(state({ totalFiles: 2 })), true);
    assert.equal(wantsNotification(state({ phase: 'scan' })), true);
  });
});
