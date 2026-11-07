import { useState } from 'react';
import { Copy, Check, Trash2, UserPlus, KeyRound, ExternalLink, X } from 'lucide-react';
import { useAccount, useMembers, useInvites, useCreateInvite, useRevokeInvite } from '../lib/queries';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Avatar } from '../components/ui/Avatar';
import { Badge } from '../components/ui/Badge';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { toast } from 'sonner';
import { useParams } from '@tanstack/react-router';
import { useTranslation } from '../lib/i18n';
interface CreatedInviteInfo {
  url: string;
  token: string;
  email: string;
  role: string;
}

export function MembersSettings() {
  const { t } = useTranslation();
  const { workspaceId } = useParams({ strict: false }) as { workspaceId?: string };
  const { data: account } = useAccount();
  const { data: members = [], refetch: refetchMembers } = useMembers(workspaceId);
  const { data: invites = [] } = useInvites(workspaceId);
  const createInvite = useCreateInvite(workspaceId);
  const revokeInvite = useRevokeInvite(workspaceId);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor');
  const [createdInvite, setCreatedInvite] = useState<CreatedInviteInfo | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memberToRemove, setMemberToRemove] = useState<{ id: string; name: string } | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);

  const isOwner = account?.workspaces.find((workspace) => workspace.id === workspaceId)?.role === 'owner';

  const handleCreateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setError(null);

    try {
      const res = (await createInvite.mutateAsync({
        email: inviteEmail.trim(),
        role: inviteRole,
      })) as { url: string; token: string; email: string; role: string };
      setCreatedInvite({
        url: res.url,
        token: res.token,
        email: res.email,
        role: res.role,
      });
      setInviteEmail('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create invite');
    }
  };

  const handleCopyUrl = () => {
    if (createdInvite?.url) {
      navigator.clipboard.writeText(createdInvite.url);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    }
  };

  const handleCopyToken = () => {
    if (createdInvite?.token) {
      navigator.clipboard.writeText(createdInvite.token);
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 2000);
    }
  };

  const handleRoleChange = async (userId: string, newRole: 'owner' | 'editor' | 'viewer') => {
    setError(null);
    try {
      if (!workspaceId) throw new Error('Workspace is required');
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
        {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
        },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(data.error?.message || 'Failed to change role');
      }
      refetchMembers();
      toast.success('Role updated');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to change role';
      setError(msg);
      toast.error(msg);
    }
  };

  const handleRemoveMember = async () => {
    if (!memberToRemove) return;
    setError(null);
    setIsRemoving(true);
    try {
      if (!workspaceId) throw new Error('Workspace is required');
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberToRemove.id)}`,
        {
        method: 'DELETE',
        },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(data.error?.message || 'Failed to remove member');
      }
      toast.success('Member removed');
      refetchMembers();
      setMemberToRemove(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to remove member';
      setError(msg);
      toast.error(msg);
    } finally {
      setIsRemoving(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto py-6 px-4 sm:py-8 sm:px-6 space-y-6 sm:space-y-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text)]">
            {t('members.title')}
          </h1>
          <p className="text-sm text-[var(--muted)]">
            {t('members.subtitle')}
          </p>
        </div>

        {error && (
          <div className="p-3 text-xs bg-[var(--surface2)] text-[var(--text)] border border-[var(--line)] border-l-4 border-l-[var(--danger)]">
            {error}
          </div>
        )}

        {/* Invite Member Section (Owner only) */}
        {isOwner && (
          <div className="border border-[var(--line)] chamfer-sm bg-[var(--surface)] p-4 sm:p-5 space-y-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider flex items-center gap-2 text-[var(--text)]">
              <UserPlus className="w-4 h-4 text-[var(--accent)]" /> {t('members.inviteTeammate')}
            </h2>
            <form onSubmit={handleCreateInvite} className="flex flex-col sm:flex-row gap-2">
              <Input
                type="email"
                required
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder={t('members.teammateEmailPlaceholder')}
                autoComplete="email"
                inputMode="email"
                autoCapitalize="none"
                spellCheck="false"
                className="flex-1 min-w-[200px]"
              />
              <Select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'editor' | 'viewer')}
                className="w-auto"
              >
                <option value="editor">{t('common.roles.editor')}</option>
                <option value="viewer">{t('common.roles.viewer')}</option>
              </Select>
              <Button
                type="submit"
                variant="primary"
                size="md"
                disabled={createInvite.isPending}
                className="px-4 font-medium"
              >
                {createInvite.isPending ? t('members.invitingButton') : t('members.generateInvite')}
              </Button>
            </form>

            {createdInvite && (
              <div className="p-3.5 bg-[var(--surface2)] border border-[var(--line)] border-l-4 border-l-[var(--c4)] space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text)]">
                    <Check className="w-4 h-4 text-[var(--c4)]" />
                    <span>
                      {t('members.inviteCreatedSuccess', {
                        email: createdInvite.email,
                        role: t(`common.roles.${createdInvite.role as 'owner' | 'editor' | 'viewer'}`),
                      })}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCreatedInvite(null)}
                    className="text-[var(--muted)] hover:text-[var(--text)] p-0.5 cursor-pointer"
                    title={t('common.dismiss')}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Invite Link */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-[var(--muted)]">
                      {t('members.inviteLinkTitle')}
                    </span>
                    <a
                      href={createdInvite.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-[var(--accent)] hover:underline flex items-center gap-1"
                    >
                      {t('members.openLink')} <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  <div className="p-2 bg-[var(--surface)] border border-[var(--line)] flex items-center justify-between gap-3 text-xs">
                    <span className="truncate font-mono text-[var(--text)]">
                      {createdInvite.url}
                    </span>
                    <button
                      type="button"
                      onClick={handleCopyUrl}
                      className="flex items-center gap-1.5 shrink-0 px-2 py-1 h-7 border text-xs font-medium bg-[var(--surface2)] border-[var(--line)] hover:bg-[var(--hi)] text-[var(--text)] transition cursor-pointer"
                    >
                      {copiedUrl ? (
                        <Check className="w-3.5 h-3.5 text-[var(--c4)]" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      <span>{copiedUrl ? t('common.copied') : t('members.copyLink')}</span>
                    </button>
                  </div>
                </div>

                {/* Invite Token */}
                <div className="space-y-1">
                  <span className="text-[11px] font-medium text-[var(--muted)] flex items-center gap-1">
                    <KeyRound className="w-3 h-3 text-[var(--muted)]" /> {t('members.inviteTokenTitle')}
                  </span>
                  <div className="p-2 bg-[var(--surface)] border border-[var(--line)] flex items-center justify-between gap-3 text-xs">
                    <code className="font-mono font-semibold text-[var(--text)] select-all tracking-wider">
                      {createdInvite.token}
                    </code>
                    <button
                      type="button"
                      onClick={handleCopyToken}
                      className="flex items-center gap-1.5 shrink-0 px-2 py-1 h-7 border text-xs font-medium bg-[var(--surface2)] border-[var(--line)] hover:bg-[var(--hi)] text-[var(--text)] transition cursor-pointer"
                    >
                      {copiedToken ? (
                        <Check className="w-3.5 h-3.5 text-[var(--c4)]" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      <span>{copiedToken ? t('common.copied') : t('members.copyToken')}</span>
                    </button>
                  </div>
                </div>

                <p className="text-[11px] text-[var(--muted)]">
                  {t('members.inviteHelpNotice')}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Members List */}
        <div className="chamfer-sm border border-[var(--line)] bg-[var(--surface)] divide-y divide-[var(--hair)] overflow-hidden">
          <div className="px-4 py-2.5 text-xs font-semibold text-[var(--muted)] uppercase tracking-wider bg-[var(--surface2)]">
            {t('members.membersCount', { count: members.length })}
          </div>

          {members.map((member) => (
            <div
              key={member.userId}
              className="px-4 py-3 flex items-center justify-between gap-3 sm:gap-4"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <Avatar name={member.name} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-[var(--text)] truncate flex items-center gap-2">
                    <span className="truncate">{member.name}</span>
                    {member.userId === account?.user?.id && <Badge className="shrink-0">{t('common.roles.you')}</Badge>}
                  </div>
                  <div className="text-xs text-[var(--muted)] truncate">{member.email}</div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {isOwner && member.userId !== account?.user?.id ? (
                  <Select
                    value={member.role}
                    onChange={(e) =>
                      handleRoleChange(
                        member.userId,
                        e.target.value as 'owner' | 'editor' | 'viewer',
                      )
                    }
                    className="text-xs px-2 py-1 w-auto"
                  >
                    <option value="owner">{t('common.roles.owner')}</option>
                    <option value="editor">{t('common.roles.editor')}</option>
                    <option value="viewer">{t('common.roles.viewer')}</option>
                  </Select>
                ) : (
                  <Badge className="capitalize">{t(`common.roles.${member.role as 'owner' | 'editor' | 'viewer'}`)}</Badge>
                )}

                {isOwner && member.userId !== account?.user?.id && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setMemberToRemove({ id: member.userId, name: member.name })}
                    className="p-1.5 text-[var(--muted)] hover:text-[var(--danger)] cursor-pointer"
                    title={t('members.removeMember')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Pending Invites List */}
        {isOwner && invites.length > 0 && (
          <div className="chamfer-sm border border-[var(--line)] bg-[var(--surface)] divide-y divide-[var(--hair)] overflow-hidden">
            <div className="px-4 py-2.5 text-xs font-semibold text-[var(--muted)] uppercase tracking-wider bg-[var(--surface2)]">
              {t('members.pendingInvitesCount', { count: invites.length })}
            </div>

            {invites.map((inv) => (
              <div key={inv.id} className="px-4 py-2.5 flex items-center justify-between text-xs sm:text-sm">
                <div>
                  <span className="font-medium text-[var(--text)]">{inv.email}</span>
                  <span className="ml-2 text-xs text-[var(--muted)] capitalize">({t(`common.roles.${inv.role as 'owner' | 'editor' | 'viewer'}`)})</span>
                </div>
                <button
                  onClick={() =>
                    revokeInvite.mutate(inv.id, {
                      onSuccess: () => toast.success('Invite revoked'),
                      onError: (err: any) => toast.error(err?.message || 'Failed to revoke invite'),
                    })
                  }
                  className="text-xs text-[var(--danger)] hover:underline cursor-pointer py-1 px-1.5"
                >
                  {t('members.revokeInvite')}
                </button>
              </div>
            ))}
          </div>
        )}

        <ConfirmDialog
          open={!!memberToRemove}
          title={t('members.confirmRemoveMemberTitle')}
          message={t('members.confirmRemoveMemberMessage', { name: memberToRemove?.name || '' })}
          confirmLabel={t('common.remove')}
          danger={true}
          busy={isRemoving}
          onConfirm={handleRemoveMember}
          onCancel={() => setMemberToRemove(null)}
        />
      </div>
    </div>
  );
}
