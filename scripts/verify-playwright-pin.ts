/**
 * The Dockerfile's pinned Playwright version must equal the lockfile's.
 *
 * The runtime stage installs Chromium's OS libraries with a HARD-PINNED
 * `npx --yes playwright@<version> install-deps chromium`, deliberately, so that
 * apt layer caches instead of being re-run on every commit. The browser BINARY
 * comes from the builder stage, which uses the version pnpm actually installed.
 *
 * Those are two different sources for one version number. If they drift, the
 * image gets the OS libraries for one Chromium and the binary of another — and
 * Playwright's own version check then fails at RUNTIME, on the box, during a
 * trading session, which is the worst possible place to discover it. This check
 * makes that drift a CI failure instead.
 *
 * Run: npx tsx scripts/verify-playwright-pin.ts
 */
import { readFileSync } from 'node:fs';

const dockerfile = readFileSync('Dockerfile', 'utf8');
const lock = readFileSync('pnpm-lock.yaml', 'utf8');

// The pin in the runtime stage: `npx --yes playwright@1.62.1 install-deps ...`
const pinMatch = /playwright@(\d+\.\d+\.\d+)\s+install-deps/.exec(dockerfile);
// The version pnpm resolved. In a v9 lockfile the importer entry carries the
// resolved version alongside the specifier. Indentation is NOT hard-coded — it
// differs by nesting depth (6/8 spaces here, and a workspace layout would shift
// it again), and a brittle match reads as "version missing", which this check
// would then report as drift for the wrong reason.
const lockMatch = /(?:^|\n)\s+playwright:\s*\n\s+specifier:[^\n]*\n\s+version:\s*(\d+\.\d+\.\d+)/.exec(lock);

const fails: string[] = [];
if (pinMatch == null) {
  fails.push('Dockerfile has no `playwright@<version> install-deps` pin — did the runtime stage change?');
}
if (lockMatch == null) {
  fails.push('could not read the resolved playwright version from pnpm-lock.yaml');
}
if (pinMatch != null && lockMatch != null && pinMatch[1] !== lockMatch[1]) {
  fails.push(
    `version drift: Dockerfile pins playwright@${pinMatch[1]} but the lockfile resolved ${lockMatch[1]}.\n` +
      `  Update the \`npx --yes playwright@${lockMatch[1]} install-deps chromium\` line in the runtime stage.`,
  );
}

if (fails.length === 0) {
  console.log(`✅ Dockerfile playwright pin matches the lockfile (${pinMatch?.[1]})`);
  process.exitCode = 0;
} else {
  console.log('❌ playwright pin check failed:\n');
  for (const f of fails) console.log(`  ${f}`);
  process.exitCode = 1;
}
