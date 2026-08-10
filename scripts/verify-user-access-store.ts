/**
 * Store round-trip for access management (app_users) against an ISOLATED
 * throwaway SQLite DB. Proves the SQL in lib/auth/users.ts actually runs and
 * that the registry it hydrates produces the roles rbac.ts then reports — the
 * half a typecheck cannot see.
 *
 * Covers: create-on-add (pre-authorising someone before their first sign-in),
 * role change, revoke-as-tombstone beating the hardcoded admin list, restore,
 * refusal to touch the owner, junk-email refusal, and the fact that a
 * recordUserSeen() on a downgraded operator does NOT silently re-promote them.
 *
 * Only node built-ins and `import type` are static here — the store is
 * dynamically imported AFTER the chdir so its prisma singleton binds to the
 * temp DB.
 *
 * Run:  pnpm exec tsx scripts/verify-user-access-store.ts   (exit 1 on failure)
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalCwd = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), 'user-access-store-'));
mkdirSync(join(tmp, 'data'), { recursive: true });
process.chdir(tmp);

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function teardown(): void {
  process.chdir(originalCwd);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows keeps a handle on the SQLite file briefly after disconnect.
    // A leftover temp dir is harmless; failing the run over it would not be.
  }
}

const OWNER = 'charan192219@gmail.com';
const CODE_ADMIN = 'kesardevi22161@gmail.com';
const GUEST = 'guest@example.com';
const NO_VIEWERS = '';

console.log('=== Store round-trip (throwaway DB): app_users access management ===\n');

try {
  const { listUsers, recordUserSeen, refreshRoleRegistry, removeUser, setUserRole } = await import(
    '../lib/auth/users'
  );
  const { roleForGoogleEmail } = await import('../lib/auth/rbac');

  // --- pre-authorise someone who has never signed in ---------------------
  await setUserRole(GUEST, 'viewer');
  check('add creates a row for an unseen email', (await listUsers()).some((u) => u.email === GUEST));
  check('added user resolves as viewer', roleForGoogleEmail(GUEST, NO_VIEWERS) === 'viewer');

  // --- promote / demote ---------------------------------------------------
  await setUserRole(GUEST, 'admin');
  check('role change to admin takes effect', roleForGoogleEmail(GUEST, NO_VIEWERS) === 'admin');
  await setUserRole(GUEST, 'viewer');
  check('role change back to viewer takes effect', roleForGoogleEmail(GUEST, NO_VIEWERS) === 'viewer');
  check('role change did not duplicate the row', (await listUsers()).filter((u) => u.email === GUEST).length === 1);

  // --- revoke is a tombstone, and it BEATS the code admin list -----------
  const revoked = await removeUser(GUEST);
  check('revoke reports the normalised email', revoked.email === GUEST);
  check('revoked user is denied', roleForGoogleEmail(GUEST, NO_VIEWERS) === null);
  const guestRow = (await listUsers()).find((u) => u.email === GUEST);
  check('revoke KEEPS the row as a tombstone', guestRow?.status === 'revoked', `status=${guestRow?.status}`);

  await setUserRole(CODE_ADMIN, 'admin');
  check('code-listed operator starts as admin', roleForGoogleEmail(CODE_ADMIN, NO_VIEWERS) === 'admin');
  const revokedAdmin = await removeUser(CODE_ADMIN);
  check('revoke reports that the email is also in code', revokedAdmin.wasCodeAdmin === true);
  check(
    'revoke actually denies a code-listed admin (the Remove button is not a lie)',
    roleForGoogleEmail(CODE_ADMIN, NO_VIEWERS) === null
  );

  // --- restore ------------------------------------------------------------
  await setUserRole(CODE_ADMIN, 'viewer');
  check('restore flips status back to active', roleForGoogleEmail(CODE_ADMIN, NO_VIEWERS) === 'viewer');

  // --- a sign-in must NOT silently re-promote a downgraded operator -------
  await recordUserSeen({ email: CODE_ADMIN, name: 'Second Operator', image: null });
  await refreshRoleRegistry({ force: true });
  check(
    'recordUserSeen does not undo an owner downgrade',
    roleForGoogleEmail(CODE_ADMIN, NO_VIEWERS) === 'viewer',
    `got ${roleForGoogleEmail(CODE_ADMIN, NO_VIEWERS)}`
  );

  // --- the owner cannot be touched ---------------------------------------
  let ownerSetRefused = false;
  try {
    await setUserRole(OWNER, 'viewer');
  } catch {
    ownerSetRefused = true;
  }
  check('setUserRole refuses the owner', ownerSetRefused);
  let ownerRemoveRefused = false;
  try {
    await removeUser(OWNER);
  } catch {
    ownerRemoveRefused = true;
  }
  check('removeUser refuses the owner', ownerRemoveRefused);
  check('owner still resolves as admin', roleForGoogleEmail(OWNER, NO_VIEWERS) === 'admin');

  // --- junk input is refused before it becomes a permanent row -----------
  for (const junk of ['', '   ', 'not-an-email', 'no@domain', 'two@@at.com', 'spa ce@x.com']) {
    let refused = false;
    try {
      await setUserRole(junk, 'viewer');
    } catch {
      refused = true;
    }
    check(`junk email refused: '${junk}'`, refused);
  }

  // --- REGRESSION GUARD: merely signing in must never confer access -------
  // recordUserSeen() writes a row for every account that authenticates. If the
  // registry treated "has a row" as "has access", shipping it would silently
  // grant viewer access to everyone who ever visited — which is exactly the bug
  // caught on 2026-08-10 against the real dev database (two historical accounts
  // that are NOT in GOOGLE_VIEWER_EMAILS would have been let back in).
  const SEEN_ONLY = 'seen-only@example.com';
  await recordUserSeen({ email: SEEN_ONLY, name: 'Passer By', image: null });
  await refreshRoleRegistry({ force: true });
  const seenRow = (await listUsers()).find((u) => u.email === SEEN_ONLY);
  check('recordUserSeen does create a row', seenRow !== undefined);
  check('a merely-seen row carries NO grant stamp', seenRow?.grantedAt == null, `grantedAt=${seenRow?.grantedAt}`);
  check(
    'a merely-seen account is DENIED (signing in never grants access)',
    roleForGoogleEmail(SEEN_ONLY, NO_VIEWERS) === null,
    `got ${roleForGoogleEmail(SEEN_ONLY, NO_VIEWERS)}`
  );
  // ...and an explicit grant on top of that same row does work.
  await setUserRole(SEEN_ONLY, 'viewer');
  const grantedRow = (await listUsers()).find((u) => u.email === SEEN_ONLY);
  check('an explicit grant stamps grantedAt', grantedRow?.grantedAt != null);
  check('granting a seen-only account lets them in', roleForGoogleEmail(SEEN_ONLY, NO_VIEWERS) === 'viewer');

  // --- hydration is idempotent -------------------------------------------
  await refreshRoleRegistry({ force: true });
  await refreshRoleRegistry({ force: true });
  check('repeated hydration is stable', roleForGoogleEmail(CODE_ADMIN, NO_VIEWERS) === 'viewer');
  check('unlisted stranger still denied after hydration', roleForGoogleEmail('who@example.com', NO_VIEWERS) === null);
} catch (err) {
  check(`unexpected error: ${(err as Error).message}`, false);
} finally {
  teardown();
}

console.log(`\n${failures === 0 ? '✅ all user-access store checks passed' : `❌ ${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
