import { NextResponse } from 'next/server';

import { getLatestTfDailyIndexValues } from '@/lib/tf-live/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The sector-level bar chart on /sector-scope — TradeFinder's OWN per-index
 * values (param_3 from their daily-index endpoint), not an approximation.
 *
 * This USED to reverse-engineer these numbers from Dhan's live index quotes
 * (today's range vs a 20-day baseline, curve-fit to a regression coefficient)
 * because the browser relay couldn't reliably capture daily-index yet. Once
 * that was fixed (v1.36.1, 2026-08-08 — the relay now visits TradeFinder's
 * own /sector-scope page, which is what actually fires this endpoint), the
 * approximation became pointless: real numbers were sitting in the DB
 * already. User confirmed (2026-08-08) the old approximation's numbers never
 * matched tradefinder.in's real chart, which is exactly what replacing it
 * with the real captured values fixes.
 *
 * No fallback to the retired approximation when there's no capture yet —
 * `values: {}` (empty) is the honest state, not a guessed number standing in
 * for a real one.
 */
export async function GET() {
  try {
    const { capturedAt, byIndex } = await getLatestTfDailyIndexValues();
    const values: Record<string, number> = {};
    for (const [name, value] of byIndex) values[name] = value;
    return NextResponse.json({
      success: true,
      source: 'tf-daily-index',
      capturedAt,
      values,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message, values: {} }, { status: 500 });
  }
}
