-- One query per invariant (PLAN.md section 6.1), adapted to PostgreSQL's schema.
-- Each query returns OFFENDING rows. Keep comments on their own lines because
-- the check:data runner splits statements on ';'.

-- I1: every cards.notepad_id points to a notepad with kind='card', and every
--      kind='card' notepad has exactly one card.
SELECT 'I1' AS invariant, c.id AS subject, 'card without kind=card notepad' AS detail
FROM cards c LEFT JOIN notepads n ON n.id = c.notepad_id
WHERE n.id IS NULL OR n.kind <> 'card'
UNION ALL
SELECT 'I1', n.id, 'card notepad without card row'
FROM notepads n LEFT JOIN cards c ON c.notepad_id = n.id
WHERE n.kind = 'card' AND c.id IS NULL;

-- I2: card notepads are never part of the notepad tree.
SELECT 'I2' AS invariant, id AS subject, 'card notepad has parent_id' AS detail
FROM notepads
WHERE kind = 'card' AND parent_id IS NOT NULL;

-- I3: boards agree with their project; card board, column and body agree too.
SELECT 'I3' AS invariant, b.id AS subject, 'board workspace != project workspace' AS detail
FROM boards b LEFT JOIN projects p ON p.id = b.project_id
WHERE p.id IS NULL OR b.workspace_id <> p.workspace_id
UNION ALL
SELECT 'I3', c.id, 'board/column/project/body mismatch'
FROM cards c
LEFT JOIN board_columns col ON col.id = c.column_id
LEFT JOIN boards b ON b.id = c.board_id
LEFT JOIN projects p ON p.id = b.project_id
LEFT JOIN notepads n ON n.id = c.notepad_id
WHERE col.id IS NULL OR b.id IS NULL OR p.id IS NULL OR n.id IS NULL
  OR col.board_id <> c.board_id OR b.workspace_id <> p.workspace_id
  OR n.project_id <> p.id OR n.workspace_id <> p.workspace_id OR n.kind <> 'card';

-- I4: notepad/parent share a project; workspace_id matches the project's workspace.
SELECT 'I4' AS invariant, n.id AS subject, 'notepad workspace != project workspace' AS detail
FROM notepads n LEFT JOIN projects p ON p.id = n.project_id
WHERE p.id IS NULL OR n.workspace_id <> p.workspace_id
UNION ALL
SELECT 'I4', n.id, 'notepad project != parent project'
FROM notepads n LEFT JOIN notepads pa ON pa.id = n.parent_id
WHERE n.parent_id IS NOT NULL
  AND (pa.id IS NULL OR n.project_id <> pa.project_id OR n.workspace_id <> pa.workspace_id);

-- I5: card and notepad share soft-delete state; the state lives on the notepad,
--      so divergence is only possible if their pair is broken.
SELECT 'I5' AS invariant, c.id AS subject, 'card/notepad pair broken' AS detail
FROM cards c LEFT JOIN notepads n ON n.id = c.notepad_id
WHERE n.id IS NULL OR n.kind <> 'card';

-- I6: a non-deleted notepad has no deleted ancestors.
SELECT 'I6' AS invariant, n.id AS subject, 'deleted ancestor' AS detail
FROM notepads n JOIN notepads pa ON pa.id = n.parent_id
WHERE n.deleted_at IS NULL AND pa.deleted_at IS NOT NULL;

-- I7: PostgreSQL stores its generated tsvector on each notepad row rather than
--      in SQLite's separate notepads_fts table. A missing vector is an offender.
SELECT 'I7' AS invariant, id AS subject, 'missing search vector' AS detail
FROM notepads
WHERE search_vector IS NULL;

-- I8: notepad_links.source_id always references an existing notepad.
SELECT 'I8' AS invariant, l.source_id AS subject,
       CAST(l.target_type AS TEXT) || ':' || l.target_id AS detail
FROM notepad_links l LEFT JOIN notepads n ON n.id = l.source_id
WHERE n.id IS NULL;

-- I9: tag and notepad share a project (including tags on card notepads).
SELECT 'I9' AS invariant, nt.notepad_id AS subject,
       coalesce(t.project_id, 'missing tag') || ' != ' || coalesce(n.project_id, 'missing notepad') AS detail
FROM notepad_tags nt
LEFT JOIN tags t ON t.id = nt.tag_id
LEFT JOIN notepads n ON n.id = nt.notepad_id
WHERE t.id IS NULL OR n.id IS NULL OR t.project_id <> n.project_id;

-- I10: every assignee is a current member of the card's workspace.
SELECT 'I10' AS invariant, ca.card_id AS subject, ca.user_id AS detail
FROM card_assignees ca
LEFT JOIN cards c ON c.id = ca.card_id
LEFT JOIN boards b ON b.id = c.board_id
LEFT JOIN members m ON m.user_id = ca.user_id AND m.workspace_id = b.workspace_id
WHERE c.id IS NULL OR b.id IS NULL OR m.user_id IS NULL;

-- I11: persisted content-reference edges resolve inside the source project.
SELECT 'I11' AS invariant, l.source_id AS subject,
       CAST(l.target_type AS TEXT) || ':' || l.target_id AS detail
FROM notepad_links l
LEFT JOIN notepads source ON source.id = l.source_id
LEFT JOIN notepads target ON target.id = l.target_id
WHERE l.target_type = 'notepad'
  AND (source.id IS NULL OR target.id IS NULL OR target.project_id <> source.project_id
    OR target.workspace_id <> source.workspace_id)
UNION ALL
SELECT 'I11', l.source_id, CAST(l.target_type AS TEXT) || ':' || l.target_id
FROM notepad_links l
LEFT JOIN notepads source ON source.id = l.source_id
LEFT JOIN cards c ON c.id = l.target_id
LEFT JOIN boards b ON b.id = c.board_id
LEFT JOIN projects p ON p.id = b.project_id
LEFT JOIN board_columns col ON col.id = c.column_id
LEFT JOIN notepads body ON body.id = c.notepad_id
WHERE l.target_type = 'card'
  AND (source.id IS NULL OR c.id IS NULL OR b.id IS NULL OR p.id IS NULL
    OR col.id IS NULL OR col.board_id <> c.board_id OR body.id IS NULL
    OR p.id <> source.project_id OR b.workspace_id <> source.workspace_id
    OR body.project_id <> p.id OR body.workspace_id <> p.workspace_id OR body.kind <> 'card')
UNION ALL
SELECT 'I11', l.source_id, CAST(l.target_type AS TEXT) || ':' || l.target_id
FROM notepad_links l
LEFT JOIN notepads source ON source.id = l.source_id
LEFT JOIN boards b ON b.id = l.target_id
LEFT JOIN projects p ON p.id = b.project_id
WHERE l.target_type = 'board'
  AND (source.id IS NULL OR b.id IS NULL OR p.id IS NULL
    OR p.id <> source.project_id OR b.workspace_id <> source.workspace_id);

-- I12: parent edges and card/column edges cannot cross project/workspace/board scope.
SELECT 'I12' AS invariant, child.id AS subject, 'parent edge crosses project/workspace' AS detail
FROM notepads child
LEFT JOIN notepads parent ON parent.id = child.parent_id
WHERE child.parent_id IS NOT NULL
  AND (parent.id IS NULL OR child.project_id <> parent.project_id
    OR child.workspace_id <> parent.workspace_id)
UNION ALL
SELECT 'I12', c.id, 'card column belongs to another board'
FROM cards c
JOIN board_columns col ON col.id = c.column_id
WHERE col.board_id <> c.board_id;

-- I13: a cover reference must be safe, belong to the same workspace as its
--      project, and have a project-file registration for scoped resolution.
SELECT 'I13' AS invariant, n.id AS subject,
  CASE
    WHEN p.id IS NULL THEN 'cover has no project'
    WHEN n.workspace_id <> p.workspace_id THEN 'cover notepad workspace != project workspace'
    WHEN n.cover_key = '' THEN 'cover key is empty'
    WHEN substr(n.cover_key, 1, length(n.workspace_id) + 1) <> n.workspace_id || '/'
      THEN 'cover key workspace prefix mismatch'
    WHEN n.cover_key LIKE '%//%' OR n.cover_key LIKE '%/../%'
      OR n.cover_key LIKE '%/..'
      THEN 'cover key is not a safe storage key'
    WHEN pf.project_id IS NULL THEN 'cover key is not registered to project'
  END AS detail
FROM notepads n
LEFT JOIN projects p ON p.id = n.project_id
LEFT JOIN project_files pf ON pf.project_id = n.project_id AND pf.storage_key = n.cover_key
WHERE n.cover_key IS NOT NULL
  AND (p.id IS NULL OR n.workspace_id <> p.workspace_id OR n.cover_key = ''
    OR substr(n.cover_key, 1, length(n.workspace_id) + 1) <> n.workspace_id || '/'
    OR n.cover_key LIKE '%//%' OR n.cover_key LIKE '%/../%'
    OR n.cover_key LIKE '%/..'
    OR pf.project_id IS NULL);
