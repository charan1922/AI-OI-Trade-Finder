/**
 * DB-free CI verifier for the access policy in lib/auth/rbac.ts — who gets in,
 * with what role, and who may manage other users. Opens NO database (it drives
 * setRoleRegistry() directly, exactly as lib/auth/users.ts does), so it runs in
 * GitHub CI alongside the other verify-*.ts pure checks.
 *
 * This guards the properties that must never silently regress:
 *   • the owner can never be locked out, downgraded, or revoked
 *   • only the owner reaches /users and /api/users — a plain admin cannot
 *   • an owner revoke BEATS the hardcoded ADMIN_GOOGLE_EMAILS list (otherwise
 *     the Remove button would be a lie)
 *   • an unlisted account gets nothing (fails closed), including when the
 *     registry is empty because the database was unreachable
 *
 * Run:  pnpm exec tsx scripts/verify-user-access.ts   (exit 1 on any failure)
 */
import {
  ADMIN_GOOGLE_EMAILS,
  isAdminOnlyPage,
  isOwnerEmail,
  isOwnerOnlyPath,
  OWNER_GOOGLE_EMAILS,
  requiredPermission,
  roleForGoogleEmail,
  setRoleRegistry,
} from '../lib/auth/rbac';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const OWNER = 'charan192219@gmail.com';
const CODE_ADMIN = 'kesardevi22161@gmail.com';
const STRANGER = 'nobody@example.com';
const ADDED = 'added@example.com';
const NO_VIEWERS = ''; // GOOGLE_VIEWER_EMAILS unset

console.log('=== Pure verification (no DB): user access policy ===\n');

// --- constants are wired the way the UI and proxy assume -------------------
check('owner set contains the operator', OWNER_GOOGLE_EMAILS.has(OWNER));
check('owner set is a single account', OWNER_GOOGLE_EMAILS.size === 1, `size=${OWNER_GOOGLE_EMAILS.size}`);
check('code admin list contains the owner', ADMIN_GOOGLE_EMAILS.has(OWNER));
check('code admin list contains the second operator', ADMIN_GOOGLE_EMAILS.has(CODE_ADMIN));
check('isOwnerEmail is case/space insensitive', isOwnerEmail(`  ${OWNER.toUpperCase()} `));
check('isOwnerEmail rejects a non-owner admin', !isOwnerEmail(CODE_ADMIN));
check('isOwnerEmail rejects null/empty', !isOwnerEmail(null) && !isOwnerEmail(''));

// --- owner-only surfaces ---------------------------------------------------
check('/users is owner-only', isOwnerOnlyPath('/users'));
check('/api/users is owner-only', isOwnerOnlyPath('/api/users'));
check('a sub-path of /api/users is owner-only', isOwnerOnlyPath('/api/users/anything'));
check('/auto-trade is NOT owner-only (plain admin may trade)', !isOwnerOnlyPath('/auto-trade'));
check('/live is NOT owner-only', !isOwnerOnlyPath('/live'));
// Belt and braces: viewers must be blocked by the existing admin machinery too,
// so a bug in the owner check alone can never expose the page to a viewer.
check('/users is also admin-only (viewers blocked by the existing policy)', isAdminOnlyPage('/users'));
check(
  'GET /api/users requires a permission (not a free read)',
  requiredPermission('GET', '/api/users', new URLSearchParams()) === 'app:write'
);
check(
  'POST /api/users requires a permission',
  requiredPermission('POST', '/api/users', new URLSearchParams()) === 'app:write'
);

// --- empty registry (DB unreachable) must fail CLOSED ----------------------
setRoleRegistry([], []);
check('empty registry: owner still admin', roleForGoogleEmail(OWNER, NO_VIEWERS) === 'admin');
check('empty registry: code admin still admin', roleForGoogleEmail(CODE_ADMIN, NO_VIEWERS) === 'admin');
check('empty registry: stranger denied', roleForGoogleEmail(STRANGER, NO_VIEWERS) === null);
check('empty registry: added-but-unhydrated user denied', roleForGoogleEmail(ADDED, NO_VIEWERS) === null);

// --- a user added on /users is honoured -----------------------------------
setRoleRegistry([[ADDED, 'viewer']], []);
check('registry grants viewer', roleForGoogleEmail(ADDED, NO_VIEWERS) === 'viewer');
setRoleRegistry([[ADDED, 'admin']], []);
check('registry grants admin', roleForGoogleEmail(ADDED, NO_VIEWERS) === 'admin');
setRoleRegistry([['  ADDED@EXAMPLE.COM  ', 'admin']], []);
check('registry normalises case and whitespace', roleForGoogleEmail(ADDED, NO_VIEWERS) === 'admin');

// --- the registry may DOWNGRADE a hardcoded admin -------------------------
setRoleRegistry([[CODE_ADMIN, 'viewer']], []);
check('registry downgrades a code-listed admin to viewer', roleForGoogleEmail(CODE_ADMIN, NO_VIEWERS) === 'viewer');

// --- a revoke BEATS the hardcoded admin list ------------------------------
setRoleRegistry([], [CODE_ADMIN]);
check('revoke denies a code-listed admin', roleForGoogleEmail(CODE_ADMIN, NO_VIEWERS) === null);
setRoleRegistry([[ADDED, 'admin']], [ADDED]);
check('revoke wins over an active registry row for the same email', roleForGoogleEmail(ADDED, NO_VIEWERS) === null);
setRoleRegistry([], [`  ${CODE_ADMIN.toUpperCase()}  `]);
check('revoke matching normalises case/whitespace', roleForGoogleEmail(CODE_ADMIN, NO_VIEWERS) === null);

// --- but the OWNER is untouchable by any registry state -------------------
setRoleRegistry([[OWNER, 'viewer']], [OWNER]);
check('owner survives a revoke tombstone', roleForGoogleEmail(OWNER, NO_VIEWERS) === 'admin');
check('owner survives a viewer downgrade', roleForGoogleEmail(OWNER, NO_VIEWERS) === 'admin');
check('owner is still recognised as owner', isOwnerEmail(OWNER));

// --- the env viewer allowlist still works, and is lowest priority ---------
setRoleRegistry([], []);
check('env viewer allowlist grants viewer', roleForGoogleEmail(STRANGER, `${STRANGER}, other@x.com`) === 'viewer');
setRoleRegistry([[STRANGER, 'admin']], []);
check('registry outranks the env viewer list', roleForGoogleEmail(STRANGER, STRANGER) === 'admin');
setRoleRegistry([], [STRANGER]);
check('revoke outranks the env viewer list', roleForGoogleEmail(STRANGER, STRANGER) === null);

// --- null/garbage input --------------------------------------------------
setRoleRegistry([], []);
check('null email denied', roleForGoogleEmail(null, NO_VIEWERS) === null);
check('undefined email denied', roleForGoogleEmail(undefined, NO_VIEWERS) === null);
check('empty email denied', roleForGoogleEmail('', NO_VIEWERS) === null);

console.log(`\n${failures === 0 ? '✅ all user-access checks passed' : `❌ ${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
