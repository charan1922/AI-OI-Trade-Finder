/**
 * Money-touching stock-option contract resolution.
 *
 * The pure calendar policy decides which listed expiry is eligible. This
 * boundary additionally proves the Dhan master is the exact daily snapshot
 * expected for the trade date, then keeps security id, symbol, lot size,
 * strike, side and expiry from one selected database row.
 */

import { getMasterContractFreshness, type MasterContractQueryClient } from '@/lib/historify/master-contracts';
import {
  checkOptionExpiryForEntry,
  normalizeIsoDate,
  optionCalendarDte,
  selectOptionExpiryForEntry,
} from '@/lib/options/expiry-policy';
import type { OptionExpiryResolution, OptionPlan, OptionSide } from '@/lib/trade-suggest/types';

export interface StockOptionResolution {
  plan: OptionPlan | null;
  resolution: OptionExpiryResolution;
}

export interface ResolveStockOptionInput {
  symbol: string;
  side: OptionSide;
  spot: number;
  tradeDate: string;
}

function dbDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  return normalizeIsoDate(String(value ?? ''));
}

function failed(
  status: Exclude<OptionExpiryResolution['status'], 'selected'>,
  detail: string,
  masterSyncDate: string | null,
  nearestListedExpiry: string | null = null
): StockOptionResolution {
  return {
    plan: null,
    resolution: {
      status,
      selectedExpiry: null,
      nearestListedExpiry,
      rolled: false,
      rollReason: null,
      calendarDte: null,
      masterSyncDate,
      detail,
    },
  };
}

export async function resolveStockOptionFromMaster(
  db: MasterContractQueryClient,
  input: ResolveStockOptionInput
): Promise<StockOptionResolution> {
  const tradeDate = normalizeIsoDate(input.tradeDate);
  if (
    tradeDate == null ||
    tradeDate !== input.tradeDate ||
    input.symbol.trim() === '' ||
    !Number.isFinite(input.spot) ||
    input.spot <= 0 ||
    (input.side !== 'CE' && input.side !== 'PE')
  ) {
    return failed('invalid-request', 'invalid symbol, side, spot or exact YYYY-MM-DD trade date', null);
  }

  let masterSyncDate: string | null = null;
  try {
    const freshness = await getMasterContractFreshness(tradeDate, db);
    masterSyncDate = freshness.syncDate;
    if (!freshness.acceptable) {
      return failed('master-stale', freshness.reason ?? 'master contracts freshness check failed', masterSyncDate);
    }

    const expiryRows = await db.$queryRawUnsafe<{ expiryDate: unknown }[]>(
      `SELECT DISTINCT expiryDate
         FROM master_contracts
        WHERE underlying = ?
          AND instrument = 'OPTSTK'
          AND segment = 'NSE_FNO'
          AND optionType = ?
          AND syncDate = ?
          AND substr(expiryDate, 1, 10) >= ?
        ORDER BY expiryDate ASC`,
      input.symbol,
      input.side,
      tradeDate,
      tradeDate
    );
    if (expiryRows.length === 0) {
      return failed(
        'no-listed-expiry',
        `no active ${input.side} expiry listed for ${input.symbol} in the ${tradeDate} master snapshot`,
        masterSyncDate
      );
    }

    const normalized = expiryRows.map((row) => dbDate(row.expiryDate));
    if (normalized.some((expiry) => expiry == null)) {
      return failed(
        'invalid-master-data',
        `master contains a malformed ${input.symbol} ${input.side} expiry`,
        masterSyncDate
      );
    }
    const availableExpiries = [...new Set(normalized as string[])].sort();
    const nearestListedExpiry = availableExpiries[0] ?? null;
    const selectedExpiry = selectOptionExpiryForEntry(tradeDate, availableExpiries);
    if (selectedExpiry == null) {
      const nearestDecision = nearestListedExpiry ? checkOptionExpiryForEntry(tradeDate, nearestListedExpiry) : null;
      return failed(
        'no-eligible-expiry',
        nearestDecision?.reason ?? `no eligible ${input.symbol} ${input.side} expiry is listed`,
        masterSyncDate,
        nearestListedExpiry
      );
    }

    const rows = await db.$queryRawUnsafe<
      {
        securityId: unknown;
        tradingSymbol: unknown;
        lotSize: unknown;
        strikePrice: unknown;
        expiryDate: unknown;
      }[]
    >(
      `SELECT securityId,
              symbol AS tradingSymbol,
              lotSize,
              CAST(strikePrice AS REAL) AS strikePrice,
              expiryDate
         FROM master_contracts
        WHERE underlying = ?
          AND instrument = 'OPTSTK'
          AND segment = 'NSE_FNO'
          AND optionType = ?
          AND syncDate = ?
          AND substr(expiryDate, 1, 10) = ?
        ORDER BY ABS(CAST(strikePrice AS REAL) - ?) ASC,
                 CAST(strikePrice AS REAL) ASC,
                 securityId ASC
        LIMIT 1`,
      input.symbol,
      input.side,
      tradeDate,
      selectedExpiry,
      input.spot
    );
    const row = rows[0];
    if (row == null) {
      return failed(
        'no-strike',
        `no ${input.side} strike exists for ${input.symbol} ${selectedExpiry}`,
        masterSyncDate,
        nearestListedExpiry
      );
    }

    const rowExpiry = dbDate(row.expiryDate);
    const strike = Number(row.strikePrice);
    const lotSize = Number(row.lotSize);
    const securityId = String(row.securityId ?? '').trim();
    const tradingSymbol = String(row.tradingSymbol ?? '').trim();
    if (
      rowExpiry !== selectedExpiry ||
      !Number.isFinite(strike) ||
      strike <= 0 ||
      !Number.isInteger(lotSize) ||
      lotSize <= 0 ||
      securityId === '' ||
      tradingSymbol === ''
    ) {
      return failed(
        'invalid-master-data',
        `selected ${input.symbol} ${input.side} row has invalid contract identity fields`,
        masterSyncDate,
        nearestListedExpiry
      );
    }

    const rolled = nearestListedExpiry != null && selectedExpiry !== nearestListedExpiry;
    const nearestDecision = nearestListedExpiry ? checkOptionExpiryForEntry(tradeDate, nearestListedExpiry) : null;
    const rollReason = rolled && nearestDecision?.allow === false ? 'EXPIRY_WEEK' : null;
    const calendarDte = optionCalendarDte(tradeDate, selectedExpiry);
    return {
      plan: {
        optionType: input.side,
        strike,
        expiryDate: selectedExpiry,
        lotSize,
        optSecurityId: securityId,
        optSymbol: tradingSymbol,
        premium: null,
      },
      resolution: {
        status: 'selected',
        selectedExpiry,
        nearestListedExpiry,
        rolled,
        rollReason,
        calendarDte,
        masterSyncDate,
        detail: rolled
          ? `rolled from ${nearestListedExpiry} to ${selectedExpiry} because the nearest contract is in expiry week`
          : `selected nearest eligible expiry ${selectedExpiry}`,
      },
    };
  } catch (error) {
    return failed(
      'query-error',
      `contract-master query failed: ${error instanceof Error ? error.message : String(error)}`,
      masterSyncDate
    );
  }
}
