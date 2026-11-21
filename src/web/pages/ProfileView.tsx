import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Download, LogOut, ShieldCheck, Trash2, User } from 'lucide-react';
import { toast } from 'sonner';
import {
  useAccount,
  useAuthConfig,
  useSignOut,
  useUpdateProfileName,
} from '../lib/queries';
import { Avatar } from '../components/ui/Avatar';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { Input } from '../components/ui/Input';
import { LanguageSelector } from '../components/ui/LanguageSelector';
import { Select } from '../components/ui/Select';
import { useTranslation } from '../lib/i18n';

export function ProfileView() {
  const { t } = useTranslation();
  const { workspaceId } = useParams({ strict: false }) as { workspaceId?: string };
  const { data: account } = useAccount();
  const { data: authConfig } = useAuthConfig();
  const signOut = useSignOut();
  const updateProfileName = useUpdateProfileName();

  const [profileName, setProfileName] = useState('');
  const [exportScope, setExportScope] = useState<string>('all');
  const [exportingPersonalData, setExportingPersonalData] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);

  const role = account?.workspaces.find((workspace) => workspace.id === workspaceId)?.role;

  useEffect(() => {
    setProfileName(account?.user?.name ?? '');
  }, [account?.user?.name]);

  const handleSaveProfileName = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = profileName.trim();
    if (!trimmed || trimmed === (account?.user?.name ?? '').trim()) return;
    try {
      await updateProfileName.mutateAsync({ name: trimmed });
      toast.success('Display name updated');
    } catch {
      setProfileName(account?.user?.name ?? '');
    }
  };

  const handleDownloadPersonalData = async () => {
    setExportingPersonalData(true);
    try {
      const qs =
        exportScope !== 'all'
          ? `?download=1&workspaceId=${encodeURIComponent(exportScope)}`
          : '?download=1';
      const res = await fetch(`/api/account/export${qs}`);
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(err.error?.message || 'Failed to export personal data');
      }
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') ?? '';
      const headerFilename = /filename="([^"]+)"/.exec(disposition)?.[1];
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        headerFilename || `burrow-personal-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('Personal data JSON downloaded');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to export personal data');
    } finally {
      setExportingPersonalData(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto py-5 px-3.5 sm:py-8 sm:px-6 space-y-5 sm:space-y-8">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-[var(--text)]">
            {t('settings.profileAndAccount')}
          </h1>
          <p className="text-xs sm:text-sm text-[var(--muted)]">
            Manage your personal profile, display name, language preference, privacy, and account data.
          </p>
        </div>

        {/* Profile Information */}
        <div className="chamfer-sm border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-5 space-y-4">
          <div className="flex items-center gap-2 border-b border-[var(--hair)] pb-3">
            <User className="w-4 h-4 text-[var(--accent)]" />
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">
              Profile Information
            </h2>
          </div>

          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <Avatar name={account?.user?.name || t('common.user')} size="md" />
              <div>
                <div className="text-sm font-semibold text-[var(--text)]">
                  {account?.user?.name || t('common.user')}
                </div>
                <div className="text-xs text-[var(--muted)]">{account?.user?.email}</div>
                {role && (
                  <div className="mt-1 flex items-center gap-1.5">
                    <span className="text-[11px] text-[var(--muted)]">
                      {t('settings.workspaceRole')}
                    </span>
                    <Badge className="uppercase text-[10px] tracking-wider font-mono">
                      {t(`common.roles.${role}` as any) || role}
                    </Badge>
                  </div>
                )}
              </div>
            </div>

            <Button
              variant="danger"
              size="sm"
              onClick={() => setConfirmSignOut(true)}
              className="flex items-center gap-1.5"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>{t('settings.logOut')}</span>
            </Button>
          </div>

          <form
            onSubmit={handleSaveProfileName}
            className="flex flex-col sm:flex-row sm:items-end gap-2.5 border-t border-[var(--hair)] pt-3"
          >
            <label className="w-full sm:min-w-56 sm:flex-1 space-y-1 text-xs font-medium text-[var(--text)]">
              Display Name
              <Input
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                maxLength={100}
                aria-label="Display name"
              />
            </label>
            <Button
              type="submit"
              variant="primary"
              size="md"
              className="w-full sm:w-auto"
              disabled={
                !account ||
                !profileName.trim() ||
                profileName.trim() === (account?.user?.name ?? '').trim() ||
                updateProfileName.isPending
              }
            >
              {updateProfileName.isPending ? t('common.saving') : 'Save Name'}
            </Button>
          </form>

          <div className="flex items-center justify-between border-t border-[var(--hair)] pt-3 text-xs">
            <span className="text-[var(--muted)] font-medium">{t('common.language')}</span>
            <LanguageSelector />
          </div>
        </div>

        {/* Personal Data, Privacy & Account Deletion */}
        <div className="chamfer-sm border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-5 space-y-4">
          <div className="flex items-center gap-2 border-b border-[var(--hair)] pb-3">
            <ShieldCheck className="w-4 h-4 text-[var(--accent)]" />
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">
              Personal Data &amp; Privacy
            </h2>
          </div>

          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="space-y-1 max-w-xl">
              <div className="text-xs font-semibold text-[var(--text)]">
                Personal Data Export (JSON)
              </div>
              <p className="text-xs text-[var(--muted)]">
                Download a machine-readable JSON copy of your user profile, workspace memberships,
                assigned tasks, authored comments, and notifications at any time. Never includes
                other teammates&apos; documents or workspace files.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {(account?.workspaces.length ?? 0) > 1 && (
                <Select
                  value={exportScope}
                  onChange={(e) => setExportScope(e.target.value)}
                  aria-label="Personal export workspace scope"
                  className="w-auto text-xs"
                >
                  <option value="all">
                    All workspaces ({account?.workspaces.length ?? 0})
                  </option>
                  {account?.workspaces.map((ws) => (
                    <option key={ws.id} value={ws.id}>
                      {ws.name} ({ws.role})
                    </option>
                  ))}
                </Select>
              )}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={exportingPersonalData}
                onClick={() => void handleDownloadPersonalData()}
                className="flex items-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{exportingPersonalData ? 'Exporting…' : 'Download My Data (.json)'}</span>
              </Button>
            </div>
          </div>

          <div className="border-t border-[var(--hair)] pt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--muted)]">
            <span>
              Burrow uses strictly necessary session cookies for authentication and does not use
              third-party tracking cookies.
            </span>
            {(authConfig?.privacyPolicyUrl || authConfig?.termsOfServiceUrl) && (
              <div className="flex items-center gap-3">
                {authConfig.privacyPolicyUrl && (
                  <a
                    href={authConfig.privacyPolicyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--accent)] underline hover:opacity-80"
                  >
                    Privacy Policy
                  </a>
                )}
                {authConfig.termsOfServiceUrl && (
                  <a
                    href={authConfig.termsOfServiceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--accent)] underline hover:opacity-80"
                  >
                    Terms of Service
                  </a>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-[var(--hair)] pt-3 flex items-center justify-between gap-4 flex-wrap">
            <div className="space-y-0.5 max-w-xl">
              <div className="text-xs font-semibold text-[var(--danger)]">Delete Account</div>
              <p className="text-xs text-[var(--muted)]">
                Permanently remove your user profile, sessions, memberships, and notifications.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDeleteAccount(true)}
              className="flex items-center gap-1.5 border border-[var(--line)] text-[var(--danger)] hover:bg-[var(--danger)]/10"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Delete Account</span>
            </Button>
          </div>
        </div>
      </div>

      {/* Confirm Sign Out */}
      <ConfirmDialog
        open={confirmSignOut}
        title={t('sidebar.confirmSignOutTitle')}
        message={t('sidebar.confirmSignOutMessage')}
        confirmLabel={t('common.signOut')}
        danger={false}
        busy={signOut.isPending}
        onConfirm={async () => {
          try {
            await signOut.mutateAsync();
          } catch (err: any) {
            toast.error(err?.message || 'Failed to sign out');
            setConfirmSignOut(false);
          }
        }}
        onCancel={() => setConfirmSignOut(false)}
      />

      {/* Confirm Delete Account */}
      {confirmDeleteAccount && (
        <ConfirmDialog
          open
          title="Delete Your Account"
          message="Permanently delete your user account and active sessions. If you are the sole owner of a workspace, transfer ownership or delete the workspace first."
          confirmLabel="Delete Account"
          danger
          busy={deletingAccount}
          onConfirm={async () => {
            setDeletingAccount(true);
            try {
              const res = await fetch('/api/auth/delete-user', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              });
              if (!res.ok) {
                const err = (await res.json().catch(() => ({}))) as { message?: string };
                throw new Error(err.message || 'Could not delete account');
              }
              window.location.href = '/login';
            } catch (err) {
              toast.error(err instanceof Error ? err.message : 'Could not delete account');
              setDeletingAccount(false);
              setConfirmDeleteAccount(false);
            }
          }}
          onCancel={() => setConfirmDeleteAccount(false)}
        />
      )}
    </div>
  );
}
