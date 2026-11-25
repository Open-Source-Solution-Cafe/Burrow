import { useState, type FormEvent } from 'react';
import { Check, Plus, Tag, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Input } from '../ui/Input';
import { StatusDiamond } from '../ui/StatusDiamond';
import { useTranslation } from '../../lib/i18n';
import { useCreateTag, useDeleteTag, useProjectTags } from '../../lib/queries';
import { COLOR_PRESETS, SettingsCard, SettingsCardHeader } from './SettingsCard';

export function ProjectTagManagementCard({
  workspaceId,
  projectId,
  projectName,
  isViewer,
}: {
  workspaceId: string;
  projectId: string;
  projectName: string;
  isViewer: boolean;
}) {
  const { t } = useTranslation();
  const { data: projectTags = [] } = useProjectTags(workspaceId, projectId);
  const createTagMutation = useCreateTag();
  const deleteTagMutation = useDeleteTag();
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState<string>('#6366f1');
  const [tagToDelete, setTagToDelete] = useState<{ id: string; name: string } | null>(null);

  const handleCreateTag = async (e: FormEvent) => {
    e.preventDefault();
    if (isViewer || !newTagName.trim()) return;
    try {
      await createTagMutation.mutateAsync({
        workspaceId,
        projectId,
        name: newTagName.trim(),
        color: newTagColor,
      });
      setNewTagName('');
      toast.success(t('settings.tagCreated'));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to create tag');
    }
  };

  const handleDeleteTag = async () => {
    if (!tagToDelete || isViewer) return;
    try {
      await deleteTagMutation.mutateAsync({
        workspaceId,
        tagId: tagToDelete.id,
        projectId,
      });
      toast.success(t('settings.tagDeleted'));
      setTagToDelete(null);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete tag');
    }
  };

  return (
    <>
      <SettingsCard id="tags">
        <SettingsCardHeader
          icon={<Tag className="w-4 h-4 text-[var(--accent)]" />}
          title={t('settings.tagManagementTitle')}
        />

        <p className="text-xs text-[var(--muted)]">
          {t('settings.tagManagementDesc', { projectName })}
        </p>

        {!isViewer && (
          <form
            onSubmit={handleCreateTag}
            className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2"
          >
            <Input
              type="text"
              required
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              placeholder={t('settings.newTagNamePlaceholder')}
              className="flex-1 min-w-[180px]"
            />
            <div className="flex items-center gap-1 self-start sm:self-center">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setNewTagColor(c)}
                  className={`w-6 h-6 flex items-center justify-center border transition cursor-pointer ${
                    newTagColor === c ? 'border-[var(--text)] scale-110' : 'border-transparent'
                  }`}
                  style={{ backgroundColor: c }}
                  title={c}
                >
                  {newTagColor === c && <Check className="w-3 h-3 text-white stroke-[3]" />}
                </button>
              ))}
            </div>
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={createTagMutation.isPending || !newTagName.trim()}
              className="flex items-center justify-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{createTagMutation.isPending ? t('common.saving') : t('settings.addTag')}</span>
            </Button>
          </form>
        )}

        <div className="space-y-2 pt-2">
          {projectTags.length === 0 ? (
            <div className="text-xs text-[var(--muted)] italic py-1">
              {t('settings.noTagsYet')}
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              {projectTags.map((tag) => (
                <div
                  key={tag.id}
                  className="flex items-center gap-1.5 px-2 py-1 h-7 border border-[var(--line)] bg-[var(--surface2)] text-xs font-medium text-[var(--text)] select-none"
                >
                  <StatusDiamond color={tag.color || '#6366f1'} size={7} />
                  <span>#{tag.name}</span>
                  {!isViewer && (
                    <button
                      type="button"
                      onClick={() => setTagToDelete({ id: tag.id, name: tag.name })}
                      className="text-[var(--muted)] hover:text-[var(--danger)] transition ml-1 p-0.5 cursor-pointer"
                      title={`${t('common.delete')} #${tag.name}`}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </SettingsCard>

      {tagToDelete && (
        <ConfirmDialog
          open
          title={t('settings.confirmDeleteTagTitle')}
          message={t('settings.confirmDeleteTagMessage', { name: tagToDelete.name })}
          confirmLabel={t('common.delete')}
          danger={true}
          busy={deleteTagMutation.isPending}
          onConfirm={handleDeleteTag}
          onCancel={() => setTagToDelete(null)}
        />
      )}
    </>
  );
}
