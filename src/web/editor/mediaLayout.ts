/** Keep persisted media widths usable, including legacy or malformed content. */
export function mediaWidthPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(25, Math.round(value))) : 100;
}
