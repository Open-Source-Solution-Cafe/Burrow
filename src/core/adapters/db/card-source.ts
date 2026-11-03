import { and, isNull, sql, type SQLWrapper } from 'drizzle-orm';
import type { ProjectScope } from '../../infrastructure/types';

/** The joined card body and column must belong to the board's project and workspace. */
export function cardSourceAgreement(t: {
  cards: { boardId: SQLWrapper };
  boards: { workspaceId: SQLWrapper };
  boardColumns: { boardId: SQLWrapper };
  projects: { id: SQLWrapper; workspaceId: SQLWrapper };
  notepads: { projectId: SQLWrapper; workspaceId: SQLWrapper; kind: SQLWrapper };
}) {
  return and(
    sql`${t.boardColumns.boardId} = ${t.cards.boardId}`,
    sql`${t.notepads.projectId} = ${t.projects.id}`,
    sql`${t.notepads.workspaceId} = ${t.projects.workspaceId}`,
    sql`${t.boards.workspaceId} = ${t.projects.workspaceId}`,
    sql`${t.notepads.kind} = 'card'`,
  );
}

/** Live lists additionally require both board and card body to be live. */
export function liveCardSource(
  t: Parameters<typeof cardSourceAgreement>[0] & {
    boards: { deletedAt: SQLWrapper };
    notepads: { deletedAt: SQLWrapper };
  },
) {
  return and(cardSourceAgreement(t), isNull(t.boards.deletedAt), isNull(t.notepads.deletedAt));
}

/** A card and its parent rows must agree on both IDs before child rows are visible. */
export function cardInProjectScope(scope: ProjectScope, cardId: string) {
  return sql`EXISTS (
    SELECT 1 FROM cards c
    JOIN boards b ON b.id = c.board_id
    JOIN projects p ON p.id = b.project_id
    JOIN board_columns col ON col.id = c.column_id AND col.board_id = c.board_id
    JOIN notepads n ON n.id = c.notepad_id
    WHERE c.id = ${cardId}
      AND p.id = ${scope.projectId} AND p.workspace_id = ${scope.workspaceId}
      AND b.workspace_id = p.workspace_id
      AND n.project_id = p.id AND n.workspace_id = p.workspace_id
      AND n.kind = 'card'
  )`;
}
