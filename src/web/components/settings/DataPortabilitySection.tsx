import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { BlockNoteEditor } from '@blocknote/core';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArchiveRestore,
  CheckCircle2,
  Download,
  FileArchive,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchWorkspaceFeatureFlags,
  useAccount,
  useFeatureFlags,
  useProjects,
} from '../../lib/queries';
import { workspaceProfileTarget, workspaceSettingsTarget } from '../../lib/workspaceRoutes';
import { schema } from '../../editor/schema';
import {
  buildMultiWorkspaceExportZip,
  buildWorkspaceExportZip,
  type ExportManifestProject,
  type WorkspaceExportManifest,
} from '../../lib/markdownPortability';
import {
  analyzeImportZip,
  convertNotionMarkdownToBlocksJson,
  type ImportArchiveAnalysis,
} from '../../lib/notionImporter';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';

function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'mp4') return 'video/mp4';
  if (ext === 'mp3') return 'audio/mpeg';
  return 'application/octet-stream';
}

function projectManifestToImportData(project: ExportManifestProject) {
  const tagById = new Map(project.tags.map((t) => [t.id, t.name]));
  return {
    ...(project.uploadPolicy ? { uploadPolicy: project.uploadPolicy } : {}),
    tags: project.tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
    notepads: project.notepads.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      title: n.title,
      icon: n.icon,
      content: n.content,
      isFavorite: n.isFavorite,
      tagNames: n.tagIds.map((id) => tagById.get(id)).filter((x): x is string => Boolean(x)),
    })),
    boards: project.boards.map((b) => ({
      id: b.id,
      name: b.name,
      icon: b.icon,
      columns: b.columns.map((c) => ({
        name: c.name,
        color: c.color,
        wipLimit: c.wipLimit,
      })),
      cards: b.columns.flatMap((col) =>
        col.cards.map((card) => ({
          id: card.id,
          columnName: col.name,
          title: card.title,
          content: card.content,
          priority: card.priority,
          dueDate: card.dueDate,
          tagNames: card.tags.map((t) => t.name),
          subtasks: card.subtasks.map((s) => ({
            title: s.title,
            completed: s.completed,
          })),
        })),
      ),
    })),
  };
}

export function DataPortabilitySection({
  workspaceId,
  workspaceName,
  role,
}: {
  workspaceId: string;
  workspaceName: string;
  role?: 'owner' | 'editor' | 'viewer';
}) {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const { data: featureFlagsData } = useFeatureFlags(workspaceId);
  const { data: projects = [] } = useProjects(workspaceId);
  const flags = featureFlagsData?.flags;

  const canExport = Boolean(flags?.workspaceExport || flags?.instanceMigration);
  const canImport = Boolean(
    flags?.notionImport || flags?.workspaceExport || flags?.instanceMigration,
  );
  const canMigrate = Boolean(flags?.instanceMigration);

  const ownedWorkspaces = (account?.workspaces ?? []).filter((w) => w.role === 'owner');
  const hasNonOwnedWorkspaces = (account?.workspaces ?? []).some((w) => w.role !== 'owner');
  const ownedFlagQueries = useQueries({
    queries: ownedWorkspaces.map((w) => ({
      queryKey: ['feature-flags', w.id] as const,
      queryFn: () => fetchWorkspaceFeatureFlags(w.id),
      enabled: role === 'owner' && canExport,
      staleTime: 30_000,
    })),
  });

  const [includeMedia, setIncludeMedia] = useState(true);
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<string[]>([workspaceId]);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [analysis, setAnalysis] = useState<ImportArchiveAnalysis | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSelectedWorkspaceIds([workspaceId]);
  }, [workspaceId]);

  if (!canExport && !canImport && !canMigrate) {
    return null;
  }

  const exportableByWorkspaceId = new Map<string, boolean>();
  const flagsLoadingByWorkspaceId = new Map<string, boolean>();
  ownedWorkspaces.forEach((w, idx) => {
    const q = ownedFlagQueries[idx];
    const resolvedFlags = q?.data?.flags ?? (w.id === workspaceId ? flags : undefined);
    const enabled = Boolean(resolvedFlags?.workspaceExport || resolvedFlags?.instanceMigration);
    exportableByWorkspaceId.set(w.id, enabled);
    flagsLoadingByWorkspaceId.set(w.id, Boolean(q?.isLoading) && !resolvedFlags);
  });

  const allExportableIds = ownedWorkspaces
    .filter((w) => exportableByWorkspaceId.get(w.id))
    .map((w) => w.id);
  const selectedExportableIds = ownedWorkspaces
    .map((w) => w.id)
    .filter((id) => selectedWorkspaceIds.includes(id) && exportableByWorkspaceId.get(id));

  const targetProjectId = selectedProjectId || projects[0]?.id || '';

  const triggerZipDownload = (zipBytes: Uint8Array, filename: string) => {
    const blob = new Blob([zipBytes as unknown as BlobPart], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleExportZip = async (scope: 'workspace' | 'project') => {
    setExportProgress('Fetching workspace data…');
    try {
      const dateStr = new Date().toISOString().slice(0, 10);
      if (scope === 'project') {
        const qs = targetProjectId ? `?projectId=${encodeURIComponent(targetProjectId)}` : '';
        const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/export${qs}`);
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
          throw new Error(err.error?.message || 'Failed to export project');
        }
        const manifest = (await res.json()) as WorkspaceExportManifest;
        const zipBytes = await buildWorkspaceExportZip(manifest, {
          includeMedia,
          onProgress: (msg) => setExportProgress(msg),
        });
        const safeName = workspaceName.replace(/[\\/:*?"<>|]/g, '-') || 'burrow-workspace';
        triggerZipDownload(zipBytes, `${safeName}-export-${dateStr}.zip`);
        toast.success('Project export ZIP downloaded');
        return;
      }

      if (selectedExportableIds.length === 0) {
        throw new Error('Select at least one exportable workspace');
      }

      const manifests: WorkspaceExportManifest[] = [];
      for (let i = 0; i < selectedExportableIds.length; i++) {
        const wid = selectedExportableIds[i]!;
        const wName = ownedWorkspaces.find((w) => w.id === wid)?.name || wid;
        setExportProgress(
          selectedExportableIds.length > 1
            ? `Fetching workspace ${i + 1}/${selectedExportableIds.length}: ${wName}…`
            : 'Fetching workspace data…',
        );
        const res = await fetch(`/api/workspaces/${encodeURIComponent(wid)}/export`);
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
          throw new Error(err.error?.message || `Failed to export workspace "${wName}"`);
        }
        manifests.push((await res.json()) as WorkspaceExportManifest);
      }

      const zipBytes = await buildMultiWorkspaceExportZip(manifests, {
        includeMedia,
        onProgress: (msg) => setExportProgress(msg),
      });
      if (manifests.length === 1) {
        const singleName =
          manifests[0]!.workspace.name.replace(/[\\/:*?"<>|]/g, '-') || 'burrow-workspace';
        triggerZipDownload(zipBytes, `${singleName}-export-${dateStr}.zip`);
        toast.success('Workspace export ZIP downloaded');
      } else {
        triggerZipDownload(zipBytes, `burrow-workspaces-export-${dateStr}.zip`);
        toast.success(`Exported ${manifests.length} workspaces to ZIP`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExportProgress(null);
    }
  };

  const handleSelectZip = async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = analyzeImportZip(bytes);
      setAnalysis(result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not read ZIP archive');
    }
  };

  const handleRunImport = async (mode: 'project' | 'new-workspace') => {
    if (!analysis) return;
    setImportBusy(true);
    setImportStatus('Preparing import…');
    try {
      if (mode === 'new-workspace' && (analysis.burrowManifests?.length || analysis.burrowManifest)) {
        if (!canMigrate) {
          throw new Error('Enable Instance Data Migration in Features & Labs first');
        }
        const manifestsToMigrate = analysis.burrowManifests?.length
          ? analysis.burrowManifests
          : [analysis.burrowManifest!];

        for (let i = 0; i < manifestsToMigrate.length; i++) {
          const manifest = manifestsToMigrate[i]!;
          setImportStatus(
            manifestsToMigrate.length > 1
              ? `Migrating workspace ${i + 1}/${manifestsToMigrate.length}: ${manifest.workspace.name}…`
              : 'Migrating workspace…',
          );
          const projectsPayload = manifest.projects.map((p) => ({
            name: p.name,
            icon: p.icon,
            color: p.color,
            data: projectManifestToImportData(p),
          }));

          const res = await fetch('/api/workspaces/import-bundle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              workspaceName: `${manifest.workspace.name} (Imported)`,
              sourceWorkspaceId: workspaceId,
              ...(manifest.workspace.featureFlags
                ? { featureFlags: manifest.workspace.featureFlags }
                : {}),
              projects: projectsPayload,
            }),
          });
          const out = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          if (!res.ok) throw new Error(out.error?.message || 'Migration import failed');
        }
        await queryClient.invalidateQueries({ queryKey: ['account'] });
        toast.success(
          manifestsToMigrate.length > 1
            ? `Migrated ${manifestsToMigrate.length} workspaces`
            : 'Workspace migrated into a new workspace',
        );
        setAnalysis(null);
        return;
      }

      if (!targetProjectId) throw new Error('Select a target project');

      if (analysis.kind === 'burrow-backup' && analysis.burrowManifest) {
        const firstProj = analysis.burrowManifest.projects[0];
        if (!firstProj) throw new Error('Backup contains no projects');
        const payload = projectManifestToImportData(firstProj);
        const res = await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(targetProjectId)}/import`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
        );
        const out = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        if (!res.ok) throw new Error(out.error?.message || 'Backup restore failed');
      } else if (analysis.kind === 'notion-zip' && analysis.notionData) {
        const uploadedUrlByFilename = new Map<string, string>();
        for (const media of analysis.notionData.mediaEntries) {
          setImportStatus(`Uploading media: ${media.filename}…`);
          const form = new FormData();
          const mime = guessMimeType(media.filename);
          form.append(
            'file',
            new File([media.bytes as unknown as BlobPart], media.filename, { type: mime }),
          );
          const upRes = await fetch(
            `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(targetProjectId)}/uploads`,
            { method: 'POST', body: form },
          );
          if (upRes.ok) {
            const upJson = (await upRes.json()) as { url?: string };
            if (upJson.url) uploadedUrlByFilename.set(media.filename, upJson.url);
          }
        }

        setImportStatus('Converting Markdown to BlockNote blocks…');
        const editor = BlockNoteEditor.create({ schema });
        const notepadsPayload = [];
        for (const np of analysis.notionData.notepads) {
          const content = await convertNotionMarkdownToBlocksJson(
            editor as any,
            np.markdown,
            np.title,
            uploadedUrlByFilename,
          );
          notepadsPayload.push({
            id: np.tempId,
            parentId: np.parentTempId,
            title: np.title,
            content,
          });
        }

        const boardsPayload = [];
        for (const b of analysis.notionData.boards) {
          const cardsPayload = [];
          for (const c of b.cards) {
            const content = await convertNotionMarkdownToBlocksJson(
              editor as any,
              c.markdown,
              c.title,
              uploadedUrlByFilename,
            );
            cardsPayload.push({
              columnName: c.columnName,
              title: c.title,
              content,
              priority: c.priority,
              dueDate: c.dueDate,
              tagNames: c.tagNames,
            });
          }
          boardsPayload.push({
            name: b.name,
            columns: b.columns,
            cards: cardsPayload,
          });
        }

        setImportStatus('Saving imported items…');
        const res = await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(targetProjectId)}/import`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tags: [],
              notepads: notepadsPayload,
              boards: boardsPayload,
            }),
          },
        );
        const out = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        if (!res.ok) throw new Error(out.error?.message || 'Notion import failed');
      }

      await queryClient.invalidateQueries({ queryKey: ['notepads', workspaceId, targetProjectId] });
      await queryClient.invalidateQueries({ queryKey: ['boards', workspaceId, targetProjectId] });
      toast.success('Import completed successfully');
      setAnalysis(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImportBusy(false);
      setImportStatus(null);
    }
  };

  return (
    <div className="chamfer-sm border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-5 space-y-5">
      <div className="flex items-center gap-2 border-b border-[var(--hair)] pb-3">
        <FileArchive className="w-4 h-4 text-[var(--accent)]" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">
          Data Portability (Export, Notion Import &amp; Migration)
        </h2>
      </div>

      {/* Export Block */}
      {canExport && (
        <div className="space-y-2.5">
          <div className="text-xs font-semibold text-[var(--text)]">
            One-Click Full Export (.zip)
          </div>
          {role === 'owner' ? (
            <>
              <p className="text-xs text-[var(--muted)]">
                Exports human-readable Markdown (<code>.md</code>), Kanban CSVs (<code>.csv</code>),
                project media files, and a lossless <code>burrow-backup.json</code> archive for exact
                restore or instance migration.
              </p>

              {ownedWorkspaces.length > 0 && (
                <div className="p-3 border border-[var(--line)] bg-[var(--surface2)] space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text)]">
                      Workspaces to Export
                    </span>
                    {ownedWorkspaces.length > 1 && (
                      <div className="flex items-center gap-2 text-[11px]">
                        <button
                          type="button"
                          disabled={Boolean(exportProgress) || allExportableIds.length === 0}
                          onClick={() => setSelectedWorkspaceIds(allExportableIds)}
                          className="text-[var(--accent)] hover:underline cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Select All Exportable
                        </button>
                        <span className="text-[var(--line)]">|</span>
                        <button
                          type="button"
                          disabled={Boolean(exportProgress)}
                          onClick={() => setSelectedWorkspaceIds([workspaceId])}
                          className="text-[var(--muted)] hover:text-[var(--text)] hover:underline cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Current Workspace Only
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                    {ownedWorkspaces.map((w) => {
                      const isExportEnabled = Boolean(exportableByWorkspaceId.get(w.id));
                      const isLoadingFlags = Boolean(flagsLoadingByWorkspaceId.get(w.id));
                      const isChecked = isExportEnabled && selectedWorkspaceIds.includes(w.id);

                      return (
                        <div
                          key={w.id}
                          className="flex items-center justify-between gap-2 text-xs py-0.5"
                        >
                          <label
                            className={`flex items-center gap-2 min-w-0 ${
                              isExportEnabled && !exportProgress
                                ? 'text-[var(--text)] cursor-pointer'
                                : 'text-[var(--muted)] cursor-not-allowed'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              disabled={!isExportEnabled || Boolean(exportProgress)}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setSelectedWorkspaceIds((prev) =>
                                  checked
                                    ? Array.from(new Set([...prev, w.id]))
                                    : prev.filter((id) => id !== w.id),
                                );
                              }}
                            />
                            <span className="truncate font-medium">{w.name}</span>
                            {w.id === workspaceId && (
                              <Badge className="text-[10px] font-mono uppercase shrink-0">
                                Current
                              </Badge>
                            )}
                          </label>

                          {isLoadingFlags ? (
                            <span className="text-[11px] text-[var(--muted)] shrink-0">
                              Checking…
                            </span>
                          ) : (
                            !isExportEnabled && (
                              <Link
                                {...workspaceSettingsTarget(w.id)}
                                hash="features"
                                className="text-[11px] text-[var(--accent)] underline hover:opacity-80 shrink-0"
                              >
                                Enable in Workspace Settings → Features &amp; Labs
                              </Link>
                            )
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {hasNonOwnedWorkspaces && (
                    <p className="text-[11px] text-[var(--muted)] pt-1 border-t border-[var(--hair)]">
                      Only workspaces where you are an owner can be selected for full workspace ZIP
                      export.
                    </p>
                  )}
                </div>
              )}

              <label className="flex items-center gap-2 text-xs text-[var(--text)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeMedia}
                  onChange={(e) => setIncludeMedia(e.target.checked)}
                  disabled={Boolean(exportProgress)}
                />
                <span>Include uploaded media attachments in ZIP</span>
              </label>
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={Boolean(exportProgress) || selectedExportableIds.length === 0}
                  onClick={() => void handleExportZip('workspace')}
                  className="flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>
                    {exportProgress ||
                      (selectedExportableIds.length > 1
                        ? `Export ${selectedExportableIds.length} Selected Workspaces (.zip)`
                        : selectedExportableIds.length === 1 && selectedExportableIds[0] !== workspaceId
                          ? 'Export Selected Workspace (.zip)'
                          : 'Export Full Workspace (.zip)')}
                  </span>
                </Button>
                {targetProjectId && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={Boolean(exportProgress)}
                    onClick={() => void handleExportZip('project')}
                    className="flex items-center gap-1.5"
                  >
                    <ArchiveRestore className="w-3.5 h-3.5" />
                    <span>Export Current Project (.zip)</span>
                  </Button>
                )}
              </div>
            </>
          ) : (
            <p className="text-xs text-[var(--muted)]">
              Workspace and project ZIP exports are restricted to workspace owners. You can still
              export your own personal data (profile, memberships, assigned tasks, authored comments,
              and notifications) anytime in{' '}
              <Link
                {...workspaceProfileTarget(workspaceId)}
                className="text-[var(--accent)] font-semibold underline hover:opacity-80"
              >
                Profile &amp; Account
              </Link>
              .
            </p>
          )}
        </div>
      )}

      {/* Import Block */}
      {(canImport || canMigrate) && role !== 'viewer' && (
        <div className="pt-4 border-t border-[var(--hair)] space-y-3">
          <div className="text-xs font-semibold text-[var(--text)]">
            Import Notion ZIP or Burrow Backup (.zip)
          </div>
          <p className="text-xs text-[var(--muted)]">
            Upload a Notion export (<em>Settings → Export all workspace content → Markdown &amp; CSV</em>)
            or a <code>burrow-backup.json</code> ZIP archive.
          </p>

          <div className="flex items-center gap-2 flex-wrap">
            {projects.length > 0 && (
              <Select
                value={targetProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                className="w-auto text-xs"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    Target: {p.icon || '📁'} {p.name}
                  </option>
                ))}
              </Select>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleSelectZip(file);
                e.target.value = '';
              }}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={importBusy}
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Select ZIP Archive…</span>
            </Button>
          </div>

          {analysis && (
            <div className="p-3 border border-[var(--line)] bg-[var(--surface2)] space-y-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-[var(--text)] flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-[var(--accent)]" />
                  <span>
                    {analysis.kind === 'burrow-backup'
                      ? 'Lossless Burrow Backup Detected'
                      : 'Notion Markdown + CSV Export Detected'}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setAnalysis(null)}
                  className="text-[var(--muted)] hover:text-[var(--text)] underline cursor-pointer"
                >
                  Clear
                </button>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="p-2 border border-[var(--line)] bg-[var(--surface)]">
                  <div className="text-[10px] text-[var(--muted)] uppercase">Notepads</div>
                  <div className="font-mono font-bold text-[var(--text)]">
                    {analysis.notepadsCount}
                  </div>
                </div>
                <div className="p-2 border border-[var(--line)] bg-[var(--surface)]">
                  <div className="text-[10px] text-[var(--muted)] uppercase">Boards</div>
                  <div className="font-mono font-bold text-[var(--text)]">
                    {analysis.boardsCount}
                  </div>
                </div>
                <div className="p-2 border border-[var(--line)] bg-[var(--surface)]">
                  <div className="text-[10px] text-[var(--muted)] uppercase">Cards</div>
                  <div className="font-mono font-bold text-[var(--text)]">
                    {analysis.cardsCount}
                  </div>
                </div>
                <div className="p-2 border border-[var(--line)] bg-[var(--surface)]">
                  <div className="text-[10px] text-[var(--muted)] uppercase">Media</div>
                  <div className="font-mono font-bold text-[var(--text)]">
                    {analysis.mediaCount}
                  </div>
                </div>
              </div>

              <div className="space-y-1 text-[11px] text-[var(--muted)]">
                <div className="font-semibold text-[var(--text)] flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3 text-[var(--c2)]" />
                  <span>Compatibility &amp; Scope Notes:</span>
                </div>
                <ul className="list-disc pl-4 space-y-0.5">
                  {analysis.limitations.map((note, idx) => (
                    <li key={idx}>{note}</li>
                  ))}
                </ul>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                {targetProjectId && (
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    disabled={importBusy}
                    onClick={() => void handleRunImport('project')}
                  >
                    {importBusy ? importStatus || 'Importing…' : 'Import into Selected Project'}
                  </Button>
                )}
                {analysis.kind === 'burrow-backup' && canMigrate && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={importBusy}
                    onClick={() => void handleRunImport('new-workspace')}
                  >
                    {importBusy ? importStatus || 'Migrating…' : 'Migrate as New Workspace'}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
