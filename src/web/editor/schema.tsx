import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from '@blocknote/core';
import { createReactInlineContentSpec, createReactBlockSpec, ReactFileBlock, ReactImageBlock, ReactVideoBlock, ReactAudioBlock } from '@blocknote/react';
import { Calendar, FileText, Kanban, Layout, Tag } from 'lucide-react';
import { referenceHref, type ContentReferenceKind } from '../../shared/references';
import { useProjectReference } from './referenceScope';
import { YoutubeMedia } from './YoutubeMedia';

function getInitials(name?: string | null): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return '?';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

/**
 * Custom inline mention content spec — Basalt angular chips / Modern rounded pills on token surfaces.
 */
export const Mention = createReactInlineContentSpec(
  {
    type: 'mention',
    propSchema: {
      kind: {
        default: 'user',
        values: ['user', 'notepad', 'card', 'date', 'tag'] as const,
      },
      id: { default: '' },
      label: { default: '' },
      isoDate: { default: '' },
    },
    content: 'none',
  },
  {
    render: (props) => {
      const { kind, id, label, isoDate } = props.inlineContent.props;

      if (kind === 'date') {
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium theme-radius-xs bg-[var(--surface2)] text-[var(--text)] border border-[var(--line)] select-none">
            <Calendar className="w-3 h-3 text-[var(--muted)]" />
            <span>{label || isoDate || 'Date'}</span>
          </span>
        );
      }

      if (kind === 'user') {
        const userInitials = getInitials(label || 'Former member');
        return (
          <span className="inline-flex items-center gap-1.5 h-[28px] pl-1 pr-3 chamfer-btn bg-[var(--hi)] text-[var(--hi-ink)] border border-[var(--line)] font-semibold text-[12px] select-none align-middle">
            <span className="w-5 h-5 clip-hex bg-[var(--accent)] text-[var(--accent-ink)] inline-flex items-center justify-center text-[9px] font-extrabold shrink-0">
              {userInitials}
            </span>
            <span>{label || 'Former member'}</span>
          </span>
        );
      }

      if (kind === 'notepad') {
        return <ResourceMention kind={kind} id={id} label={label} />;
      }

      const isTag = kind === 'tag' || (typeof label === 'string' && label.startsWith('#'));
      if (isTag) {
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium theme-radius-xs bg-[var(--surface2)] text-[var(--text)] border border-[var(--line)] border-l-2 border-l-[var(--c2)] select-none">
            <Tag className="w-3 h-3 text-[var(--muted)]" />
            <span>{label || 'Tag'}</span>
          </span>
        );
      }

      if (kind === 'card') {
        return <ResourceMention kind={kind} id={id} label={label} />;
      }

      return <span>@{label}</span>;
    },
  },
);

const referenceStyles = {
  notepad: { Icon: FileText, color: 'text-purple-500', border: 'border-l-[var(--accent)]' },
  card: { Icon: Kanban, color: 'text-emerald-500', border: 'border-l-[var(--c2)]' },
  board: { Icon: Layout, color: 'text-blue-500', border: 'border-l-blue-500' },
};

/** Preserve document labels while unavailable references remain inert. */
function ResourceMention({
  kind,
  id,
  label,
}: {
  kind: 'notepad' | 'card';
  id: string;
  label: string;
}) {
  const { data, isLoading } = useProjectReference(kind, id);
  const href = data ? referenceHref(data) : null;
  const { Icon, color } = referenceStyles[kind];
  return (
    <span
      aria-disabled={!href}
      title={href ? undefined : 'Reference unavailable in this project'}
      onClick={
        href
          ? (event) => {
              event.stopPropagation();
              window.location.href = href;
            }
          : undefined
      }
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium theme-radius-xs bg-[var(--surface2)] text-[var(--text)] border border-[var(--line)] select-none ${kind === 'card' ? 'border-l-2 border-l-[var(--c2)]' : ''} ${href ? 'cursor-pointer hover:underline' : ''}`}
    >
      <Icon className={`w-3 h-3 ${color}`} />
      <span>{label || data?.title || `${isLoading ? 'Loading' : 'Unavailable'} ${kind}`}</span>
    </span>
  );
}

/** One scoped metadata preview for all resource-link blocks. */
function ReferenceBlock({ kind, id }: { kind: ContentReferenceKind; id: string }) {
  const { data, isLoading } = useProjectReference(kind, id);
  const href = data ? referenceHref(data) : null;
  const { Icon, color, border } = referenceStyles[kind];
  const badgeClass =
    'text-[10px] uppercase font-semibold px-1.5 py-0.5 bg-[var(--surface)] border border-[var(--line)]';
  if (isLoading) {
    return (
      <div className="my-2 p-2.5 border border-[var(--line)] bg-[var(--surface2)] flex items-center gap-2 text-xs text-[var(--muted)]">
        <Icon className={`w-3.5 h-3.5 ${color}`} />
        <span>Loading {kind === 'card' ? 'task card' : kind}…</span>
      </div>
    );
  }
  return (
    <div
      aria-disabled={!href}
      onClick={
        href
          ? () => {
              window.location.href = href;
            }
          : undefined
      }
      className={`my-2 p-3 border border-l-4 flex items-center justify-between gap-3 text-sm transition select-none ${
        href
          ? `border-[var(--line)] ${border} bg-[var(--surface2)] hover:bg-[var(--hi)] cursor-pointer`
          : 'border-[var(--line)] bg-[var(--surface2)] text-[var(--muted)] opacity-70'
      }`}
    >
      <div className="flex items-center gap-2.5">
        {kind === 'notepad' ? (
          <span className="text-base">{data?.icon || '📄'}</span>
        ) : (
          <Icon className={`w-4 h-4 ${color} shrink-0`} />
        )}
        <div>
          <div className="font-semibold text-[var(--text)]">
            {data?.title ||
              (href ? (kind === 'board' ? 'Untitled Board' : 'Untitled') : `Unavailable ${kind}`)}
          </div>
          {kind === 'card' && href && (
            <div className="text-[11px] text-[var(--muted)]">
              {data?.boardName} &bull; {data?.columnName}
            </div>
          )}
        </div>
      </div>
      {!href ? (
        <span className={`${badgeClass} text-[var(--muted)]`}>Unavailable</span>
      ) : kind === 'card' && data?.priority ? (
        <span className={`${badgeClass} border-l-2 border-l-[var(--c2)] text-[var(--text)]`}>
          {data.priority}
        </span>
      ) : null}
    </div>
  );
}

export const NotepadLinkBlock = createReactBlockSpec(
  { type: 'notepadLink', propSchema: { notepadId: { default: '' } }, content: 'none' },
  { render: ({ block }) => <ReferenceBlock kind="notepad" id={block.props.notepadId} /> },
);

export const CardLinkBlock = createReactBlockSpec(
  { type: 'cardLink', propSchema: { cardId: { default: '' } }, content: 'none' },
  { render: ({ block }) => <ReferenceBlock kind="card" id={block.props.cardId} /> },
);

export const BoardLinkBlock = createReactBlockSpec(
  { type: 'boardLink', propSchema: { boardId: { default: '' } }, content: 'none' },
  { render: ({ block }) => <ReferenceBlock kind="board" id={block.props.boardId} /> },
);

export const YoutubeBlock = createReactBlockSpec(
  {
    type: 'youtube',
    propSchema: { videoId: { default: '' }, widthPercent: { default: 100 } },
    content: 'none',
  },
  {
    render: ({ block, editor }) => <YoutubeMedia block={block} editor={editor} />,
  },
);

/**
 * Burrow BlockNote schema combining default blocks with custom mentions and link blocks.
 */
export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    file: ReactFileBlock(),
    image: ReactImageBlock(),
    video: ReactVideoBlock(),
    audio: ReactAudioBlock(),
    notepadLink: NotepadLinkBlock(),
    cardLink: CardLinkBlock(),
    boardLink: BoardLinkBlock(),
    youtube: YoutubeBlock(),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    mention: Mention,
  },
});

export type BurrowSchema = typeof schema;
