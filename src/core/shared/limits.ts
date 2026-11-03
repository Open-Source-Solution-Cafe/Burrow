/** Root notepads are depth 1. */
export const MAX_NOTEPAD_DEPTH = 8;
/** Keep document bodies below the database row limit. */
export const MAX_CONTENT_BYTES = 1_500_000;
/** Rolling edit-lock window in milliseconds. */
export const LOCK_TTL_MS = 60_000;

const encoder = new TextEncoder();
export const contentByteLength = (content: string): number => encoder.encode(content).length;
