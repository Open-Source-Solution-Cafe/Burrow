# Bootstrap recovery and migration checks

Bootstrap creates the first workspace and its owner. The reservation, account
creation and workspace creation are separate steps, so a failed signup can leave
an account with a reserved email but no workspace. Burrow keeps that reservation
instead of assigning the workspace to another account.

## Recover an interrupted first signup

1. Keep the same Burrow deployment and database. Identify the email used for the
   initial signup and obtain the configured `BOOTSTRAP_TOKEN` from the deployment's
   secret store or the trusted operator who created it.
2. Sign in to that account. The signup response may have failed after the account
   was created, so retrying signup alone can report that the account already exists.
3. Use the bootstrap recovery flow, providing the bootstrap token while signed in.
   The server checks both the token and the account associated with the reservation.
   It creates the starter workspace and owner membership atomically. Repeating a
   successful recovery for the same account returns the existing workspace.

The underlying API is `POST /api/auth/bootstrap/recover` with the signed-in
session and JSON body `{ "bootstrapToken": "..." }`. A successful response is
`{ "workspaceId": "..." }`. A `401` indicates that a signed-in account with an
email is required; `403` indicates an invalid bootstrap token; `409` means the
reservation cannot be completed for that account or initialization is unavailable.
Treat a server error as an incomplete operation and investigate the server logs
before retrying. Do not put the token or session cookie in tickets, logs, URLs, or
shared command history.

If signup failed before an account was created, retry signup using the **same
email** and bootstrap token. A reservation does not expire automatically. If
the reserved email was mistyped or its account cannot be authenticated, there is
currently no supported automatic reassignment or claim-reset command. Keep the
service in maintenance, preserve a backup, and investigate with the deployment
operator; do not edit or delete the reservation or create an owner by hand. A
stale in-flight signup could otherwise finish against a changed claim.

## Check an existing database before migration

Use a maintenance window: stop writes and in-flight signup requests, then make
and verify a restorable backup of the database and associated file metadata.
The normal Cloudflare deployment script applies pending D1 migrations before it
deploys the new code; it does not itself establish a maintenance window. Follow
the deployment's backup and restore process before running it. PostgreSQL upgrades
from a real populated legacy installation still need end-to-end validation; do
not treat the fresh baseline or minimal migration fixtures as proof of that path.

The bootstrap migration initializes a database containing workspaces as complete.
If there are accounts but no workspaces, it deliberately fails the
`bootstrap_state_valid` check rather than choosing an owner. Check the migration
error and inspect the affected database with read-only SQL:

```sql
SELECT count(*) AS workspace_count FROM workspaces;
SELECT count(*) AS account_count FROM "user";
```

Zero workspaces with one or more accounts matches this orphan-account condition.
Do not assume every check-constraint failure has that cause. Stop the rollout,
keep the backup and migration logs, and investigate how those accounts were
created and whether a compatible earlier backup can be restored. There is no
supported automatic orphan adoption procedure yet; do not fabricate membership,
mark initialization complete, or retry against a modified database without a
reviewed recovery plan. After resolving the underlying issue, verify the target
database and migration state before resuming the coordinated deployment.

## Multi-workspace membership migration window

The membership migration removes the global uniqueness rule on `members.user_id`
for SQLite/D1 and replaces it with a non-unique lookup index. PostgreSQL gets the
non-unique lookup index. This allows one account to belong to multiple workspaces.
The old application is not compatible with data created by multi-membership
writes, so keep every writer paused until the migration and new application are
both deployed and validated.

### Before the window

1. Schedule a maintenance window and notify operators. Stop web, Worker, Node,
   background, invite-acceptance, signup/recovery, and other write entry points.
   Drain in-flight requests before touching the database. Keep the service in
   maintenance through post-migration validation.
2. Record the currently deployed code version and migration ledgers. Prepare the
   new release and its matching schema migrations, and retain the old release for
   recovery. Confirm that the target workspace/account APIs and client are in the
   release; do not deploy the schema independently and resume old writers.
3. Take a restorable snapshot of the database and associated file metadata and
   object storage at the same point in time. Record the snapshot IDs and verify
   that the restore procedure works in an isolated environment. A database-only
   snapshot is insufficient when file metadata and blobs must remain consistent.
4. Run `pnpm check`, `pnpm build`, and the migration/API/adapter suites for the
   exact release. Do not proceed with a red gate or a failed migration test.

### Preflight the target data

Run the invariant check against each SQLite/D1 database that is part of the
rollout. Confirm the printed target banner is the intended database before
continuing:

```powershell
pnpm check:data
pnpm check:data --worker
pnpm check:data --remote
```

`pnpm check:data` checks the configured local SQLite database. `--worker` checks
the local persisted D1 database, and `--remote` checks production D1. Run only
the commands for databases you actually operate, and capture their full output.
Any failed command or reported row is a stop condition. Preserve the report and
backup; investigate and resolve corruption through a reviewed remediation plan.
Do not let migration code silently reassign a row to another workspace or
project.

These commands do not target PostgreSQL. Before a PostgreSQL rollout, set
`DATABASE_URL` to the target and run `pnpm check:data:postgres`; it executes
the PostgreSQL-specific I1–I13 audit in a read-only transaction. Retain its
results. The populated PostgreSQL upgrade fixture in
`tests/adapters/populated-legacy-migration-node.test.ts` covers workspaces,
projects, notes, boards, cards, tags, links, and deliberate cross-scope rows, but
that fixture remains unexecuted in this environment because Docker and an
explicit `BURROW_TEST_POSTGRES_URL` were unavailable. This fixture is test
coverage, not a substitute for the production data preflight or an upgrade drill.

### Inventory stored objects

Run the read-only storage inventory against each database and the object store it
uses:

```powershell
pnpm inventory:storage
pnpm inventory:storage -- --worker
pnpm inventory:storage -- --remote
```

The default command checks local SQLite with the configured local storage path.
`--worker` checks local persisted D1, and `--remote` checks remote D1. PostgreSQL
is selected when `DATABASE_URL` is a PostgreSQL URL and no explicit D1 target
flag is supplied. D1 inventories need `S3_ENDPOINT`, `S3_BUCKET`, and access
credentials for the configured S3-compatible R2 endpoint because a local CLI
cannot access a Worker R2 binding directly. The command only lists and compares:
it reports registered keys with no stored object and stored objects with no
project registration, returning a nonzero exit code when either list is
nonempty. Preserve the report and resolve discrepancies through a reviewed
recovery plan; the inventory never deletes or registers objects.

### Apply and validate

1. Keep writes paused. Deploy the matched release using the normal deployment
   path. For D1, `pnpm deploy` runs checks/build, records a Time Travel bookmark
   when available, applies pending remote migrations, deploys the Worker, and
   smoke-tests it. It applies the schema before the new code, so the maintenance
   pause must remain in place throughout the sequence. For Node/SQLite and
   PostgreSQL, use the standard release procedure that restarts the service with
   the new code; startup applies the pending migrations.
2. Verify the migration ledger and the new membership lookup index in each
   database. Confirm existing workspace, project, membership, content, link, tag,
   board, card, and file metadata counts and representative IDs match the backup
   plus any explicitly approved migration changes. Repeat the applicable
   `pnpm check:data` commands. For PostgreSQL, repeat the PostgreSQL-specific
   audit; the SQLite/D1 command does not validate it.
3. Smoke-test account identity, workspace listing/creation, invite acceptance,
   workspace context and switching, and project/resource access with accounts
   that have one and multiple memberships. Verify that writes include explicit
   workspace scope and that a revoked membership is denied. Keep the service in
   maintenance if any migration, invariant, or smoke check fails.
4. Resume writes only after the new code and migrated data pass these checks.
   Record the deployed code version, migration ledger, backup/snapshot IDs,
   invariant reports, and the time writes resumed.

### Code and data rollback

If the migration or release fails before writes resume, keep maintenance enabled,
restore the pre-upgrade database and matching file-metadata/object-storage backup,
then redeploy the old code version. Validate the restored state before reopening
the service.

After multi-membership writes have been accepted, **do not roll back by re-adding
the old unique index**. A user may now have memberships in several workspaces, so
the old index cannot represent the data and a downgrade could fail or require
discarding memberships. The old code also cannot safely interpret all data
created by the new release. To return to old code, stop writes and restore the
pre-upgrade database and matching file-metadata/object-storage backup, then deploy
the old code. This intentionally loses all writes made after that backup,
including new memberships, invitations, content, and file metadata. Preserve the
failed release database separately for later recovery or data extraction; do not
merge new rows into the restored database without a reviewed compatibility plan.

Prefer a forward fix when new writes have been accepted. Never reopen the service
on old code against a database that has accepted multi-membership writes, and do
not drop the backup until the rollback window has ended and the new release has
passed operational review.
