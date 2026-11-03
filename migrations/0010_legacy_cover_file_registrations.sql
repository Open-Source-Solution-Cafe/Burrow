WITH cover_sources AS (
  SELECT n.project_id, n.cover_key, n.created_by, n.created_at,
    row_number() OVER (
      PARTITION BY n.project_id, n.cover_key ORDER BY n.created_at, n.id
    ) AS cover_order
  FROM notepads n
  JOIN projects p ON p.id = n.project_id AND p.workspace_id = n.workspace_id
  WHERE n.cover_key IS NOT NULL
    AND n.cover_key <> ''
    AND substr(n.cover_key, 1, length(n.workspace_id) + 1) = n.workspace_id || '/'
    AND instr(n.cover_key, char(92)) = 0
    AND instr(n.cover_key, '//') = 0
    AND instr(n.cover_key, '/../') = 0
    AND substr(n.cover_key, -3) <> '/..'
)
INSERT INTO project_files (project_id, storage_key, content_type, created_by, created_at)
SELECT n.project_id, n.cover_key,
  CASE
    WHEN lower(n.cover_key) LIKE '%.png' THEN 'image/png'
    WHEN lower(n.cover_key) LIKE '%.jpg' OR lower(n.cover_key) LIKE '%.jpeg' THEN 'image/jpeg'
    WHEN lower(n.cover_key) LIKE '%.webp' THEN 'image/webp'
    WHEN lower(n.cover_key) LIKE '%.gif' THEN 'image/gif'
    WHEN lower(n.cover_key) LIKE '%.svg' THEN 'image/svg+xml'
    ELSE 'application/octet-stream'
  END,
  n.created_by, n.created_at
FROM cover_sources n
WHERE n.cover_order = 1
ON CONFLICT (project_id, storage_key) DO NOTHING;
