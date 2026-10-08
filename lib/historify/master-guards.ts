/**
 * Pure guards for replacing the master_contracts snapshot — no DB, so CI can
 * test them (scripts/fyers-master-checks.ts).
 */

export type MasterProvider = 'fyers' | 'dhan';

/** Which provider a stored snapshot came from, by its manifest `sourceHash`:
 *  `fyers:` / `dhan:` prefixes, or a bare SHA-256 — what the pre-migration Dhan
 *  import wrote. Anything else (none stored, test fixtures) is null = unknown,
 *  which checkStableDrop treats strictly, never as a provider switch. */
export function providerOfSourceHash(sourceHash: string | null | undefined): MasterProvider | null {
  const value = sourceHash?.trim() ?? '';
  if (value.startsWith('fyers:')) return 'fyers';
  if (value.startsWith('dhan:') || /^[0-9a-f]{64}$/.test(value)) return 'dhan';
  return null;
}

/** Largest allowed drop versus the stored snapshot before a sync is refused. */
const MAX_STABLE_DROP = 0.1;

/**
 * The truncation guard: refuse a sync whose stable rows fell more than 10%
 * versus the stored snapshot. Compares LIKE WITH LIKE — across a provider switch
 * only futures (FUTSTK + FUTIDX) are compared, because providers define
 * "equities" differently: Dhan listed every series (9,964 rows), Fyers' master
 * the EQ series only (2,333). Comparing those aborted every first Fyers sync
 * (2026-10-08) for a reason that is not truncation. Futures mean the same thing
 * in both (653 vs 635), so a truncated download still fails here.
 */
export function checkStableDrop(input: {
  existingProvider: MasterProvider | null;
  provider: MasterProvider;
  existingStable: number;
  parsedStable: number;
  existingFutures: number;
  parsedFutures: number;
}): { ok: boolean; reason: string | null } {
  const sameProvider = input.existingProvider == null || input.existingProvider === input.provider;
  const [label, existing, parsed] = sameProvider
    ? ['stable instruments', input.existingStable, input.parsedStable]
    : [`futures (provider switch ${input.existingProvider}→${input.provider})`, input.existingFutures, input.parsedFutures];
  if (existing > 0 && parsed < existing * (1 - MAX_STABLE_DROP)) {
    return { ok: false, reason: `${label} dropped ${existing}→${parsed} (>10%)` };
  }
  return { ok: true, reason: null };
}
