import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ModalShell } from '../components/ui/ModalShell';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { MediaUploadControl, ProjectMediaBrowser } from '../components/media/ProjectMediaLibrary';
import { parseMediaUrl } from './mediaUrl';
import { useTranslation } from '../lib/i18n';

export type MediaSelection =
  { kind: 'image' | 'file'; url: string; name?: string } | NonNullable<ReturnType<typeof parseMediaUrl>>;

export function MediaPicker({
  workspaceId,
  projectId,
  onSelect,
  onClose,
}: {
  workspaceId: string;
  projectId: string;
  onSelect: (selection: MediaSelection) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState('upload');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const select = (selection: MediaSelection) => {
    if (!active.current) return;
    try {
      onSelect(selection);
      onClose();
    } catch {
      toast.error(t('editor.couldNotInsertMedia'));
    }
  };
  return (
    <ModalShell open onClose={busy ? undefined : onClose} title={t('editor.insertMedia')}>
      <div className="space-y-4">
        <SegmentedControl
          value={tab}
          onValueChange={(value) => {
            if (!busy) setTab(value);
          }}
          fullWidth
          options={[
            { value: 'upload', label: t('media.upload') },
            { value: 'library', label: t('editor.projectLibrary') },
            { value: 'link', label: t('editor.link') },
          ]}
        />
        {tab === 'upload' && (
          <MediaUploadControl
            workspaceId={workspaceId}
            projectId={projectId}
            onBusyChange={setBusy}
            onUploaded={(file) => select({ kind: file.contentType.startsWith('image/') ? 'image' : 'file', ...file })}
          />
        )}
        {tab === 'library' && (
          <ProjectMediaBrowser
            workspaceId={workspaceId}
            projectId={projectId}
            onSelect={(item) =>
              select({ kind: item.contentType.startsWith('image/') ? 'image' : 'file', url: item.url, name: item.filename || undefined })
            }
          />
        )}
        {tab === 'link' && (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const selection = parseMediaUrl(url);
              if (!selection) {
                toast.error(t('editor.validUrlPrompt'));
                return;
              }
              select(selection);
            }}
          >
            <Input
              aria-label={t('editor.link')}
              placeholder="https://www.youtube.com/watch?v=…"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <p className="text-xs text-[var(--muted)]">
              {t('editor.youtubeInlineNote')}
            </p>
            <Button type="submit" disabled={!url.trim()}>
              {t('editor.insertLink')}
            </Button>
          </form>
        )}
        <Button onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </Button>
      </div>
    </ModalShell>
  );
}
