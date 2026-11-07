export interface TranslationDictionary {
  common: {
    save: string;
    saving: string;
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
    reload: string;
    retry: string;
    copy: string;
    copied: string;
    open: string;
    add: string;
    remove: string;
    dismiss: string;
    update: string;
    clear: string;
    all: string;
    name: string;
    email: string;
    role: string;
    actions: string;
    overview: string;
    none: string;
    untitled: string;
    roles: {
      owner: string;
      editor: string;
      viewer: string;
      member: string;
      you: string;
    };
    priorities: {
      low: string;
      medium: string;
      high: string;
      urgent: string;
    };
    themes: {
      basalt: string;
      modern: string;
      light: string;
    };
    user: string;
    someone: string;
    favorite: string;
    keyboardShortcuts: string;
    archived: string;
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
  invite: {
    title: string;
    joinWorkspace: string;
    invitedAs: string;
    signedInAs: string;
    invitedEmail: string;
    assignedRole: string;
    accountMismatch: string;
    accountMismatchDesc: string;
    accountMismatchAction: string;
    acceptAndJoin: string;
    joiningWorkspace: string;
    signOutDifferentAccount: string;
    inviteToken: string;
    copyToken: string;
    accountDetected: string;
    accountDetectedDesc: string;
    createAccountTab: string;
    signInTab: string;
    fullName: string;
    password: string;
    createAccountAndJoin: string;
    signInAndJoin: string;
    invalidOrExpired: string;
    invalidOrExpiredDesc: string;
    providedToken: string;
    goToLogin: string;
    preferStandardLogin: string;
    loadingDetails: string;
  };
  router: {
    chooseWorkspace: string;
    createWorkspace: string;
    createWorkspaceDesc: string;
    workspaceName: string;
    createWorkspaceButton: string;
    creatingWorkspace: string;
    loadingWorkspaces: string;
    couldNotLoadWorkspaces: string;
    tryAgain: string;
    redirectingToSignIn: string;
    loadingWorkspace: string;
    couldNotLoadWorkspace: string;
    workspaceUnavailable: string;
    loadingProjects: string;
    couldNotLoadProjects: string;
    openingProject: string;
    noActiveProjects: string;
    loadingProject: string;
    projectUnavailableInWorkspace: string;
    chooseAnotherProject: string;
    resolvingProjectLink: string;
    couldNotVerifyProjectLink: string;
    projectLinkUnavailable: string;
    selectNotepad: string;
    boardNotFound: string;
    somethingWentWrong: string;
    unexpectedError: string;
    reloadPage: string;
    resolvingWorkspaceLink: string;
    couldNotVerifyWorkspaceLink: string;
    uniqueWorkspaceRequired: string;
    openingWorkspace: string;
    loadingBurrow: string;
  };
  sidebar: {
    overview: string;
    search: string;
    searchPlaceholder: string;
    membersAndSettings: string;
    workspaceMembers: string;
    projectSettings: string;
    trash: string;
    accountMenu: string;
    logOut: string;
    updateAvailable: string;
    project: string;
    projectLibrary: string;
    myTasks: string;
    favorites: string;
    noFavoritesYet: string;
    notepads: string;
    collapseNotepads: string;
    expandNotepads: string;
    newNotepad: string;
    untitled: string;
    boards: string;
    collapseBoards: string;
    expandBoards: string;
    createBoard: string;
    noBoardsYet: string;
    deleteBoardToTrash: string;
    tags: string;
    workspace: string;
    workflowTags: string;
    allNotepads: string;
    noMatchesFound: string;
    openPalette: string;
    openTasksBoard: string;
    noActiveTasks: string;
    dueCount: string;
    allFilter: string;
    dueFilter: string;
    newBoard: string;
    language: string;
    languageSwitched: string;
    openTrashView: string;
    deletedNotepads: string;
    noDeletedNotepads: string;
    deletedBoards: string;
    noDeletedBoards: string;
    trashRetentionNotice: string;
    theme: string;
    settings: string;
    newVersion: string;
    closeSidebar: string;
    confirmSignOutTitle: string;
    confirmSignOutMessage: string;
    confirmDeleteBoardTitle: string;
    confirmDeleteBoardMessage: string;
    createBoardPromptTitle: string;
    createBoardPromptMessage: string;
    createBoardPromptPlaceholder: string;
    workspaces: string;
    selectWorkspace: string;
    createWorkspace: string;
    createWorkspaceTitle: string;
    workspaceName: string;
    workspaceNamePlaceholder: string;
    creatingWorkspace: string;
    failedToCreateWorkspace: string;
    switchWorkspaceAria: string;
    projects: string;
    selectProject: string;
    newProject: string;
    createProjectTitle: string;
    projectName: string;
    projectIcon: string;
    iconAndName: string;
    projectNamePlaceholder: string;
    creatingProject: string;
    failedToCreateProject: string;
    switchProjectAria: string;
    account: string;
    openSidebar: string;
    resizePanel: string;
    workspaceSettings: string;
  };
  project: {
    overview: string;
    manageScopedResources: string;
    openLibrary: string;
    notepadsTitle: string;
    notepadsDesc: string;
    addNotepad: string;
    noNotepadsYet: string;
    kanbanBoardsTitle: string;
    kanbanBoardsDesc: string;
    addBoard: string;
    noBoardsYet: string;
    createBoardDialogTitle: string;
    createBoardDialogMessage: string;
    createBoardDialogDefault: string;
    createBoardDialogPlaceholder: string;
    loadingProject: string;
    unableToLoad: string;
    projectNotFound: string;
    noProjectsAvailable: string;
    notepadCreated: string;
    mediaLibraryTitle: string;
    mediaLibraryDesc: string;
    uploadFiles: string;
    noFilesUploaded: string;
  };
  tasks: {
    title: string;
    open: string;
    completed: string;
    all: string;
    allProjects: string;
    overdue: string;
    dueToday: string;
    upcoming: string;
    later: string;
    noTasksAssigned: string;
    noCompletedTasks: string;
    loadingTasks: string;
    markAsComplete: string;
    markAsOpen: string;
    snoozeTomorrow: string;
    snoozedSuccess: string;
    taskMarkedComplete: string;
    taskReopened: string;
  };
  boards: {
    views: {
      kanban: string;
      list: string;
      calendar: string;
    };
    addColumn: string;
    newColumnPlaceholder: string;
    addCard: string;
    newCardPlaceholder: string;
    noCardsInColumn: string;
    cardDetails: string;
    titlePlaceholder: string;
    descriptionPlaceholder: string;
    priority: string;
    assignee: string;
    unassigned: string;
    dueDate: string;
    noDueDate: string;
    tags: string;
    subtasks: string;
    addSubtask: string;
    newSubtaskPlaceholder: string;
    comments: string;
    addComment: string;
    postComment: string;
    deleteCard: string;
    confirmDeleteCard: string;
    filterByTag: string;
    searchCards: string;
    columnOptions: string;
    renameColumn: string;
    deleteColumn: string;
    confirmDeleteColumn: string;
    loadingBoard: string;
    clickToRename: string;
    filterLabel: string;
    allPriorities: string;
    allAssignees: string;
    allTags: string;
    resetFilters: string;
    collapseColumn: string;
    dragToReorder: string;
    dropCardsHere: string;
    wipLimitPromptTitle: string;
    wipLimitPromptMessage: string;
    wipLimitPlaceholder: string;
    wipLimitValidation: string;
    deleteColumnCardsMoved: string;
    columnDeleted: string;
    cardMovedToTrash: string;
    undo: string;
    loadingCard: string;
    noWorkspaceMembers: string;
    noTagsInProject: string;
    newTag: string;
    cardNotesAndBody: string;
    discussion: string;
    loadingComments: string;
    noCommentsYet: string;
    writeCommentPlaceholder: string;
    sendComment: string;
    confirmDeleteCommentTitle: string;
    confirmDeleteCommentMessage: string;
    unscheduled: string;
    today: string;
    previousMonth: string;
    nextMonth: string;
    filterByPriority: string;
    filterByAssignee: string;
    deleteComment: string;
    markComplete: string;
    markIncomplete: string;
    removeSubtask: string;
    expandColumn: string;
    columnNamePlaceholder: string;
    quickAddPlaceholder: string;
    quickAddCommands: string;
    dueDatePlaceholder: string;
    wipLimitMenu: string;
    inColumn: string;
    assignMember: string;
    noMembersFound: string;
    createTagNamed: string;
    noTagsYet: string;
    failedToCreateTag: string;
    failedToCreateCard: string;
    slashNotepadDesc: string;
    slashDueDesc: string;
    slashPriorityDesc: string;
    setPriority: string;
    addProjectTag: string;
  };
  editor: {
    untitled: string;
    writeSomething: string;
    documentOutline: string;
    noHeadings: string;
    filesAndMedia: string;
    uploadFile: string;
    templates: string;
    chooseTemplate: string;
    blankDocument: string;
    meetingNotes: string;
    projectSpec: string;
    weeklyReview: string;
    useTemplate: string;
    lastSaved: string;
    saving: string;
    saved: string;
    offline: string;
    wordCount: string;
    lockStatus: string;
    lockHeldBy: string;
    takeOverLock: string;
    insertYoutube: string;
    youtubePlaceholder: string;
    insertLink: string;
    referenceCard: string;
    referenceNotepad: string;
    notepads: string;
    share: string;
    shareNotepad: string;
    applyTemplate: string;
    exportMarkdown: string;
    printExportPdf: string;
    deleteToTrash: string;
    deleteNotepadTitle: string;
    deleteNotepadConfirm: string;
    emptyPagePrompt: string;
    browseTemplates: string;
    writeFromScratch: string;
    backlinks: string;
    failed: string;
    retrySave: string;
    discard: string;
    tag: string;
    searchOrNewTag: string;
    createTag: string;
    noOtherTags: string;
    shareCopied: string;
    tagCreated: string;
    editHereInstead: string;
    checkAvailability: string;
    startEditing: string;
    reload: string;
    overwrite: string;
    readOnlyOtherTab: string;
    readOnlyOtherUser: string;
    availableToEdit: string;
    conflictWarning: string;
    saveErrorOffline: string;
    backToProject: string;
    searchOrCommand: string;
    notepadUnavailable: string;
    notepadNoLongerAvailable: string;
    hideOutline: string;
    showOutline: string;
    onThisPage: string;
    noHeadingsYet: string;
    closeOutline: string;
    embedFile: string;
    fileUrl: string;
    validUrlPrompt: string;
    couldNotEmbedFile: string;
    attachmentCannotBeEdited: string;
    startWithTemplate: string;
    insertMedia: string;
    projectLibrary: string;
    link: string;
    youtubeInlineNote: string;
    couldNotInsertMedia: string;
    linkNotepad: string;
    createNew: string;
    existingNotepad: string;
    notepadTitle: string;
    notepadTitlePlaceholder: string;
    createAndLink: string;
    searchNotepadsPlaceholder: string;
    noMatchingNotepads: string;
    typeToSearch: string;
    createAndLinkTaskCard: string;
    selectBoard: string;
    selectBoardPlaceholder: string;
    column: string;
    selectBoardFirst: string;
    taskTitle: string;
    taskTitlePlaceholder: string;
    createAndInsertLink: string;
    linkBoard: string;
    loadingBoards: string;
    noBoardsFound: string;
  };
  settings: {
    title: string;
    subtitle: string;
    profileAndAccount: string;
    workspaceRole: string;
    logOut: string;
    workspaceSection: string;
    workspaceNameLabel: string;
    saveWorkspaceName: string;
    leaveWorkspace: string;
    leaveWorkspaceNotice: string;
    projectSettingsTitle: string;
    configuringProject: string;
    selectProjectPlaceholder: string;
    projectNameLabel: string;
    projectIconLabel: string;
    accentColorLabel: string;
    saveProjectChanges: string;
    dangerZone: string;
    archiveProject: string;
    unarchiveProject: string;
    deleteProject: string;
    tagManagementTitle: string;
    tagManagementDesc: string;
    newTagNamePlaceholder: string;
    addTag: string;
    noTagsYet: string;
    fileUploadsTitle: string;
    fileUploadsDesc: string;
    maxFileSizeMb: string;
    allowedFileTypes: string;
    saveUploadSettings: string;
    ownerUploadOnly: string;
    confirmLeaveTitle: string;
    confirmLeaveMessage: string;
    confirmArchiveTitle: string;
    confirmArchiveMessage: string;
    confirmDeleteProjectTitle: string;
    confirmDeleteProjectMessage: string;
    confirmDeleteTagTitle: string;
    confirmDeleteTagMessage: string;
    loadingProjectSettings: string;
    unableToLoadProjectSettings: string;
    selectAvailableProject: string;
    noProjectsAvailableDesc: string;
    tagCreated: string;
    tagDeleted: string;
  };
  members: {
    title: string;
    subtitle: string;
    inviteTeammate: string;
    teammateEmailPlaceholder: string;
    generateInvite: string;
    invitingButton: string;
    inviteCreatedSuccess: string;
    inviteLinkTitle: string;
    openLink: string;
    copyLink: string;
    inviteTokenTitle: string;
    copyToken: string;
    inviteHelpNotice: string;
    membersCount: string;
    pendingInvitesCount: string;
    revokeInvite: string;
    removeMember: string;
    confirmRemoveMemberTitle: string;
    confirmRemoveMemberMessage: string;
  };
  trash: {
    title: string;
    subtitle: string;
    allTab: string;
    notepadsTab: string;
    boardsTab: string;
    trashEmptyTitle: string;
    trashEmptyDesc: string;
    restoreButton: string;
    deletePermanentlyButton: string;
    deletedAt: string;
    confirmPermanentDeleteTitle: string;
    confirmPermanentDeleteNotepad: string;
    confirmPermanentDeleteBoard: string;
    permanentlyDeleteConfirmLabel: string;
  };
  system: {
    updateAvailable: string;
    newVersionAvailable: string;
  };
  notifications: {
    title: string;
    markAllRead: string;
    noNotifications: string;
    mentionedYouIn: string;
    assignedYouTo: string;
    aTask: string;
  };
  commandPalette: {
    title: string;
    searchPlaceholder: string;
    scopeProject: string;
    scopeAll: string;
    loadingProject: string;
    unableToLoadProjects: string;
    projectNotFound: string;
    selectProjectToSearch: string;
    searching: string;
    noResultsFound: string;
    searchResults: string;
    recentNotepads: string;
    navigation: string;
    projectOverview: string;
    boardPrefix: string;
    trash: string;
    membersAndInvites: string;
    settings: string;
    logOut: string;
    footerNavigate: string;
    footerSelect: string;
    footerClose: string;
    footerUse: string;
  };
  shortcuts: {
    title: string;
    global: string;
    board: string;
    editor: string;
    commandPalette: string;
    showHelp: string;
    focusNextCard: string;
    focusPrevCard: string;
    focusNextCol: string;
    focusPrevCol: string;
    openCard: string;
    quickPeek: string;
    quickAddCard: string;
    setPriority: string;
    setAssignee: string;
    slashCommands: string;
    mention: string;
    heading: string;
  };
  media: {
    uploadFile: string;
    uploading: string;
    fileAddedSuccess: string;
    couldNotInsert: string;
    couldNotLoadPolicy: string;
    allowedSummary: string;
    searchFilesPlaceholder: string;
    loadingFiles: string;
    noFilesYet: string;
    noFilesMatch: string;
    projectImageDefault: string;
    projectLibraryTitle: string;
    projectLibrarySubtitle: string;
  };
}

export const en: TranslationDictionary = {
  common: {
    save: 'Save',
    saving: 'Saving…',
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
    reload: 'Reload',
    retry: 'Retry',
    copy: 'Copy',
    copied: 'Copied',
    open: 'Open',
    add: 'Add',
    remove: 'Remove',
    dismiss: 'Dismiss',
    update: 'Update',
    clear: 'Clear',
    all: 'All',
    name: 'Name',
    email: 'Email',
    role: 'Role',
    actions: 'Actions',
    overview: 'Overview',
    none: 'None',
    untitled: 'Untitled',
    roles: {
      owner: 'Owner',
      editor: 'Editor',
      viewer: 'Viewer',
      member: 'Member',
      you: 'You',
    },
    priorities: {
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      urgent: 'Urgent',
    },
    themes: {
      basalt: 'Basalt Dark',
      modern: 'Modern Dark',
      light: 'Warm Paper',
    },
    user: 'User',
    someone: 'Someone',
    favorite: 'Favorite',
    keyboardShortcuts: 'Keyboard shortcuts',
    archived: 'Archived',
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
  invite: {
    title: 'Workspace Invitation',
    joinWorkspace: 'Join {workspaceName}',
    invitedAs: "You've been invited to join as an {role}.",
    signedInAs: 'Signed in as:',
    invitedEmail: 'Invited email:',
    assignedRole: 'Assigned role:',
    accountMismatch: 'Account Mismatch',
    accountMismatchDesc:
      'You are signed in as {currentEmail}, but this invitation was sent to {invitedEmail}.',
    accountMismatchAction:
      'Please sign out below to accept this invitation using the invited account.',
    acceptAndJoin: 'Accept & Join {workspaceName}',
    joiningWorkspace: 'Joining workspace…',
    signOutDifferentAccount: 'Sign out to use a different account',
    inviteToken: 'Invite Token',
    copyToken: 'Copy Token',
    accountDetected: 'Account Detected',
    accountDetectedDesc:
      'An account with {email} already exists. Please log in with your password to join {workspaceName}.',
    createAccountTab: 'Create Account',
    signInTab: 'Sign In',
    fullName: 'Full Name',
    password: 'Password',
    createAccountAndJoin: 'Create Account & Join',
    signInAndJoin: 'Sign In & Join',
    invalidOrExpired: 'Invalid or Expired Invitation',
    invalidOrExpiredDesc:
      'This invitation link is not valid or has expired. Please ask your workspace owner to send you a new invite.',
    providedToken: 'Provided token:',
    goToLogin: 'Go to Login',
    preferStandardLogin: 'Prefer standard login page? Open here',
    loadingDetails: 'Loading invitation details…',
  },
  router: {
    chooseWorkspace: 'Choose a workspace',
    createWorkspace: 'Create a workspace',
    createWorkspaceDesc: 'Your account has no workspace yet. Create one to get started.',
    workspaceName: 'Workspace name',
    createWorkspaceButton: 'Create workspace',
    creatingWorkspace: 'Creating…',
    loadingWorkspaces: 'Loading workspaces…',
    couldNotLoadWorkspaces: 'Could not load your workspaces.',
    tryAgain: 'Try again',
    redirectingToSignIn: 'Redirecting to sign in…',
    loadingWorkspace: 'Loading workspace…',
    couldNotLoadWorkspace: 'Could not load this workspace.',
    workspaceUnavailable: 'Workspace unavailable.',
    loadingProjects: 'Loading projects…',
    couldNotLoadProjects: 'Could not load projects for this workspace.',
    openingProject: 'Opening project…',
    noActiveProjects: 'No active projects in this workspace. Create a project from the sidebar.',
    loadingProject: 'Loading project…',
    projectUnavailableInWorkspace: 'This project is unavailable in the selected workspace.',
    chooseAnotherProject: 'Choose another project',
    resolvingProjectLink: 'Resolving this project link…',
    couldNotVerifyProjectLink: 'Could not verify this project link.',
    projectLinkUnavailable:
      'This project link is unavailable or matches more than one workspace.',
    selectNotepad: 'Select a notepad',
    boardNotFound: 'Board not found',
    somethingWentWrong: 'Something went wrong',
    unexpectedError: 'An unexpected error occurred.',
    reloadPage: 'Reload Page',
    resolvingWorkspaceLink: 'Resolving workspace link…',
    couldNotVerifyWorkspaceLink: 'Could not verify this workspace link.',
    uniqueWorkspaceRequired: 'This link needs a unique workspace selection.',
    openingWorkspace: 'Opening workspace…',
    loadingBurrow: 'Loading Burrow…',
  },
  sidebar: {
    overview: 'Burrow Overview',
    search: 'Search',
    searchPlaceholder: 'Search or command',
    membersAndSettings: 'Members & Settings',
    workspaceMembers: 'Workspace Members',
    projectSettings: 'Project Settings',
    trash: 'Trash',
    accountMenu: 'Account menu',
    logOut: 'Log out',
    updateAvailable: 'Update available',
    project: 'Project',
    projectLibrary: 'Project library',
    myTasks: 'My tasks',
    favorites: 'Favorites',
    noFavoritesYet: 'No favorited notepads yet',
    notepads: 'Notepads',
    collapseNotepads: 'Collapse Notepads',
    expandNotepads: 'Expand Notepads',
    newNotepad: 'New notepad',
    untitled: 'Untitled',
    boards: 'Boards',
    collapseBoards: 'Collapse Boards',
    expandBoards: 'Expand Boards',
    createBoard: 'Create Board',
    noBoardsYet: 'No boards yet',
    deleteBoardToTrash: 'Delete board to Trash',
    tags: 'Tags',
    workspace: 'Workspace',
    workflowTags: 'Workflow Tags',
    allNotepads: 'All Notepads',
    noMatchesFound: 'No matches found',
    openPalette: 'Open ⌘K Palette',
    openTasksBoard: 'Open Tasks Board',
    noActiveTasks: 'No active tasks',
    dueCount: '{count} due',
    allFilter: 'All ({count})',
    dueFilter: 'Due ({count})',
    newBoard: 'New board',
    language: 'Language',
    languageSwitched: 'Language: {language}',
    openTrashView: 'Open Trash View',
    deletedNotepads: 'Deleted Notepads',
    noDeletedNotepads: 'No deleted notepads',
    deletedBoards: 'Deleted Boards',
    noDeletedBoards: 'No deleted boards',
    trashRetentionNotice: 'Items stay in trash until permanently deleted or restored.',
    theme: 'Theme',
    settings: 'Settings',
    newVersion: 'v{version}',
    closeSidebar: 'Close sidebar',
    confirmSignOutTitle: 'Log out',
    confirmSignOutMessage: 'Are you sure you want to log out of your account?',
    confirmDeleteBoardTitle: 'Move board to trash?',
    confirmDeleteBoardMessage:
      'Are you sure you want to move board "{name}" to trash? You can restore it later.',
    createBoardPromptTitle: 'Create Board',
    createBoardPromptMessage: 'Enter a name for the new board.',
    createBoardPromptPlaceholder: 'Board name',
    workspaces: 'Workspaces',
    selectWorkspace: 'Select workspace',
    createWorkspace: 'Create workspace',
    createWorkspaceTitle: 'Create Workspace',
    workspaceName: 'Workspace Name',
    workspaceNamePlaceholder: 'Workspace name',
    creatingWorkspace: 'Creating…',
    failedToCreateWorkspace: 'Failed to create workspace',
    switchWorkspaceAria: 'Switch workspace: {label}',
    projects: 'Projects',
    selectProject: 'Select project',
    newProject: 'New project',
    createProjectTitle: 'Create Project',
    projectName: 'Project Name',
    projectIcon: 'Project Icon',
    iconAndName: 'Icon & Name',
    projectNamePlaceholder: 'Project name',
    creatingProject: 'Creating…',
    failedToCreateProject: 'Failed to create project',
    switchProjectAria: 'Switch project: {label}',
    account: 'Account',
    openSidebar: 'Open sidebar',
    resizePanel: 'Resize sidebar panel',
    workspaceSettings: 'Workspace settings',
  },
  project: {
    overview: 'Project Overview',
    manageScopedResources: 'Manage notepads, cards, and boards scoped to this project.',
    openLibrary: 'Open project library',
    notepadsTitle: 'Notepads',
    notepadsDesc: 'Rich-text notes with nested tree hierarchy, slash commands, and covers.',
    addNotepad: 'Add Notepad',
    noNotepadsYet: 'No notepads yet. Click + in sidebar to create one.',
    kanbanBoardsTitle: 'Kanban Boards',
    kanbanBoardsDesc:
      'Visual task boards with drag-and-drop columns, priorities, assignees, and quick-add.',
    addBoard: 'Add Board',
    noBoardsYet: 'No boards yet. Click + to create one.',
    createBoardDialogTitle: 'Create Board',
    createBoardDialogMessage: 'Enter a name for the new board.',
    createBoardDialogDefault: 'Sprint Board',
    createBoardDialogPlaceholder: 'Board name',
    loadingProject: 'Loading project…',
    unableToLoad: 'Unable to load projects. Please try again.',
    projectNotFound:
      'Project not found or no longer available. Select a project from the sidebar.',
    noProjectsAvailable: 'No projects available. Create a project from the sidebar.',
    notepadCreated: 'Notepad created',
    mediaLibraryTitle: 'Project Media Library',
    mediaLibraryDesc: 'Manage files, images, and attachments uploaded to this project.',
    uploadFiles: 'Upload files',
    noFilesUploaded: 'No files uploaded to this project yet.',
  },
  tasks: {
    title: 'My Tasks',
    open: 'Open',
    completed: 'Completed',
    all: 'All',
    allProjects: 'All Projects',
    overdue: 'Overdue',
    dueToday: 'Due Today',
    upcoming: 'Upcoming / This Week',
    later: 'Later & No Due Date',
    noTasksAssigned: 'No tasks assigned to you. Enjoy the quiet!',
    noCompletedTasks: 'No completed tasks yet.',
    loadingTasks: 'Loading tasks…',
    markAsComplete: 'Mark as complete',
    markAsOpen: 'Mark as open',
    snoozeTomorrow: 'Snooze to tomorrow',
    snoozedSuccess: 'Task snoozed until tomorrow',
    taskMarkedComplete: 'Task marked as complete',
    taskReopened: 'Task re-opened',
  },
  boards: {
    views: {
      kanban: 'Kanban',
      list: 'List',
      calendar: 'Calendar',
    },
    addColumn: 'Add Column',
    newColumnPlaceholder: 'Column name',
    addCard: 'Add card',
    newCardPlaceholder: 'What needs to be done?',
    noCardsInColumn: 'No cards',
    cardDetails: 'Card Details',
    titlePlaceholder: 'Card title',
    descriptionPlaceholder: 'Add a description…',
    priority: 'Priority',
    assignee: 'Assignee',
    unassigned: 'Unassigned',
    dueDate: 'Due date',
    noDueDate: 'No due date',
    tags: 'Tags',
    subtasks: 'Subtasks',
    addSubtask: 'Add subtask',
    newSubtaskPlaceholder: 'Subtask title…',
    comments: 'Comments',
    addComment: 'Add a comment…',
    postComment: 'Post comment',
    deleteCard: 'Delete card',
    confirmDeleteCard: 'Delete card "{title}"?',
    filterByTag: 'Filter by tag',
    searchCards: 'Search cards…',
    columnOptions: 'Column options',
    renameColumn: 'Rename column',
    deleteColumn: 'Delete column',
    confirmDeleteColumn: 'Delete column "{name}" and all its cards?',
    loadingBoard: 'Loading board…',
    clickToRename: 'Click to rename',
    filterLabel: 'Filter:',
    allPriorities: 'All Priorities',
    allAssignees: 'All Assignees',
    allTags: 'All Tags',
    resetFilters: 'Reset filters',
    collapseColumn: 'Collapse column',
    dragToReorder: 'Drag to reorder',
    dropCardsHere: 'Drop cards here',
    wipLimitPromptTitle: 'Set WIP limit for "{name}"',
    wipLimitPromptMessage:
      'Enter maximum number of cards for this column (leave empty to remove limit):',
    wipLimitPlaceholder: 'e.g. 5',
    wipLimitValidation: 'WIP limit must be a number between 0 and 999',
    deleteColumnCardsMoved: 'Column deleted — {count} cards moved to {name}',
    columnDeleted: 'Column deleted',
    cardMovedToTrash: 'Card moved to trash',
    undo: 'Undo',
    loadingCard: 'Loading card…',
    noWorkspaceMembers: 'No workspace members',
    noTagsInProject: 'No tags in project',
    newTag: 'New tag',
    cardNotesAndBody: 'Card Notes & Body',
    discussion: 'Discussion',
    loadingComments: 'Loading comments…',
    noCommentsYet: 'No comments yet. Start the discussion — use @ to mention teammates.',
    writeCommentPlaceholder: 'Write a comment… (@mention · ⌘↵ to send)',
    sendComment: 'Send (⌘+Enter)',
    confirmDeleteCommentTitle: 'Delete comment?',
    confirmDeleteCommentMessage:
      'Are you sure you want to delete this comment? This cannot be undone.',
    unscheduled: 'Unscheduled',
    today: 'Today',
    previousMonth: 'Previous month',
    nextMonth: 'Next month',
    filterByPriority: 'Filter by priority',
    filterByAssignee: 'Filter by assignee',
    deleteComment: 'Delete comment',
    markComplete: 'Mark complete',
    markIncomplete: 'Mark incomplete',
    removeSubtask: 'Remove subtask',
    expandColumn: 'Expand column',
    columnNamePlaceholder: 'Column name…',
    quickAddPlaceholder: 'Type a title, / for commands, @ for members, # for tags…',
    quickAddCommands: 'Quick-Add Commands',
    dueDatePlaceholder: 'e.g. tomorrow, next fri, Oct 3',
    wipLimitMenu: 'WIP limit…',
    inColumn: 'in {name}',
    assignMember: 'Assign Member',
    noMembersFound: 'No members found',
    createTagNamed: 'Create tag "#{name}"',
    noTagsYet: 'No tags yet. Type to create one!',
    failedToCreateTag: 'Failed to create tag',
    failedToCreateCard: 'Failed to create card',
    slashNotepadDesc: 'Create new linked notepad',
    slashDueDesc: 'Set due date (e.g. tomorrow, Oct 12)',
    slashPriorityDesc: 'Set priority (urgent, high, medium, low)',
    setPriority: 'Set priority',
    addProjectTag: 'Add project tag',
  },
  editor: {
    untitled: 'Untitled',
    writeSomething: "Start writing, or press '/' for commands…",
    documentOutline: 'Outline',
    noHeadings: 'No headings in this document yet.',
    filesAndMedia: 'Files & Media',
    uploadFile: 'Upload file',
    templates: 'Templates',
    chooseTemplate: 'Choose a template',
    blankDocument: 'Blank Document',
    meetingNotes: 'Meeting Notes',
    projectSpec: 'Project Specification',
    weeklyReview: 'Weekly Review',
    useTemplate: 'Use Template',
    lastSaved: 'Last saved',
    saving: 'Saving…',
    saved: 'Saved',
    offline: 'Offline',
    wordCount: '{count} words',
    lockStatus: 'Editing lock',
    lockHeldBy: 'Currently being edited by {name}',
    takeOverLock: 'Take over editing',
    insertYoutube: 'Embed YouTube Video',
    youtubePlaceholder: 'Paste YouTube URL…',
    insertLink: 'Insert Link',
    referenceCard: 'Reference Card',
    referenceNotepad: 'Reference Notepad',
    notepads: 'Notepads',
    share: 'Share',
    shareNotepad: 'Share notepad…',
    applyTemplate: 'Apply a template…',
    exportMarkdown: 'Export to Markdown',
    printExportPdf: 'Print / Export as PDF',
    deleteToTrash: 'Delete to Trash',
    deleteNotepadTitle: 'Delete notepad',
    deleteNotepadConfirm: 'Move "{title}" to Trash? You can restore it from Trash if needed.',
    emptyPagePrompt: 'This page is empty — start from a template?',
    browseTemplates: 'Browse templates',
    writeFromScratch: 'Write from scratch',
    backlinks: 'Backlinks ({count})',
    failed: 'Failed',
    retrySave: 'Retry save',
    discard: 'Discard',
    tag: 'Tag',
    searchOrNewTag: 'Search or new tag…',
    createTag: 'Create "#{name}"',
    noOtherTags: 'No other tags. Type to create.',
    shareCopied: 'Notepad link copied to clipboard',
    tagCreated: 'Tag #{name} created',
    editHereInstead: 'Edit Here Instead',
    checkAvailability: 'Check Availability',
    startEditing: 'Start Editing',
    reload: 'Reload',
    overwrite: 'Overwrite',
    readOnlyOtherTab: 'You are currently editing this notepad in another window or tab (read-only).',
    readOnlyOtherUser: '{name} is currently editing this notepad (read-only).',
    availableToEdit: 'This notepad is now available to edit.',
    conflictWarning: 'This notepad changed elsewhere. Reload to get latest changes or overwrite.',
    saveErrorOffline: 'Could not save changes to server. Your edits are held locally.',
    backToProject: 'Back to project',
    searchOrCommand: 'Search or command',
    notepadUnavailable: 'Notepad Unavailable',
    notepadNoLongerAvailable: 'This notepad is no longer available.',
    hideOutline: 'Hide outline',
    showOutline: 'Show outline (table of contents)',
    onThisPage: 'On this page',
    noHeadingsYet: 'No headings yet. Add H1–H3 blocks to build an outline.',
    closeOutline: 'Close outline',
    embedFile: 'Embed file',
    fileUrl: 'File URL',
    validUrlPrompt: 'Enter a valid HTTP or HTTPS URL',
    couldNotEmbedFile: 'Could not embed this file',
    attachmentCannotBeEdited: 'This attachment can no longer be edited',
    startWithTemplate: 'Start with a template',
    insertMedia: 'Insert media',
    projectLibrary: 'Project library',
    link: 'Link',
    youtubeInlineNote: 'YouTube videos play inline. Other websites are inserted as links.',
    couldNotInsertMedia: 'Could not insert media. Try again.',
    linkNotepad: 'Link Notepad',
    createNew: 'Create New',
    existingNotepad: 'Existing Notepad',
    notepadTitle: 'Notepad Title',
    notepadTitlePlaceholder: 'e.g., Project Specifications',
    createAndLink: 'Create & Link',
    searchNotepadsPlaceholder: 'Search notepads…',
    noMatchingNotepads: 'No matching notepads',
    typeToSearch: 'Type to search',
    createAndLinkTaskCard: 'Create & Link Task Card',
    selectBoard: 'Select Board',
    selectBoardPlaceholder: 'Select a board…',
    column: 'Column',
    selectBoardFirst: 'Select board first',
    taskTitle: 'Task Title',
    taskTitlePlaceholder: 'e.g., Fix login bug',
    createAndInsertLink: 'Create & Insert Link',
    linkBoard: 'Link Board',
    loadingBoards: 'Loading boards…',
    noBoardsFound: 'No boards found in this project',
  },
  settings: {
    title: 'Settings',
    subtitle: 'Manage your profile, project preferences, and workflow tags.',
    profileAndAccount: 'Profile & Account',
    workspaceRole: 'Workspace Role:',
    logOut: 'Log out',
    workspaceSection: 'Workspace',
    workspaceNameLabel: 'Workspace name',
    saveWorkspaceName: 'Save workspace name',
    leaveWorkspace: 'Leave workspace',
    leaveWorkspaceNotice:
      'A workspace owner must promote another owner before leaving if they are the last owner.',
    projectSettingsTitle: 'Project Settings',
    configuringProject: 'Configuring:',
    selectProjectPlaceholder: 'Select a project',
    projectNameLabel: 'Project Name',
    projectIconLabel: 'Project Icon',
    accentColorLabel: 'Accent Color',
    saveProjectChanges: 'Save Changes',
    dangerZone: 'Danger Zone',
    archiveProject: 'Archive Project',
    unarchiveProject: 'Unarchive Project',
    deleteProject: 'Delete Project…',
    tagManagementTitle: 'Tag Management',
    tagManagementDesc:
      'Tags scoped to {projectName}. Use tags on kanban cards to group tasks and filter work.',
    newTagNamePlaceholder: 'New tag name (e.g. bug, urgent)',
    addTag: 'Add Tag',
    noTagsYet: 'No tags created for this project yet.',
    fileUploadsTitle: 'File uploads',
    fileUploadsDesc:
      'Choose the file types and maximum size allowed in this project. Existing files remain available.',
    maxFileSizeMb: 'Maximum file size (MB)',
    allowedFileTypes: 'Allowed file types',
    saveUploadSettings: 'Save upload settings',
    ownerUploadOnly: 'Only workspace owners can change upload settings.',
    confirmLeaveTitle: 'Leave workspace',
    confirmLeaveMessage: 'Leave "{name}"? You will lose access to its projects and content.',
    confirmArchiveTitle: '{action} Project',
    confirmArchiveMessage: 'Are you sure you want to {action} "{name}"?',
    confirmDeleteProjectTitle: 'Delete Project',
    confirmDeleteProjectMessage:
      'Are you sure you want to delete project "{name}"? Type the project name to confirm.',
    confirmDeleteTagTitle: 'Delete Tag',
    confirmDeleteTagMessage:
      'Are you sure you want to delete tag "#{name}"? Cards with this tag will keep their content.',
    loadingProjectSettings: 'Loading project settings…',
    unableToLoadProjectSettings: 'Unable to load project settings.',
    selectAvailableProject: 'Select an available project.',
    noProjectsAvailableDesc: 'No projects available.',
    tagCreated: 'Tag created',
    tagDeleted: 'Tag deleted',
  },
  members: {
    title: 'Workspace Members',
    subtitle: 'Manage workspace teammates, roles, and pending invitations.',
    inviteTeammate: 'Invite a teammate',
    teammateEmailPlaceholder: 'colleague@example.com',
    generateInvite: 'Generate Invite',
    invitingButton: 'Inviting…',
    inviteCreatedSuccess: 'Invitation created for {email} ({role})',
    inviteLinkTitle: 'Invite Link (for one-click sign-up)',
    openLink: 'Open link',
    copyLink: 'Copy Link',
    inviteTokenTitle: 'Invite Token (for manual entry on registration page)',
    copyToken: 'Copy Token',
    inviteHelpNotice:
      'The recipient can click the link to register instantly, or enter this invite token manually if they are on the sign-up page.',
    membersCount: 'Members ({count})',
    pendingInvitesCount: 'Pending Invites ({count})',
    revokeInvite: 'Revoke',
    removeMember: 'Remove member',
    confirmRemoveMemberTitle: 'Remove Member',
    confirmRemoveMemberMessage: 'Are you sure you want to remove "{name}" from the workspace?',
  },
  trash: {
    title: 'Trash',
    subtitle:
      'Items in trash for project {projectName}. Restored notepads are re-attached to their parent, or to the project root if the parent is still in trash.',
    allTab: 'All ({count})',
    notepadsTab: 'Notepads ({count})',
    boardsTab: 'Boards ({count})',
    trashEmptyTitle: 'Trash is empty',
    trashEmptyDesc:
      'Deleted notepads and boards will appear here. You can restore them or permanently delete them anytime.',
    restoreButton: 'Restore',
    deletePermanentlyButton: 'Delete',
    deletedAt: 'Deleted {date}',
    confirmPermanentDeleteTitle: 'Permanently delete {type}?',
    confirmPermanentDeleteNotepad:
      'Are you sure you want to permanently delete "{name}"? This cannot be undone.',
    confirmPermanentDeleteBoard:
      'Are you sure you want to permanently delete board "{name}" and all its cards? This cannot be undone.',
    permanentlyDeleteConfirmLabel: 'Permanently Delete',
  },
  system: {
    updateAvailable: 'Update available',
    newVersionAvailable: 'New version available',
  },
  notifications: {
    title: 'Notifications',
    markAllRead: 'Mark all read',
    noNotifications: 'No notifications yet',
    mentionedYouIn: 'mentioned you in',
    assignedYouTo: 'assigned you to',
    aTask: 'a task',
  },
  commandPalette: {
    title: 'Search and commands',
    searchPlaceholder: 'Search notepads, cards, or type a command…',
    scopeProject: 'Project',
    scopeAll: 'All',
    loadingProject: 'Loading project…',
    unableToLoadProjects: 'Unable to load projects. Please try again.',
    projectNotFound: 'Project not found or no longer available. Select a project from the sidebar.',
    selectProjectToSearch: 'Select a project to search within it.',
    searching: 'Searching…',
    noResultsFound: 'No matching results found for "{query}".',
    searchResults: 'Search Results',
    recentNotepads: 'Recent Notepads',
    navigation: 'Navigation',
    projectOverview: 'Project Overview',
    boardPrefix: 'Board: {name}',
    trash: 'Trash',
    membersAndInvites: 'Members & Invites',
    settings: 'Settings',
    logOut: 'Log out',
    footerNavigate: 'to navigate',
    footerSelect: 'to select',
    footerClose: 'to close',
    footerUse: 'Use',
  },
  shortcuts: {
    title: 'Keyboard shortcuts',
    global: 'Global',
    board: 'Board',
    editor: 'Editor',
    commandPalette: 'Command palette',
    showHelp: 'Show this shortcuts help',
    focusNextCard: 'Focus next card in column',
    focusPrevCard: 'Focus previous card in column',
    focusNextCol: 'Focus first card in next column',
    focusPrevCol: 'Focus first card in previous column',
    openCard: 'Open the focused card',
    quickPeek: 'Quick-peek the focused card',
    quickAddCard: 'Quick-add a card to the focused column',
    setPriority: 'Set priority of the focused card',
    setAssignee: 'Set assignee of the focused card',
    slashCommands: 'Slash commands (template, mention…)',
    mention: 'Mention',
    heading: 'Heading (Markdown)',
  },
  media: {
    uploadFile: 'Upload file',
    uploading: 'Uploading…',
    fileAddedSuccess: 'File added to project library',
    couldNotInsert: 'Could not insert the uploaded file',
    couldNotLoadPolicy: 'Could not load upload settings.',
    allowedSummary: '{count} allowed file types · Up to {sizeMb} MB',
    searchFilesPlaceholder: 'Search files…',
    loadingFiles: 'Loading files…',
    noFilesYet: 'No files uploaded to this project yet.',
    noFilesMatch: 'No files match your search.',
    projectImageDefault: 'Project file',
    projectLibraryTitle: 'Project library',
    projectLibrarySubtitle: 'Files shared across this project.',
  },
};
