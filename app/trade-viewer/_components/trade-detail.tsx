'use client';

import { Download, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFTradeItem, TradeDetailData } from '../_lib/types';
import { OptionChart } from './option-chart';
import { PnlChart } from './pnl-chart';
import { SignalChart } from './signal-chart';
import { HumanVerifiedBadge } from './human-verified-badge';
import { TradeSearch } from './trade-search';

export function TradeDetailSection() {
  const [trades, setTrades] = useState<TFTradeItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [detail, setDetail] = useState<TradeDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloadingTrade, setDownloadingTrade] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState('');
  // Load trade list on mount
  useEffect(() => {
    fetch('/api/backtest/tf-validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'tf-trades-list' }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setTrades(d.trades);
      })
      .catch(() => {});
  }, []);

  const loadDetail = useCallback(
    async (idx: number) => {
      const t = trades[idx];
      if (!t) return;
      setSelectedIdx(idx);
      setDetail(null);
      // Skip API call if no data — show download prompt instead
      if (!t.hasData) return;
      setLoading(true);
      try {
        const res = await fetch('/api/backtest/tf-validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'trade-detail',
            symbol: t.symbol,
            date: t.date,
            optionType: t.optionType,
            strike: t.strike,
            spotPrice: t.spotPrice,
            tfPnl: t.pnl,
            tfExpiry: t.expiry,
            entryTime: t.entryTime,
            entryPrice: t.entryPrice,
            exitTime: t.exitTime,
            exitPrice: t.exitPrice,
            quantity: t.quantity,
          }),
        });
        const d = await res.json();
        if (d.success) setDetail(d.detail);
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    },
    [trades],
  );

  const downloadSingleTrade = useCallback(
    async (idx: number) => {
      const t = trades[idx];
      if (!t) return;
      setDownloadingTrade(true);
      setDownloadProgress(
        `Downloading ${t.symbol}: equity + futures + ${t.optionType} ${t.strike} option 5-min data...`,
      );
      // 45 calendar days back ≈ 30 trading sessions
      const from = new Date(t.date);
      from.setDate(from.getDate() - 45);
      try {
        const res = await fetch('/api/backtest/tf-validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'download-symbols',
            symbols: [t.symbol],
            fromDate: from.toISOString().slice(0, 10),
            toDate: t.date,
            options: t.strike > 0 ? [{ symbol: t.symbol, optionType: t.optionType, strike: t.strike }] : [],
          }),
        });
        const data = await res.json();
        if (data.success && data.total > 0 && (!data.errors || data.errors.length === 0)) {
          setDownloadProgress(`Done: ${data.total} rows for ${t.symbol}`);
          setTrades((prev) => prev.map((item, i) => (i === idx ? { ...item, hasData: true } : item)));
          await loadDetail(idx);
        } else {
          const errors = data.errors?.length ? data.errors.join('\n') : (data.error ?? 'Download failed');
          setDownloadProgress(`Error: ${errors}`);
        }
      } catch (e) {
        setDownloadProgress(`Error: ${(e as Error).message}`);
      } finally {
        setDownloadingTrade(false);
      }
    },
    [trades, loadDetail],
  );

  const selected = selectedIdx >= 0 ? trades[selectedIdx] : null;

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
        <Search className="w-4 h-4" /> Trade Detail View
      </h2>

      <TradeSearch trades={trades} selectedIdx={selectedIdx} onSelect={loadDetail} />

      {/* Download prompt — no data at all OR has equity but missing option strike */}
      {selected && (!selected.hasData || (detail && !detail.dataAvailable)) && !downloadingTrade && (
        <div className="flex items-center gap-3 px-4 py-4 rounded-xl bg-amber-100 dark:bg-amber-500/10 border-2 border-amber-400 dark:border-amber-500/30 border-dashed">
          <Download className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
          <div className="flex-1">
            <span className="text-sm font-medium text-amber-700 dark:text-amber-300">
              {!selected.hasData
                ? `No 5-min data for ${selected.symbol}`
                : `Missing option data: ${selected.symbol} ${selected.optionType} ${selected.strike}`}
            </span>
            <p className="text-[11px] text-amber-600/70 dark:text-amber-400/60 mt-0.5">
              Downloads equity + futures + option candles from Dhan
            </p>
            {downloadProgress && <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1 font-mono">{downloadProgress}</p>}
          </div>
          <button
            type="button"
            onClick={() => downloadSingleTrade(selectedIdx)}
            disabled={downloadingTrade}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-100 dark:bg-amber-500/20 hover:bg-amber-200 dark:hover:bg-amber-500/30 text-amber-700 dark:text-amber-300 border border-amber-400 dark:border-amber-500/40 text-sm font-semibold disabled:opacity-50 shrink-0"
          >
            <Download className="w-4 h-4" />
            {downloadingTrade ? 'Downloading...' : `Download ${selected.symbol}`}
          </button>
        </div>
      )}

      {/* Error/progress message — always visible */}
      {downloadProgress && !downloadingTrade && (
        <div
          className={`px-4 py-3 rounded-xl text-xs font-mono whitespace-pre-wrap ${
            downloadProgress.startsWith('Error')
              ? 'bg-red-100 dark:bg-red-500/10 border border-red-400 dark:border-red-500/30 text-red-600 dark:text-red-400'
              : 'bg-emerald-100 dark:bg-emerald-500/10 border border-emerald-400 dark:border-emerald-500/30 text-emerald-600 dark:text-emerald-400'
          }`}
        >
          {downloadProgress}
        </div>
      )}

      {loading && <div className="text-center py-8 text-muted-foreground text-sm">Loading trade detail...</div>}

      {detail?.dataAvailable && selected && (
        <div className="space-y-4">
          {/* Trade Info Cards */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            <InfoCard label="Stock" value={`${detail.symbol} ${detail.tf.optionType} ${detail.tf.strike}`} />
            <InfoCard label="Date" value={detail.date} />
            <InfoCard
              label="TF P&L"
              value={`\u20B9${detail.tf.pnl.toLocaleString()}`}
              color={detail.tf.pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}
            />
            <InfoCard
              label="Capital"
              value={
                selected.quantity && selected.entryPrice
                  ? `\u20B9${Math.round((selected.entryPrice * selected.quantity) / 1000)}K`
                  : `Lot: ${detail.lotSize.toLocaleString()}`
              }
            />
            <InfoCard
              label="Return"
              value={
                selected.entryPrice && selected.exitPrice
                  ? `${(((selected.exitPrice - selected.entryPrice) / selected.entryPrice) * 100).toFixed(0)}%`
                  : '\u2014'
              }
              color={
                selected.exitPrice && selected.entryPrice && selected.exitPrice > selected.entryPrice
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-red-600 dark:text-red-400'
              }
            />
            <InfoCard
              label={selected.entryTime ? 'Entry (verified)' : 'Entry (est.)'}
              value={
                selected.entryTime
                  ? `${selected.entryTime} \u20B9${selected.entryPrice}`
                  : detail.estimatedEntry
                    ? `${detail.estimatedEntry.time} \u20B9${detail.estimatedEntry.optionPrice.toFixed(1)}`
                    : '\u2014'
              }
              color={selected.entryTime ? 'text-emerald-600 dark:text-emerald-400' : undefined}
            />
            <InfoCard
              label={selected.exitTime ? 'Exit (verified)' : 'Exit (est.)'}
              value={
                selected.exitTime
                  ? `${selected.exitTime} \u20B9${selected.exitPrice}`
                  : detail.estimatedExit
                    ? `${detail.estimatedExit.time} \u20B9${detail.estimatedExit.optionPrice.toFixed(1)}`
                    : '\u2014'
              }
              color={selected.exitTime ? 'text-emerald-600 dark:text-emerald-400' : undefined}
            />
          </div>

          {/* Verified P&L Breakdown */}
          {selected.entryPrice && selected.exitPrice && (
            <div className="rounded-xl bg-emerald-50 dark:bg-emerald-500/5 border border-emerald-300 dark:border-emerald-500/20 px-5 py-3">
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground">
                  <HumanVerifiedBadge show={selected.humanReview} />
                  Buy @ {'\u20B9'}
                  {selected.entryPrice} ({selected.entryTime ?? detail.estimatedEntry?.time}) &rarr; Sell @ {'\u20B9'}
                  {selected.exitPrice} ({selected.exitTime ?? detail.estimatedExit?.time})
                </div>
                <div className="flex items-center gap-4 text-sm font-mono">
                  <span className="text-muted-foreground">
                    ({'\u20B9'}
                    {selected.exitPrice} - {'\u20B9'}
                    {selected.entryPrice}) &times; {detail.lotSize.toLocaleString()} =
                  </span>
                  <span className={`font-bold text-lg ${detail.tf.pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                    {'\u20B9'}
                    {detail.tf.pnl.toLocaleString()}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    ({(((selected.exitPrice - selected.entryPrice) / selected.entryPrice) * 100).toFixed(1)}% return)
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Charts: Option + Equity side by side — crosshair synced */}
          <div className="grid grid-cols-2 gap-4">
            <OptionChart
              bars={detail.optionBars}
              title={`${detail.symbol} ${detail.tf.optionType} ${detail.tf.strike}`}
              entryBar={
                detail.estimatedEntry
                  ? {
                      timestamp: detail.estimatedEntry.timestamp,
                      price: selected.entryPrice ?? detail.estimatedEntry.optionPrice,
                      label: `BUY \u20B9${selected.entryPrice ?? detail.estimatedEntry.optionPrice}`,
                    }
                  : undefined
              }
              exitBar={
                detail.estimatedExit
                  ? {
                      timestamp: detail.estimatedExit.timestamp,
                      price: selected.exitPrice ?? detail.estimatedExit.optionPrice,
                      label: `SELL \u20B9${selected.exitPrice ?? detail.estimatedExit.optionPrice}`,
                    }
                  : undefined
              }
              height={350}
            />
            <OptionChart
              bars={detail.equityBars}
              title={`${detail.symbol} Equity`}
              entryBar={
                detail.estimatedEntry
                  ? {
                      timestamp: detail.estimatedEntry.timestamp,
                      price: detail.signals[detail.estimatedEntry.barIndex]?.equityClose ?? 0,
                      label: `Entry \u20B9${detail.signals[detail.estimatedEntry.barIndex]?.equityClose?.toFixed(1) ?? ''}`,
                    }
                  : undefined
              }
              exitBar={
                detail.estimatedExit
                  ? {
                      timestamp: detail.estimatedExit.timestamp,
                      price: detail.signals[detail.estimatedExit.barIndex]?.equityClose ?? 0,
                      label: `Exit \u20B9${detail.signals[detail.estimatedExit.barIndex]?.equityClose?.toFixed(1) ?? ''}`,
                    }
                  : undefined
              }
              height={350}
            />
          </div>

          {/* R-Factor + ADX / P&L side by side */}
          <div className="grid grid-cols-2 gap-4">
            <SignalChart signals={detail.signals} height={200} />
            {detail.pnlCurve.length > 0 ? (
              <PnlChart curve={detail.pnlCurve} tfPnl={detail.tf.pnl} height={200} />
            ) : (
              <div />
            )}
          </div>

          {/* Signal Table — auto-scrolls to entry row */}
          <SignalTable key={`${detail.symbol}-${detail.date}`} detail={detail} />
        </div>
      )}
    </div>
  );
}

function SignalTable({ detail }: { detail: TradeDetailData }) {
  const entryRowRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to entry row when detail loads
  useEffect(() => {
    if (entryRowRef.current) {
      setTimeout(() => {
        entryRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 100);
    }
  }, []);

  return (
    <div className="rounded-xl bg-card border border-border overflow-hidden">
      <h3 className="px-4 py-2.5 bg-muted/50 text-xs font-bold text-muted-foreground uppercase tracking-wider">
        Bar-by-Bar Signals ({detail.signals.length} bars)
      </h3>
      <div className="max-h-64 overflow-y-auto">
        <div className="grid grid-cols-[55px_65px_55px_55px_40px_40px_40px_55px_55px] gap-1 px-4 py-1.5 bg-muted/30 text-[9px] text-muted-foreground uppercase sticky top-0">
          <span>Time</span>
          <span>Equity</span>
          <span>Spread</span>
          <span>R-Factor</span>
          <span>ADX</span>
          <span>+DI</span>
          <span>-DI</span>
          <span>Dir</span>
          <span>Option</span>
        </div>
        {detail.signals.map((s) => {
          const isEntry = detail.estimatedEntry?.time === s.time;
          const isExit = detail.estimatedExit?.time === s.time;
          return (
            <div
              key={s.timestamp}
              ref={isEntry ? entryRowRef : undefined}
              className={`grid grid-cols-[55px_65px_55px_55px_40px_40px_40px_55px_55px] gap-1 px-4 py-1 text-xs font-mono border-b border-border/30 ${
                s.isHot
                  ? 'bg-amber-100 dark:bg-amber-500/10 border-l-2 border-l-amber-400'
                  : isEntry
                    ? 'bg-emerald-100 dark:bg-emerald-500/10'
                    : isExit
                      ? 'bg-red-100 dark:bg-red-500/10'
                      : ''
              }`}
            >
              <span className="text-muted-foreground">
                {s.time}
                {isEntry ? ' \u25B6' : isExit ? ' \u25A0' : ''}
              </span>
              <span className="text-foreground">
                {'\u20B9'}
                {s.equityClose.toFixed(1)}
              </span>
              <span className={s.spreadRatio > 1.5 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>
                {s.spreadRatio.toFixed(2)}
              </span>
              <span className={s.rFactor >= 2.0 ? 'text-sky-600 dark:text-sky-400 font-bold' : 'text-muted-foreground'}>
                {s.rFactor.toFixed(2)}
              </span>
              <span className={s.adx >= 28 ? 'text-amber-600 dark:text-amber-400 font-bold' : 'text-muted-foreground'}>{s.adx || '\u2014'}</span>
              <span className="text-muted-foreground">{s.plusDI || '\u2014'}</span>
              <span className="text-muted-foreground">{s.minusDI || '\u2014'}</span>
              <span className={s.direction === 'CE' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>{s.direction}</span>
              <span className="text-foreground">
                {'\u20B9'}
                {s.optionClose > 0 ? s.optionClose.toFixed(1) : '\u2014'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InfoCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="px-3 py-2 rounded-lg bg-muted/50 border border-border/50">
      <div className="text-[9px] text-muted-foreground uppercase">{label}</div>
      <div className={`text-sm font-mono font-bold mt-0.5 ${color ?? 'text-foreground'}`}>{value}</div>
    </div>
  );
}
