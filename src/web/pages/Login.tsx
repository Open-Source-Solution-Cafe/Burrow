import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { toast, Toaster } from 'sonner';
import { useAccount, useSignOut } from '../lib/queries';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Badge } from '../components/ui/Badge';
import { LanguageSelector } from '../components/ui/LanguageSelector';
import { useTranslation } from '../lib/i18n';
import { APP_VERSION } from '../../core/version';

interface OAuthProviderConfig {
  id: string;
  name: string;
  kind: 'social';
}

interface AuthConfig {
  signupMode: 'bootstrap-or-invite' | 'open';
  emailPasswordEnabled: boolean;
  magicLinkEnabled: boolean;
  oauthProviders: OAuthProviderConfig[];
}

async function hasAccountSession(signal?: AbortSignal): Promise<boolean> {
  const res = await fetch('/api/auth/get-session', { signal });
  if (!res.ok) throw new Error('Could not check your account session');
  const session = (await res.json()) as { user?: { id?: string } } | null;
  if (session === null) return false;
  if (!session?.user?.id) throw new Error('Could not check your account session');
  return true;
}

async function acceptInvitation(token: string): Promise<void> {
  const res = await fetch('/api/invites/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(data.error?.message || 'Signed in, but failed to accept invite');
  }
}

export function Login() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: account, isLoading: accountLoading, isError: accountError } = useAccount();
  const signOut = useSignOut();
  const { t } = useTranslation();

  const searchParams =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const queryInviteToken = searchParams?.get('inviteToken') || searchParams?.get('token') || '';
  const queryEmail = searchParams?.get('email') || '';
  const queryMode = searchParams?.get('mode');

  const isDemoHost =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'burrow.osscafe.com' ||
      window.location.hostname === 'osscafe.com' ||
      window.location.search.includes('demo=true'));

  const [isSignUp, setIsSignUp] = useState(() =>
    queryMode ? queryMode === 'signup' : Boolean(queryInviteToken),
  );
  const [useMagicLink, setUseMagicLink] = useState(false);
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [email, setEmail] = useState(() => {
    if (queryEmail) return queryEmail;
    if (isDemoHost && !queryInviteToken) return 'demo@osscafe.com';
    return '';
  });
  const [password, setPassword] = useState(() => {
    if (isDemoHost && !queryInviteToken) return 'demopassword123';
    return '';
  });
  const [name, setName] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [inviteToken, setInviteToken] = useState(() => queryInviteToken);
  const [authConfig, setAuthConfig] = useState<AuthConfig>({
    signupMode: 'bootstrap-or-invite',
    emailPasswordEnabled: true,
    magicLinkEnabled: false,
    oauthProviders: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [withoutWorkspace, setWithoutWorkspace] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/auth/config', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Partial<AuthConfig> | null) => {
        if (data) {
          setAuthConfig({
            signupMode: data.signupMode ?? 'bootstrap-or-invite',
            emailPasswordEnabled: data.emailPasswordEnabled ?? true,
            magicLinkEnabled: Boolean(data.magicLinkEnabled),
            oauthProviders: Array.isArray(data.oauthProviders) ? data.oauthProviders : [],
          });
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  // Redirect to app if already authenticated
  useEffect(() => {
    if (!accountLoading && account) {
      if (account.workspaces.length === 0) {
        setWithoutWorkspace(true);
        return;
      }
      navigate({ to: '/' });
    }
  }, [account, accountLoading, navigate]);

  // Membership can be absent even when an account session survives a reload.
  useEffect(() => {
    if (accountLoading || accountError || account) return;
    const controller = new AbortController();
    void (async () => {
      try {
        if (await hasAccountSession(controller.signal)) setWithoutWorkspace(true);
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : 'Could not check your account session';
        setError(message);
        toast.error(message);
      }
    })();
    return () => controller.abort();
  }, [account, accountError, accountLoading]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const bootstrapSignup = isSignUp && Boolean(bootstrapToken.trim());

    try {
      const endpoint = isSignUp ? '/api/auth/sign-up/email' : '/api/auth/sign-in/email';

      const payload: Record<string, string> = { email, password };
      if (isSignUp) {
        payload.name = name;
        if (bootstrapToken.trim() && authConfig.signupMode !== 'open') {
          payload.bootstrapToken = bootstrapToken.trim();
        }
        if (inviteToken.trim()) payload.inviteToken = inviteToken.trim();
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
          message?: string;
        };
        throw new Error(data.error?.message || data.message || 'Authentication failed');
      }

      // If user signed in (not signed up) and there was an invite token, accept it
      const effectiveInviteToken = queryInviteToken || inviteToken.trim();
      if (!isSignUp && effectiveInviteToken) {
        try {
          await acceptInvitation(effectiveInviteToken);
          toast.success('Accepted invitation and joined workspace');
        } catch (err: unknown) {
          toast.error(err instanceof Error ? err.message : 'Failed to accept invitation');
        }
      }

      // A valid account can exist without a workspace after interrupted setup.
      const profile = await fetch('/api/account');
      queryClient.clear();
      if (profile.status === 401) {
        if (!(await hasAccountSession())) {
          throw new Error('Your sign-in session could not be saved. Please try again.');
        }
        setWithoutWorkspace(true);
        return;
      }
      if (!profile.ok) throw new Error('Signed in, but could not load your account');
      const accountData = (await profile.json()) as { workspaces?: unknown[] };
      if (accountData.workspaces?.length === 0) {
        setWithoutWorkspace(true);
        return;
      }
      navigate({ to: '/' });
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : 'Authentication failed';
      const message = bootstrapSignup
        ? `${detail} — if your account was created, sign in to finish setup.`
        : detail;
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleMagicLinkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    setMagicLinkSent(false);

    try {
      const res = await fetch('/api/auth/sign-in/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), callbackURL: '/' }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
          message?: string;
        };
        throw new Error(data.error?.message || data.message || 'Failed to send magic link');
      }

      setMagicLinkSent(true);
      toast.success(t('login.magicLinkSent'));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to send magic link';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleOAuthSignIn = async (providerId: string) => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId, callbackURL: '/' }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message || 'Failed to initiate provider sign-in');
      }
      const data = (await res.json()) as { url?: string };
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Social sign-in failed';
      setError(message);
      toast.error(message);
      setLoading(false);
    }
  };

  const handleRecover = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/bootstrap/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bootstrapToken: bootstrapToken.trim() }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(data.error?.message || 'Could not complete workspace setup');
      }
      setBootstrapToken('');
      queryClient.clear();
      navigate({ to: '/' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Could not complete workspace setup';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleJoin = async () => {
    setError(null);
    setLoading(true);
    try {
      await acceptInvitation(queryInviteToken || inviteToken.trim());
      queryClient.clear();
      navigate({ to: '/' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to accept invitation';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-4 py-6 sm:p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-[calc(1.5rem+env(safe-area-inset-top))] bg-[var(--bg)]">
      <Toaster position="bottom-right" richColors />
      <div className="w-full max-w-sm border border-[var(--line)] chamfer-sm sm:chamfer-lg bg-[var(--surface)] p-5 sm:p-8 space-y-5 sm:space-y-6">
        <div className="flex items-center justify-between pb-1">
          <span className="text-[11px] font-mono text-[var(--muted)]">v{APP_VERSION}</span>
          <LanguageSelector />
        </div>

        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text)]">
            {t('login.burrow')}
          </h1>
          <p className="text-sm text-[var(--muted)]">
            {withoutWorkspace
              ? t('login.finishWorkspaceSetup')
              : isSignUp
                ? t('login.createAccount')
                : t('login.signInToWorkspace')}
          </p>
        </div>

        {isDemoHost && !withoutWorkspace && (
          <div className="p-3 text-xs bg-[var(--surface2)] text-[var(--text)] border border-[var(--line)] border-l-4 border-l-[var(--accent)] space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-[var(--text)] flex items-center gap-1.5">
                <span>✨</span> {t('login.demoCredentials')}
              </span>
              <button
                type="button"
                onClick={() => {
                  setEmail('demo@osscafe.com');
                  setPassword('demopassword123');
                  setIsSignUp(false);
                  setUseMagicLink(false);
                  setError(null);
                }}
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-end text-[11px] font-semibold text-[var(--accent)] hover:underline cursor-pointer -my-2.5 -mr-1 px-1.5"
              >
                {t('login.autoFill')}
              </button>
            </div>
            <div className="space-y-0.5 text-[var(--muted)] font-mono text-[11px]">
              <div>
                <span className="text-[var(--text)] font-sans">{t('login.email')}:</span>{' '}
                demo@osscafe.com
              </div>
              <div>
                <span className="text-[var(--text)] font-sans">{t('login.password')}:</span>{' '}
                demopassword123
              </div>
            </div>
            <p className="text-[10px] text-[var(--muted)]">{t('login.demoNotice')}</p>
          </div>
        )}

        {(error || accountError) && (
          <div className="p-3 text-xs bg-[var(--surface2)] text-[var(--text)] border border-[var(--line)] border-l-4 border-l-[var(--danger)]">
            {error || t('common.error')}
          </div>
        )}

        {magicLinkSent && (
          <div className="p-3 text-xs bg-[var(--surface2)] text-[var(--text)] border border-[var(--line)] border-l-4 border-l-[var(--c4)] flex items-center gap-2">
            <Check className="w-4 h-4 text-[var(--c4)] shrink-0" />
            <span>{t('login.magicLinkSent')}</span>
          </div>
        )}

        {queryInviteToken && !withoutWorkspace && (
          <div className="p-3 text-xs bg-[var(--surface2)] text-[var(--text)] border border-[var(--line)] border-l-4 border-l-[var(--c4)] flex items-center gap-2">
            <Check className="w-4 h-4 text-[var(--c4)] shrink-0" />
            <span>{t('login.invitationDetected')}</span>
          </div>
        )}

        {withoutWorkspace ? (
          <>
            <p className="text-sm text-[var(--muted)]">{t('login.withoutWorkspaceNotice')}</p>
            {(queryInviteToken || inviteToken.trim()) && (
              <Button
                type="button"
                variant="primary"
                disabled={loading}
                onClick={() => void handleJoin()}
                className="w-full min-h-[44px]"
              >
                {loading ? t('common.pleaseWait') : t('login.acceptInvitation')}
              </Button>
            )}
            <form onSubmit={handleRecover} className="space-y-4">
              <label
                className="block text-xs font-medium text-[var(--text)]"
                htmlFor="recover-bootstrap-token"
              >
                {t('login.bootstrapToken')}
              </label>
              <Input
                id="recover-bootstrap-token"
                type="password"
                required
                value={bootstrapToken}
                onChange={(e) => setBootstrapToken(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck="false"
                className="w-full px-3 py-2 text-base sm:text-sm font-mono"
              />
              <Button
                type="submit"
                variant="primary"
                disabled={loading}
                className="w-full min-h-[44px]"
              >
                {loading ? t('common.pleaseWait') : t('login.finishSetup')}
              </Button>
            </form>
            <Button
              type="button"
              variant="secondary"
              disabled={loading}
              onClick={() => void navigate({ to: '/' })}
              className="w-full min-h-[44px]"
            >
              {t('login.createWorkspaceInstead')}
            </Button>
            <button
              type="button"
              onClick={() => signOut.mutate()}
              disabled={loading || signOut.isPending}
              className="w-full text-xs text-[var(--muted)] hover:text-[var(--text)] min-h-[44px] cursor-pointer"
            >
              {t('common.signOut')}
            </button>
          </>
        ) : (
          <>
            {authConfig.magicLinkEnabled && !isSignUp && (
              <div className="flex theme-radius-md bg-[var(--surface2)] p-1 border border-[var(--line)]">
                <button
                  type="button"
                  onClick={() => {
                    setUseMagicLink(false);
                    setError(null);
                  }}
                  className={`flex-1 py-1.5 text-xs font-medium theme-radius-xs transition cursor-pointer ${
                    !useMagicLink
                      ? 'bg-[var(--surface)] text-[var(--text)] font-semibold'
                      : 'text-[var(--muted)] hover:text-[var(--text)]'
                  }`}
                >
                  {t('login.signInWithPassword')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUseMagicLink(true);
                    setError(null);
                  }}
                  className={`flex-1 py-1.5 text-xs font-medium theme-radius-xs transition cursor-pointer ${
                    useMagicLink
                      ? 'bg-[var(--surface)] text-[var(--text)] font-semibold'
                      : 'text-[var(--muted)] hover:text-[var(--text)]'
                  }`}
                >
                  {t('login.signInWithMagicLink')}
                </button>
              </div>
            )}

            {useMagicLink && !isSignUp ? (
              <form onSubmit={handleMagicLinkSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-[var(--text)] mb-1">
                    {t('login.email')}
                  </label>
                  <Input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t('login.emailPlaceholder')}
                    autoComplete="email"
                    inputMode="email"
                    autoCapitalize="none"
                    spellCheck="false"
                    className="w-full px-3 py-2 text-base sm:text-sm"
                  />
                </div>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={loading}
                  className="w-full py-2 px-4 text-sm font-medium min-h-[44px]"
                >
                  {loading ? t('common.pleaseWait') : t('login.sendMagicLink')}
                </Button>
              </form>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                {isSignUp && (
                  <div>
                    <label className="block text-xs font-medium text-[var(--text)] mb-1">
                      {t('login.name')}
                    </label>
                    <Input
                      type="text"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={t('login.namePlaceholder')}
                      autoComplete="name"
                      autoCapitalize="words"
                      className="w-full px-3 py-2 text-base sm:text-sm"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-[var(--text)] mb-1">
                    {t('login.email')}
                  </label>
                  <Input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t('login.emailPlaceholder')}
                    autoComplete="email"
                    inputMode="email"
                    autoCapitalize="none"
                    spellCheck="false"
                    className="w-full px-3 py-2 text-base sm:text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-[var(--text)] mb-1">
                    {t('login.password')}
                  </label>
                  <Input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('login.passwordPlaceholder')}
                    autoComplete={isSignUp ? 'new-password' : 'current-password'}
                    className="w-full px-3 py-2 text-base sm:text-sm"
                  />
                </div>

                {isSignUp && (
                  <>
                    {authConfig.signupMode !== 'open' && !inviteToken.trim() && (
                      <div>
                        <label className="block text-xs font-medium text-[var(--text)] mb-1">
                          {t('login.bootstrapTokenLabel')}
                        </label>
                        <Input
                          type="text"
                          value={bootstrapToken}
                          onChange={(e) => setBootstrapToken(e.target.value)}
                          placeholder={t('login.bootstrapTokenPlaceholder')}
                          autoComplete="off"
                          autoCapitalize="none"
                          spellCheck="false"
                          className="w-full px-3 py-2 text-base sm:text-sm font-mono"
                        />
                      </div>
                    )}

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="block text-xs font-medium text-[var(--text)]">
                          {t('login.inviteTokenLabel')}
                        </label>
                        {queryInviteToken && <Badge>{t('login.invitePreFilled')}</Badge>}
                      </div>
                      <Input
                        type="text"
                        value={inviteToken}
                        onChange={(e) => setInviteToken(e.target.value)}
                        placeholder={t('login.inviteTokenPlaceholder')}
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck="false"
                        className="w-full px-3 py-2 text-base sm:text-sm font-mono"
                      />
                      <p className="mt-1 text-[11px] text-[var(--muted)]">{t('login.inviteHelp')}</p>
                    </div>
                  </>
                )}

                <Button
                  type="submit"
                  variant="primary"
                  disabled={loading}
                  className="w-full py-2 px-4 text-sm font-medium min-h-[44px]"
                >
                  {loading ? t('common.pleaseWait') : isSignUp ? t('login.signUp') : t('login.signIn')}
                </Button>
              </form>
            )}

            {authConfig.oauthProviders && authConfig.oauthProviders.length > 0 && (
              <div className="space-y-3 pt-2">
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-[var(--line)]" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-[var(--surface)] px-2 text-[var(--muted)]">
                      {t('login.orContinueWith')}
                    </span>
                  </div>
                </div>
                <div className="space-y-2">
                  {authConfig.oauthProviders.map((provider) => (
                    <Button
                      key={provider.id}
                      type="button"
                      variant="secondary"
                      disabled={loading}
                      onClick={() => void handleOAuthSignIn(provider.id)}
                      className="w-full min-h-[44px] flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <span>{t('login.continueWith', { provider: provider.name })}</span>
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <div className="text-center pt-2">
              <button
                type="button"
                onClick={() => {
                  setIsSignUp(!isSignUp);
                  setUseMagicLink(false);
                  setError(null);
                }}
                className="w-full inline-flex items-center justify-center text-xs text-[var(--muted)] hover:text-[var(--text)] transition min-h-[44px] py-2 cursor-pointer"
              >
                {isSignUp ? t('login.haveAccount') : t('login.needAccount')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
