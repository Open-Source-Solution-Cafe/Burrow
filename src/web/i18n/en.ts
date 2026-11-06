export interface TranslationDictionary {
  common: {
    save: string;
    cancel: string;
    delete: string;
    edit: string;
    create: string;
    loading: string;
    pleaseWait: string;
    search: string;
    settings: string;
    signOut: string;
    error: string;
    close: string;
    back: string;
    language: string;
  };
  login: {
    burrow: string;
    signIn: string;
    signUp: string;
    signInToWorkspace: string;
    createAccount: string;
    finishWorkspaceSetup: string;
    name: string;
    namePlaceholder: string;
    email: string;
    emailPlaceholder: string;
    password: string;
    passwordPlaceholder: string;
    bootstrapToken: string;
    bootstrapTokenLabel: string;
    bootstrapTokenPlaceholder: string;
    inviteToken: string;
    inviteTokenLabel: string;
    inviteTokenPlaceholder: string;
    invitePreFilled: string;
    inviteHelp: string;
    signInWithMagicLink: string;
    signInWithPassword: string;
    sendMagicLink: string;
    magicLinkSent: string;
    orContinueWith: string;
    continueWith: string;
    haveAccount: string;
    needAccount: string;
    demoCredentials: string;
    autoFill: string;
    demoNotice: string;
    invitationDetected: string;
    withoutWorkspaceNotice: string;
    acceptInvitation: string;
    finishSetup: string;
    createWorkspaceInstead: string;
  };
  sidebar: {
    overview: string;
    search: string;
    membersAndSettings: string;
    workspaceMembers: string;
    projectSettings: string;
    trash: string;
    accountMenu: string;
    logOut: string;
    updateAvailable: string;
  };
  system: {
    updateAvailable: string;
    newVersionAvailable: string;
  };
}

export const en: TranslationDictionary = {
  common: {
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    edit: 'Edit',
    create: 'Create',
    loading: 'Loading…',
    pleaseWait: 'Please wait…',
    search: 'Search',
    settings: 'Settings',
    signOut: 'Sign out',
    error: 'Error',
    close: 'Close',
    back: 'Back',
    language: 'Language',
  },
  login: {
    burrow: 'Burrow',
    signIn: 'Sign in',
    signUp: 'Sign up',
    signInToWorkspace: 'Sign in to your workspace',
    createAccount: 'Create your account',
    finishWorkspaceSetup: 'Finish workspace setup',
    name: 'Name',
    namePlaceholder: 'Ada Lovelace',
    email: 'Email',
    emailPlaceholder: 'you@example.com',
    password: 'Password',
    passwordPlaceholder: '••••••••',
    bootstrapToken: 'Bootstrap Token',
    bootstrapTokenLabel: 'Bootstrap Token (First user setting up Burrow only)',
    bootstrapTokenPlaceholder: 'Leave blank unless initial server setup',
    inviteToken: 'Invite Token',
    inviteTokenLabel: 'Invite Token (Teammate invitations)',
    inviteTokenPlaceholder: 'Enter invite token',
    invitePreFilled: 'Pre-filled from link',
    inviteHelp:
      'If you received an invite link like /invite/TOKEN, the token is the code at the end of the URL.',
    signInWithMagicLink: 'Sign in with Magic Link',
    signInWithPassword: 'Sign in with Password',
    sendMagicLink: 'Send Magic Link',
    magicLinkSent: 'Check your email for the sign-in link!',
    orContinueWith: 'or continue with',
    continueWith: 'Continue with {provider}',
    haveAccount: 'Already have an account? Sign in',
    needAccount: "Don't have an account? Sign up",
    demoCredentials: 'Demo Credentials',
    autoFill: 'Auto-fill',
    demoNotice: 'The demo database automatically wipes and resets every 2 hours.',
    invitationDetected: 'Workspace invitation detected. Complete registration below to join.',
    withoutWorkspaceNotice:
      'You are signed in, but this account has no workspace. If your initial setup was interrupted, enter the bootstrap token to finish. Otherwise, ask an owner for an invitation link.',
    acceptInvitation: 'Accept invitation',
    finishSetup: 'Finish setup',
    createWorkspaceInstead: 'Create a workspace instead',
  },
  sidebar: {
    overview: 'Burrow Overview',
    search: 'Search',
    membersAndSettings: 'Members & Settings',
    workspaceMembers: 'Workspace Members',
    projectSettings: 'Project Settings',
    trash: 'Trash',
    accountMenu: 'Account menu',
    logOut: 'Log out',
    updateAvailable: 'Update available',
  },
  system: {
    updateAvailable: 'Update available',
    newVersionAvailable: 'New version available',
  },
};
