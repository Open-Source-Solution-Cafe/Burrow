import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { toast, Toaster } from 'sonner';
import { useAccount, useSignOut } from '../lib/queries';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Badge } from '../components/ui/Badge';

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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [withoutWorkspace, setWithoutWorkspace] = useState(false);

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
        if (bootstrapToken.trim()) payload.bootstrapToken = bootstrapToken.trim();
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
    <div className="flex min-h-screen items-center justify-center p-6 bg-[var(--bg)]">
      <Toaster position="bottom-right" richColors />
      <div className="w-full max-w-sm border border-[var(--line)] chamfer-lg bg-[var(--surface)] p-8 space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text)]">Burrow</h1>
          <p className="text-sm text-[var(--muted)]">
            {withoutWorkspace
              ? 'Finish workspace setup'
              : isSignUp
                ? 'Create your account'
                : 'Sign in to your workspace'}
          </p>
        </div>

        {isDemoHost && !withoutWorkspace && (
          <div className="p-3 text-xs bg-[var(--surface2)] text-[var(--text)] border border-[var(--line)] border-l-4 border-l-[var(--accent)] space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-[var(--text)] flex items-center gap-1.5">
                <span>✨</span> Demo Credentials
              </span>
              <button
                type="button"
                onClick={() => {
                  setEmail('demo@osscafe.com');
                  setPassword('demopassword123');
                  setIsSignUp(false);
                  setError(null);
                }}
                className="text-[11px] font-medium text-[var(--accent)] hover:underline cursor-pointer"
              >
                Auto-fill
              </button>
            </div>
            <div className="space-y-0.5 text-[var(--muted)] font-mono text-[11px]">
              <div>
                <span className="text-[var(--text)] font-sans">Email:</span> demo@osscafe.com
              </div>
              <div>
                <span className="text-[var(--text)] font-sans">Password:</span> demopassword123
              </div>
            </div>
            <p className="text-[10px] text-[var(--muted)]">
              The demo database automatically wipes and resets every 2 hours.
            </p>
          </div>
        )}

        {(error || accountError) && (
          <div className="p-3 text-xs bg-[var(--surface2)] text-[var(--text)] border border-[var(--line)] border-l-4 border-l-[var(--danger)]">
            {error || 'Could not load your account. Please try again.'}
          </div>
        )}

        {queryInviteToken && !withoutWorkspace && (
          <div className="p-3 text-xs bg-[var(--surface2)] text-[var(--text)] border border-[var(--line)] border-l-4 border-l-[var(--c4)] flex items-center gap-2">
            <Check className="w-4 h-4 text-[var(--c4)] shrink-0" />
            <span>Workspace invitation detected. Complete registration below to join.</span>
          </div>
        )}

        {withoutWorkspace ? (
          <>
            <p className="text-sm text-[var(--muted)]">
              You are signed in, but this account has no workspace. If your initial setup was
              interrupted, enter the bootstrap token to finish. Otherwise, ask an owner for an
              invitation link.
            </p>
            {(queryInviteToken || inviteToken.trim()) && (
              <Button
                type="button"
                variant="primary"
                disabled={loading}
                onClick={() => void handleJoin()}
                className="w-full min-h-[44px]"
              >
                {loading ? 'Please wait…' : 'Accept invitation'}
              </Button>
            )}
            <form onSubmit={handleRecover} className="space-y-4">
              <label
                className="block text-xs font-medium text-[var(--text)]"
                htmlFor="recover-bootstrap-token"
              >
                Bootstrap token
              </label>
              <Input
                id="recover-bootstrap-token"
                type="password"
                required
                value={bootstrapToken}
                onChange={(e) => setBootstrapToken(e.target.value)}
                autoComplete="off"
                className="w-full px-3 py-2 text-base sm:text-sm"
              />
              <Button
                type="submit"
                variant="primary"
                disabled={loading}
                className="w-full min-h-[44px]"
              >
                {loading ? 'Please wait…' : 'Finish setup'}
              </Button>
            </form>
            <Button
              type="button"
              variant="secondary"
              disabled={loading}
              onClick={() => void navigate({ to: '/' })}
              className="w-full min-h-[44px]"
            >
              Create a workspace instead
            </Button>
            <button
              type="button"
              onClick={() => signOut.mutate()}
              disabled={loading || signOut.isPending}
              className="w-full text-xs text-[var(--muted)] hover:text-[var(--text)] min-h-[44px]"
            >
              Sign out
            </button>
          </>
        ) : (
          <>
            <form onSubmit={handleSubmit} className="space-y-4">
              {isSignUp && (
                <div>
                  <label className="block text-xs font-medium text-[var(--text)] mb-1">Name</label>
                  <Input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ada Lovelace"
                    className="w-full px-3 py-2 text-base sm:text-sm"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-[var(--text)] mb-1">Email</label>
                <Input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full px-3 py-2 text-base sm:text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--text)] mb-1">
                  Password
                </label>
                <Input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-3 py-2 text-base sm:text-sm"
                />
              </div>

              {isSignUp && (
                <>
                  {!inviteToken.trim() && (
                    <div>
                      <label className="block text-xs font-medium text-[var(--text)] mb-1">
                        Bootstrap Token (First user setting up Burrow only)
                      </label>
                      <Input
                        type="text"
                        value={bootstrapToken}
                        onChange={(e) => setBootstrapToken(e.target.value)}
                        placeholder="Leave blank unless initial server setup"
                        className="w-full px-3 py-2 text-base sm:text-sm font-mono text-xs"
                      />
                    </div>
                  )}

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-medium text-[var(--text)]">
                        Invite Token (Teammate invitations)
                      </label>
                      {queryInviteToken && <Badge>Pre-filled from link</Badge>}
                    </div>
                    <Input
                      type="text"
                      value={inviteToken}
                      onChange={(e) => setInviteToken(e.target.value)}
                      placeholder="Enter invite token"
                      className="w-full px-3 py-2 text-base sm:text-sm font-mono text-xs"
                    />
                    <p className="mt-1 text-[11px] text-[var(--muted)]">
                      If you received an invite link like{' '}
                      <code className="font-mono">/invite/TOKEN</code>, the token is the code at the
                      end of the URL.
                    </p>
                  </div>
                </>
              )}

              <Button
                type="submit"
                variant="primary"
                disabled={loading}
                className="w-full py-2 px-4 text-sm font-medium min-h-[44px]"
              >
                {loading ? 'Please wait…' : isSignUp ? 'Sign up' : 'Sign in'}
              </Button>
            </form>

            <div className="text-center pt-2">
              <button
                type="button"
                onClick={() => {
                  setIsSignUp(!isSignUp);
                  setError(null);
                }}
                className="text-xs text-[var(--muted)] hover:text-[var(--text)] transition min-h-[44px]"
              >
                {isSignUp ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
