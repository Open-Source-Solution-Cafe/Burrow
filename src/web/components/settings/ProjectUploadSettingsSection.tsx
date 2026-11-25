import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useSystemVersion } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { useUpdateUploadPolicy, useUploadPolicy } from '../../lib/uploadPolicy';
import { MAX_UPLOAD_BYTES, UPLOAD_FILE_TYPES } from '../../../shared/uploadPolicy';

export function ProjectUploadSettingsSection({
  id = 'uploads',
  workspaceId,
  projectId,
  canEdit,
}: {
  id?: string;
  workspaceId: string;
  projectId: string;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const policy = useUploadPolicy(workspaceId, projectId);
  const update = useUpdateUploadPolicy(workspaceId, projectId);
  const systemVersion = useSystemVersion();
  const maxSupportedUploadBytes = systemVersion.data?.maxUploadBytes ?? MAX_UPLOAD_BYTES;
  const maxSupportedMb = maxSupportedUploadBytes / (1024 * 1024);
  const [sizeMb, setSizeMb] = useState('');
  const [allowedTypes, setAllowedTypes] = useState<string[]>([]);

  useEffect(() => {
    if (!policy.data) return;
    setSizeMb(String(policy.data.maxFileSizeBytes / (1024 * 1024)));
    setAllowedTypes(policy.data.allowedMimeTypes);
  }, [policy.data]);

  return (
    <section id={id} className="pt-5 border-t border-[var(--hair)] space-y-3">
      <h3 className="text-sm font-semibold text-[var(--text)]">{t('settings.fileUploadsTitle')}</h3>
      <p className="text-xs text-[var(--muted)]">{t('settings.fileUploadsDesc')}</p>
      {policy.isPending ? (
        <p className="text-xs text-[var(--muted)]">{t('common.loading')}</p>
      ) : policy.isError ? (
        <div className="text-xs text-[var(--danger)]">
          <p>{t('common.error')}</p>
          <Button type="button" variant="ghost" onClick={() => void policy.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <>
          <label className="block space-y-1.5 text-xs font-medium text-[var(--text)]">
            <span>
              {t('settings.maxFileSizeMb')}{' '}
              <span className="font-normal text-[var(--muted)]">(max {maxSupportedMb} MB)</span>
            </span>
            <Input
              type="number"
              min="0.01"
              max={maxSupportedMb}
              step="any"
              value={sizeMb}
              onChange={(event) => setSizeMb(event.target.value)}
              disabled={!canEdit || update.isPending}
              className="w-32"
            />
          </label>
          <fieldset disabled={!canEdit || update.isPending} className="space-y-2">
            <legend className="mb-2 text-xs font-medium text-[var(--text)]">
              {t('settings.allowedFileTypes')}
            </legend>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {UPLOAD_FILE_TYPES.map((type) => (
                <label
                  key={type.mimeType}
                  className="flex items-center gap-2 text-xs text-[var(--text)]"
                >
                  <input
                    type="checkbox"
                    checked={allowedTypes.includes(type.mimeType)}
                    onChange={(event) =>
                      setAllowedTypes((types) =>
                        event.target.checked
                          ? [...types, type.mimeType]
                          : types.filter((mime) => mime !== type.mimeType),
                      )
                    }
                  />
                  {type.label}
                </label>
              ))}
            </div>
          </fieldset>
          {canEdit ? (
            <Button
              type="button"
              variant="primary"
              disabled={update.isPending}
              onClick={async () => {
                const maxFileSizeBytes = Math.round(Number(sizeMb) * 1024 * 1024);
                if (
                  !Number.isFinite(maxFileSizeBytes) ||
                  maxFileSizeBytes < 1 ||
                  maxFileSizeBytes > maxSupportedUploadBytes
                ) {
                  toast.error(`Enter a file size between 0.01 and ${maxSupportedMb} MB`);
                  return;
                }
                if (!allowedTypes.length) {
                  toast.error('Choose at least one allowed file type');
                  return;
                }
                try {
                  await update.mutateAsync({ maxFileSizeBytes, allowedMimeTypes: allowedTypes });
                  toast.success('Upload settings saved');
                } catch {
                  /* The mutation displays the server error. */
                }
              }}
            >
              {update.isPending ? t('common.loading') : t('settings.saveUploadSettings')}
            </Button>
          ) : (
            <p className="text-xs text-[var(--muted)]">{t('settings.ownerUploadOnly')}</p>
          )}
        </>
      )}
    </section>
  );
}
