/**
 * Every bare import must resolve to a DECLARED dependency.
 *
 * WHY THIS EXISTS. `scripts/measure-option-evidence.ts` imported `dotenv`, which
 * is not in package.json. It typechecked clean on a dev machine — pnpm hoists
 * transitive packages into node_modules, so TypeScript happily resolved it — and
 * then failed CI's clean `--frozen-lockfile` install with TS2307 (2026-08-11).
 * The local toolchain physically cannot catch that class of bug, because the
 * thing that hides it (a populated node_modules) is exactly what `pnpm
 * typecheck` reads. So it is checked here, against package.json itself, where
 * the answer does not depend on what happens to be installed.
 *
 * This is a STATIC check by design: no resolution, no filesystem lookup of
 * node_modules, just "is this package name declared?".
 *
 * Run: npx tsx scripts/verify-dependency-hygiene.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['app', 'lib', 'scripts', 'components'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'data', '.git']);

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};
const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
]);
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Root package name of a specifier: 'next/server' -> 'next', '@a/b/c' -> '@a/b'. */
function rootPackage(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Bare specifiers only — relative paths and the '@/' path alias are ours. */
function isBare(spec: string): boolean {
  return !spec.startsWith('.') && !spec.startsWith('@/') && !spec.startsWith('/');
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

const offenders: { file: string; spec: string; pkg: string }[] = [];
let scanned = 0;

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    scanned += 1;
    const src = readFileSync(file, 'utf8');
    const specs = new Set<string>();
    for (const re of [IMPORT_RE, SIDE_EFFECT_RE, REQUIRE_RE, DYNAMIC_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) != null) specs.add(m[1]);
    }
    for (const spec of specs) {
      if (!isBare(spec)) continue;
      if (builtins.has(spec) || builtins.has(rootPackage(spec))) continue;
      const root = rootPackage(spec);
      if (declared.has(root)) continue;
      offenders.push({ file: relative(ROOT, file), spec, pkg: root });
    }
  }
}

console.log(`dependency hygiene — scanned ${scanned} files across ${SCAN_DIRS.join(', ')}`);
if (offenders.length === 0) {
  console.log(`✅ every bare import resolves to a declared dependency (${declared.size} declared)`);
  process.exitCode = 0;
} else {
  console.log(`\n❌ ${offenders.length} import(s) of packages NOT in package.json:\n`);
  for (const o of offenders) {
    console.log(`  ${o.file}`);
    console.log(`    imports "${o.spec}" -> package "${o.pkg}" is not declared`);
  }
  console.log(
    `\nThese may resolve locally via pnpm hoisting and still fail CI's clean install.\n` +
      `Either declare the package, or use a Node builtin (e.g. process.loadEnvFile instead of dotenv).`,
  );
  process.exitCode = 1;
}
