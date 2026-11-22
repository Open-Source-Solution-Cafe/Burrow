export const MENTION_INLINE = 'mention';
export const NOTEPAD_LINK_BLOCK = 'notepadLink';
export const CARD_LINK_BLOCK = 'cardLink';
export const BOARD_LINK_BLOCK = 'boardLink';

export type PluginMentionKind = `plugin:${string}:${string}`;

export const PLUGIN_MENTION_KIND_RE = /^plugin:[a-z][a-z0-9-]{0,30}:[a-z0-9_-]+$/;

export function isPluginMentionKind(kind: unknown): kind is PluginMentionKind {
  return typeof kind === 'string' && PLUGIN_MENTION_KIND_RE.test(kind);
}

export type MentionKind = 'user' | 'notepad' | 'card' | 'date' | 'tag' | PluginMentionKind;

export type LinkTargetType = 'user' | 'notepad' | 'card' | 'board';

export interface MentionProps {
  kind: MentionKind;
  /** Absent for date mentions. */
  id?: string;
  label: string;
  /** ISO date string when kind === 'date'. */
  isoDate?: string;
}

export interface NotepadLinkProps {
  notepadId: string;
}

export interface CardLinkProps {
  cardId: string;
}

export interface BoardLinkProps {
  boardId: string;
}

/** The raw shapes we expect inside BlockNote JSON before validation. */
export interface RawBlock {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: RawBlock[];
  [key: string]: unknown;
}

export type RawDoc = RawBlock[];
