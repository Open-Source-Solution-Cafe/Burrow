import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Search, Upload } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useAccount } from '../../lib/queries';
import { projectMediaKey, useProjectMedia, type ProjectMediaItem } from '../../lib/projectMedia';
import { createMediaUploader } from '../../editor/mediaUpload';
import { useUploadPolicy } from '../../lib/uploadPolicy';
import { DEFAULT_UPLOAD_POLICY, UPLOAD_FILE_TYPES, getUploadFileType } from '../../../shared/uploadPolicy';
import { useTranslation } from '../../lib/i18n';

interface ProjectScope {
  workspaceId: string;
  projectId: string;
}

/** One upload control serves the project page and the editor picker. */
export function MediaUploadControl({
  workspaceId,
  projectId,
  onUploaded,
  onBusyChange,
  compact = false,
}: ProjectScope & {
  onUploaded?: (image: { url: string; name: string; contentType: string }) => void;
  onBusyChange?: (busy: boolean) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const { data: account } = useAccount();
  const membership = account?.workspaces.find((workspace) => workspace.id === workspaceId);
  const canUpload = Boolean(membership && membership.role !== 'viewer');
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const policyQuery = useUploadPolicy(workspaceId, projectId);
  const policy = policyQuery.data ?? DEFAULT_UPLOAD_POLICY;
  const accept = UPLOAD_FILE_TYPES.filter((type) => policy.allowedMimeTypes.includes(type.mimeType)).flatMap((type) => [type.mimeType, `.${type.extension}`]).join(',');
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  if (!canUpload) return null;
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => fileInput.current?.click()}
        className={`inline-flex min-h-10 items-center gap-2 border border-[var(--line)] bg-[var(--surface)] px-3 text-xs font-medium text-[var(--text)] theme-radius-xs focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--accent)] ${busy ? 'opacity-60' : 'cursor-pointer hover:bg-[var(--hi)]'}`}
      >
        <Upload className="w-3.5 h-3.5" />
        <span role={busy ? 'status' : undefined}>{busy ? t('media.uploading') : t('media.uploadFile')}</span>
      </button>
        <input
          ref={fileInput}
          hidden
          type="file"
          aria-label={t('media.uploadFile')}
          accept={accept}
          disabled={busy}
          onChange={async (event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (!file) return;
            const queryKey = projectMediaKey(account?.user.id, workspaceId, projectId);
            setBusy(true);
            onBusyChange?.(true);
            try {
              const upload = createMediaUploader({ workspaceId, projectId }, (message) =>
                toast.error(message), policyQuery.data,
              );
              const url = await upload(file);
              await queryClient.invalidateQueries({ queryKey });
              if (active.current) {
                if (onUploaded) {
                  try {
                    onUploaded({ url, name: file.name, contentType: getUploadFileType(file)?.mimeType ?? file.type });
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : t('media.couldNotInsert'));
                  }
                } else toast.success(t('media.fileAddedSuccess'));
              }
            } catch {
              // The canonical uploader reports failures to the user.
            } finally {
              if (active.current) {
                setBusy(false);
                onBusyChange?.(false);
              }
            }
          }}
        />
      {policyQuery.error && <p role="alert" className="text-xs">{t('media.couldNotLoadPolicy')} <button type="button" onClick={() => void policyQuery.refetch()}>{t('common.retry')}</button></p>}
      {!compact && (
        <p className="text-xs text-[var(--muted)]">{t('media.allowedSummary', { count: policy.allowedMimeTypes.length, sizeMb: policy.maxFileSizeBytes / (1024 * 1024) })}</p>
      )}
    </div>
  );
}

/** Browse the same project assets from either the dedicated page or the picker. */
export function ProjectMediaBrowser({
  workspaceId,
  projectId,
  onSelect,
}: ProjectScope & {
  onSelect?: (item: ProjectMediaItem) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const library = useProjectMedia(workspaceId, projectId);
  const images = library.data ?? [];
  const matches = images.filter((item) =>
    (item.filename || item.key).toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <div className="space-y-4">
      <div className={onSelect ? 'relative' : 'relative sm:max-w-xs'}>
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]"
        />
        <Input
          aria-label={t('media.searchFilesPlaceholder')}
          placeholder={t('media.searchFilesPlaceholder')}
          className="pl-9 text-sm"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {library.isPending && <p role="status">{t('media.loadingFiles')}</p>}
      {library.error && (
        <div role="alert">
          {library.error.message}{' '}
          <Button variant="secondary" onClick={() => library.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {library.isSuccess && matches.length === 0 && (
        <p className="text-sm text-[var(--muted)]">
          {images.length === 0
            ? t('media.noFilesYet')
            : t('media.noFilesMatch')}
        </p>
      )}
      <div
        className={`grid gap-x-5 gap-y-6 ${onSelect ? 'grid-cols-2 max-h-80 overflow-y-auto' : 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4'}`}
      >
        {matches.map((item) => {
          const name = item.filename || item.key.split('/').pop() || t('media.projectImageDefault');
          const content = (
            <>
              <div className="flex aspect-[4/3] items-center justify-center overflow-hidden border border-[var(--line)] bg-[var(--surface2)] theme-radius-xs transition-colors group-hover:border-[var(--muted)]">
                {item.contentType.startsWith('image/') ? <img
                  src={item.url}
                  alt={name}
                  loading="lazy"
                  className="h-full w-full object-contain p-2"
                /> : <span className="px-4 text-sm text-[var(--muted)] truncate">{name}</span>}
              </div>
              <div className="mt-2 flex items-baseline justify-between gap-2">
                <span className="truncate text-xs text-[var(--text)]" title={name}>
                  {name}
                </span>
                {item.byteSize !== null && (
                  <span className="shrink-0 text-[11px] text-[var(--muted)]">
                    {Math.ceil(item.byteSize / 1024)} KB
                  </span>
                )}
              </div>
            </>
          );
          const className =
            'group block min-w-0 text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)]';
          return onSelect ? (
            <button
              type="button"
              key={item.key}
              className={className}
              onClick={() => onSelect(item)}
            >
              {content}
            </button>
          ) : (
            <a
              key={item.key}
              className={className}
              href={item.url}
              aria-label={`Open ${name}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {content}
            </a>
          );
        })}
      </div>
    </div>
  );
}

export function ProjectMediaLibrary({ workspaceId, projectId }: ProjectScope) {
  const { t } = useTranslation();
  return (
    <section className="flex-1 min-h-0 overflow-y-auto p-6 md:p-10 space-y-8 w-full max-w-6xl mx-auto">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-display font-bold text-[var(--text)]">{t('media.projectLibraryTitle')}</h1>
          <p className="mt-1 text-xs text-[var(--muted)]">{t('media.projectLibrarySubtitle')}</p>
        </div>
        <MediaUploadControl
          key={`${workspaceId}/${projectId}`}
          workspaceId={workspaceId}
          projectId={projectId}
          compact
        />
      </header>
      <ProjectMediaBrowser
        key={`${workspaceId}/${projectId}`}
        workspaceId={workspaceId}
        projectId={projectId}
      />
    </section>
  );
}
