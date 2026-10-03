import { formatSize } from '../text';
import type { TransferProgress } from '../types';

/** "1:05" or "1:02:03". */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Bytes per second over the transfer so far. Zero until there is something to measure. */
export function transferSpeed(bytes: number, elapsedMs: number): number {
  if (elapsedMs < 250 || bytes <= 0) return 0;
  return bytes / (elapsedMs / 1000);
}

/**
 * One line for a transfer, e.g.
 * "12.3 MB / 80 MB · 4.1 MB/s · 0:16 left · 3/10 files · +2 queued".
 */
export function formatProgress(progress: TransferProgress, elapsedMs: number, queued = 0): string {
  const parts: string[] = [];
  if (progress.phase === 'scan') {
    parts.push(progress.totalFiles > 0 ? `Listing… ${progress.totalFiles} files` : 'Listing…');
  } else {
    parts.push(progress.totalBytes > 0 ? `${formatSize(progress.bytes)} / ${formatSize(progress.totalBytes)}` : formatSize(progress.bytes));
    const speed = transferSpeed(progress.bytes, elapsedMs);
    if (speed > 0) {
      parts.push(`${formatSize(speed)}/s`);
      const left = progress.totalBytes - progress.bytes;
      if (progress.totalBytes > 0 && left > 0) parts.push(`${formatDuration(left / speed)} left`);
    }
    if (progress.totalFiles > 1) parts.push(`${Math.min(progress.files, progress.totalFiles)}/${progress.totalFiles} files`);
  }
  if (queued > 0) parts.push(`+${queued} queued`);
  return parts.join(' · ');
}

/** 0..1 for a progress bar, or undefined while the total is unknown. */
export function progressFraction(progress: TransferProgress): number | undefined {
  if (progress.phase === 'scan') return undefined;
  if (progress.totalBytes > 0) return Math.min(1, progress.bytes / progress.totalBytes);
  if (progress.totalFiles > 0) return Math.min(1, progress.files / progress.totalFiles);
  return undefined;
}

/** Big enough for a notification with Cancel: over 5 MB or more than one file. */
export function wantsNotification(progress: TransferProgress): boolean {
  return progress.totalBytes > 5 * 1024 * 1024 || progress.totalFiles > 1 || progress.phase === 'scan';
}
