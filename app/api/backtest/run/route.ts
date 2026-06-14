import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { NextResponse } from 'next/server';
import { prepareBacktest } from '@/lib/backtest/bt-prepare';
import { btExecute, btQuery } from '@/lib/backtest/bt-store';
import type { BtStatus, BtSummary, BtTradeRow, GateBasis } from '@/app/backtest/_lib/bt-types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const execFileAsync = promisify(execFile);

/** Raw per-trade result emitted by backtest/run_backtest.py. */
interface PyResult {
  trade_id: number;
  taken: number;
  status: BtStatus;
  entry_time?: string;
  entry_price?: number;
  exit_time?: string;
  exit_price?: number;
  exit_reason?: string;
  gross_pnl?: number;
  charges?: number;
  net_pnl?: number;
  return_pct?: number;
  error?: string;
}

interface TradeMeta {
  id: number;
  symbol: string;
  date: string;
  option_type: string;
  strike: number;
  tf_pnl: number;
  lot_size: number | null;
  taken: number;
  fut_oi_level20: number | null;
  opt_oi_level20: number | null;
  score: number | null;
  fut_quadrant: string | null;
  fut_bias: string | null;
  opt_flow: string | null;
  direction_agrees: number | null;
}

function venvPython(): string {
  const base = path.join(process.cwd(), 'backtest', '.venv');
  return process.platform === 'win32'
    ? path.join(base, 'Scripts', 'python.exe')
    : path.join(base, 'bin', 'python');
}

/**
 * POST /api/backtest/run
 * Body: { gateThreshold?: number, profitTarget?: number, download?: boolean }
 *
 * 1. Prepares the isolated per-trade copy (bt_*) with combined-OI signals.
 * 2. Runs the vectorbt engine (Python subprocess) over the taken trades.
 * 3. Persists bt_result, builds the per-trade rows + summary, returns them.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const gateBasis = (body.gateBasis ?? 'optOi') as GateBasis;
    const gateThreshold = Number(body.gateThreshold ?? (gateBasis === 'score' ? 4 : 1.1));
    const profitTarget = Number(body.profitTarget ?? 5000);
    const download = Boolean(body.download ?? false);

    // 1. Prepare per-trade copy + signals.
    const prep = await prepareBacktest({
      createdAt: new Date().toISOString(),
      gateBasis,
      gateThreshold,
      profitTarget,
      download,
    });

    // 2. Run the vectorbt engine.
    const dbPath = path.join(process.cwd(), 'data', 'project-r.db');
    const script = path.join(process.cwd(), 'backtest', 'run_backtest.py');
    let py: PyResult[];
    try {
      const { stdout } = await execFileAsync(
        venvPython(),
        [script, '--db', dbPath, '--run-id', String(prep.runId), '--profit-target', String(profitTarget)],
        { maxBuffer: 32 * 1024 * 1024, timeout: 180_000, cwd: process.cwd() },
      );
      py = JSON.parse(stdout) as PyResult[];
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      return NextResponse.json(
        { success: false, error: `vectorbt engine failed: ${err.stderr || err.message}`, prep },
        { status: 500 },
      );
    }

    // 3. Persist results + join with the frozen trade/signal meta.
    const meta = await btQuery<TradeMeta>(
      `SELECT t.id, t.symbol, t.date, t.option_type, t.strike, t.tf_pnl, t.lot_size, t.taken,
              s.fut_oi_level20, s.opt_oi_level20, s.score,
              s.fut_quadrant, s.fut_bias, s.opt_flow, s.direction_agrees
       FROM bt_trade t LEFT JOIN bt_signal s ON s.trade_id = t.id
       WHERE t.run_id = ?`,
      [prep.runId],
    );
    const metaById = new Map(meta.map((m) => [Number(m.id), m]));

    const rows: BtTradeRow[] = [];
    for (const p of py) {
      const m = metaById.get(Number(p.trade_id));
      if (!m) continue;
      const net = p.net_pnl ?? null;
      await btExecute(
        `INSERT OR REPLACE INTO bt_result
           (trade_id, taken, status, entry_time, entry_price, exit_time, exit_price, exit_reason, gross_pnl, charges, net_pnl)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.trade_id,
          p.taken ?? 0,
          p.status,
          p.entry_time ?? null,
          p.entry_price ?? null,
          p.exit_time ?? null,
          p.exit_price ?? null,
          p.exit_reason ?? null,
          p.gross_pnl ?? null,
          p.charges ?? null,
          net,
        ],
      );
      rows.push({
        tradeId: Number(m.id),
        date: m.date,
        symbol: m.symbol,
        optionType: m.option_type,
        strike: Number(m.strike),
        tfPnl: Number(m.tf_pnl),
        lotSize: m.lot_size != null ? Number(m.lot_size) : null,
        futOiLevel20: m.fut_oi_level20 != null ? Number(m.fut_oi_level20) : null,
        optOiLevel20: m.opt_oi_level20 != null ? Number(m.opt_oi_level20) : null,
        signalScore: m.score != null ? Number(m.score) : 0,
        futQuadrant: (m.fut_quadrant as BtTradeRow['futQuadrant']) ?? null,
        futBias: (m.fut_bias as BtTradeRow['futBias']) ?? null,
        optFlow: (m.opt_flow as BtTradeRow['optFlow']) ?? null,
        directionAgrees: m.direction_agrees != null ? Boolean(m.direction_agrees) : null,
        taken: Boolean(m.taken),
        status: p.status,
        entryTime: p.entry_time ?? null,
        entryPrice: p.entry_price ?? null,
        exitTime: p.exit_time ?? null,
        exitPrice: p.exit_price ?? null,
        exitReason: p.exit_reason ?? null,
        grossPnl: p.gross_pnl ?? null,
        charges: p.charges ?? null,
        netPnl: net,
        returnPct: p.return_pct ?? null,
      });
    }

    // Chronological order (oldest first) for the equity curve + table.
    rows.sort((a, b) => a.date.localeCompare(b.date));

    const summary = buildSummary(rows, gateBasis, gateThreshold, profitTarget);

    return NextResponse.json({ success: true, runId: prep.runId, results: rows, summary, prep });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}

function buildSummary(rows: BtTradeRow[], gateBasis: GateBasis, gateThreshold: number, profitTarget: number): BtSummary {
  const evaluated = rows.filter((r) => r.status === 'ok' && r.netPnl != null);
  const wins = evaluated.filter((r) => (r.netPnl ?? 0) > 0);
  const losses = evaluated.filter((r) => (r.netPnl ?? 0) < 0);

  const netPnl = evaluated.reduce((s, r) => s + (r.netPnl ?? 0), 0);
  const grossPnl = evaluated.reduce((s, r) => s + (r.grossPnl ?? 0), 0);
  const charges = evaluated.reduce((s, r) => s + (r.charges ?? 0), 0);
  const grossWin = wins.reduce((s, r) => s + (r.netPnl ?? 0), 0);
  const grossLoss = losses.reduce((s, r) => s + (r.netPnl ?? 0), 0); // ≤ 0

  // Max drawdown over the cumulative net curve (rows are chronological).
  let cum = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const r of evaluated) {
    cum += r.netPnl ?? 0;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDrawdown) maxDrawdown = peak - cum;
  }

  let sharpe: number | null = null;
  if (evaluated.length > 1) {
    const mean = netPnl / evaluated.length;
    const variance = evaluated.reduce((s, r) => s + ((r.netPnl ?? 0) - mean) ** 2, 0) / evaluated.length;
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? Math.round((mean / std) * 100) / 100 : null;
  }

  return {
    totalTrades: rows.length,
    taken: rows.filter((r) => r.taken).length,
    evaluated: evaluated.length,
    wins: wins.length,
    losses: losses.length,
    winRate: evaluated.length > 0 ? Math.round((wins.length / evaluated.length) * 1000) / 1000 : 0,
    netPnl: Math.round(netPnl),
    grossPnl: Math.round(grossPnl),
    charges: Math.round(charges),
    profitFactor: grossLoss < 0 ? Math.round((grossWin / -grossLoss) * 100) / 100 : null,
    expectancy: evaluated.length > 0 ? Math.round(netPnl / evaluated.length) : 0,
    maxDrawdown: Math.round(maxDrawdown),
    sharpe,
    tfTotalPnl: evaluated.reduce((s, r) => s + r.tfPnl, 0),
    gateBasis,
    gateThreshold,
    profitTarget,
  };
}
