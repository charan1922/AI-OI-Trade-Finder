/**
 * Every Fyers DATA call must go through lib/fyers/client.ts (counted, latched,
 * budgeted — Fyers Standard plan, 5,000/day since 2026-11-16). Fails CI when
 * any other source file calls the SDK's data methods or the data REST host
 * directly. Order-placement SDK calls and the websocket (fyersDataSocket) are
 * not Data REST and are allowed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOTS = ['lib', 'app'];
const ALLOWED = new Set([path.normalize('lib/fyers/client.ts')]);
const PATTERN = /\.(getQuotes|getHistory|getMarketDepth|getOptionChain)\s*\(|api-t1\.fyers\.in\/data/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
}

const files: string[] = [];
for (const root of ROOTS) walk(root, files);
const offenders = files.filter((f) => !ALLOWED.has(path.normalize(f)) && PATTERN.test(readFileSync(f, 'utf8')));
if (offenders.length > 0) {
  console.error(`✗ Fyers data calls outside lib/fyers/client.ts:\n  ${offenders.join('\n  ')}`);
  process.exit(1);
}
console.log(`✓ no Fyers data-call bypass (${files.length} files scanned)`);
