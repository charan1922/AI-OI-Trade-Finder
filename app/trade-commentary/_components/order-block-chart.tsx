'use client';

/**
 * 5-min candles + OUR order-block zones for one pick, as they stood at the
 * moment of a commentary read (`asOf`): only completed bars and only zones
 * whose confirming close had already happened. Display only — nothing here
 * feeds a trade. Engine: lib/order-blocks/engine.ts; data: /api/order-blocks.
 */

import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  type ISeriesApi,
  type ISeriesPrimitive,
  LineStyle,
  type SeriesAttachedParameter,
  type SeriesMarker,
  type SeriesType,
  type Time,
} from 'lightweight-charts';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface ApiBar {
  startMs: number;
  endMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
interface ApiBlock {
  id: string;
  side: 'bullish' | 'bearish';
  zoneLow: number;
  zoneHigh: number;
  originStartMs: number;
  originEndMs: number;
  confirmedAtMs: number;
  brokenPivotPrice: number;
  brokenPivotKnownAtMs: number;
  bodyRatio: number;
  bodyAtrRatio: number;
  preconfirmationOverlapBars: number;
  state: 'confirmed_active' | 'retested' | 'invalidated' | 'expired';
  firstRetestAtMs: number | null;
  invalidatedAtMs: number | null;
  expiredAtMs: number | null;
  algorithmVersion: string;
}
interface ApiData {
  label: 'DELAYED' | 'HISTORICAL';
  algorithmVersion: string;
  config: { minBodyRatio: number; minBodyAtr: number; left: number; right: number; originLookback: number };
  warmupBars: number;
  skippedBars: number;
  atrReady: boolean;
  bars: ApiBar[];
  blocks: ApiBlock[];
}

export interface OrderBlockChartProps {
  symbol: string;
  date: string;
  /** Commentary read time ("YYYY-MM-DD HH:MM:SS" IST or ISO); zones confirmed later are never shown. */
  asOf: string;
  entry?: number | null;
  stop?: number | null;
  target?: number | null;
}

const IST_SEC = 19_800;
const toChartTime = (ms: number) => (Math.floor(ms / 1000) + IST_SEC) as Time;
const fmtIst = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
const rupee = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const STATE_LABEL: Record<ApiBlock['state'], string> = {
  confirmed_active: 'active — not yet revisited',
  retested: 'retested (price came back into it)',
  invalidated: 'invalidated (a 5-min close went through its far edge)',
  expired: 'expired at session end',
};

/** Draws each zone as a rectangle from its origin candle to where it ended (or the last bar). */
class ZonesPrimitive implements ISeriesPrimitive<Time> {
  private chart: SeriesAttachedParameter<Time>['chart'] | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  constructor(
    private readonly blocks: ApiBlock[],
    private readonly bars: ApiBar[]
  ) {}
  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart;
    this.series = p.series;
  }
  detached(): void {
    this.chart = null;
    this.series = null;
  }
  paneViews() {
    return [
      {
        zOrder: () => 'bottom' as const,
        renderer: () => ({
          draw: (target: { useMediaCoordinateSpace: (f: (s: { context: CanvasRenderingContext2D }) => void) => void }) => {
            const chart = this.chart;
            const series = this.series;
            if (!chart || !series || this.bars.length === 0) return;
            const ts = chart.timeScale();
            const lastBar = this.bars[this.bars.length - 1];
            const x0 = ts.timeToCoordinate(toChartTime(this.bars[0].startMs));
            const x1 = this.bars.length > 1 ? ts.timeToCoordinate(toChartTime(this.bars[1].startMs)) : null;
            const half = x0 !== null && x1 !== null ? Math.abs(x1 - x0) / 2 : 3;
            target.useMediaCoordinateSpace(({ context }) => {
              for (const ob of this.blocks) {
                const endMs = ob.invalidatedAtMs ?? ob.expiredAtMs ?? lastBar.endMs;
                const endBar = [...this.bars].reverse().find((b) => b.endMs <= endMs) ?? lastBar;
                const left = ts.timeToCoordinate(toChartTime(ob.originStartMs));
                const right = ts.timeToCoordinate(toChartTime(endBar.startMs));
                const top = series.priceToCoordinate(ob.zoneHigh);
                const bottom = series.priceToCoordinate(ob.zoneLow);
                if (left === null || right === null || top === null || bottom === null) continue;
                const dead = ob.state === 'invalidated' || ob.state === 'expired';
                const rgb = ob.side === 'bullish' ? '16,185,129' : '239,68,68';
                context.fillStyle = `rgba(${rgb},${dead ? 0.07 : 0.2})`;
                context.strokeStyle = `rgba(${rgb},${dead ? 0.35 : 0.85})`;
                context.lineWidth = 1;
                context.setLineDash(dead ? [4, 3] : []);
                const x = left - half;
                const w = right + half - x;
                const y = Math.min(top, bottom);
                const h = Math.max(1, Math.abs(bottom - top));
                context.fillRect(x, y, w, h);
                context.strokeRect(x, y, w, h);
                context.setLineDash([]);
              }
            });
          },
        }),
      },
    ];
  }
}

export function OrderBlockChart({ symbol, date, asOf, entry, stop, target }: OrderBlockChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<ApiData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ApiBlock | null>(null);

  useEffect(() => {
    // A card's symbol/date/asOf never change, so there is no stale state to reset.
    let cancelled = false;
    const q = new URLSearchParams({ symbol, date, asOf });
    fetch(`/api/order-blocks?${q}`, { cache: 'no-store' })
      .then(async (res) => {
        const j = (await res.json().catch(() => null)) as { success?: boolean; data?: ApiData; error?: string } | null;
        if (cancelled) return;
        if (!res.ok || !j?.success || !j.data) setError(j?.error ?? `HTTP ${res.status}`);
        else setData(j.data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, date, asOf]);

  useEffect(() => {
    if (!containerRef.current || !data || data.bars.length === 0) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#9ca3af', fontSize: 11 },
      grid: { vertLines: { color: 'rgba(127,127,127,0.08)' }, horzLines: { color: 'rgba(127,127,127,0.08)' } },
      rightPriceScale: { borderColor: 'rgba(127,127,127,0.2)' },
      timeScale: {
        borderColor: 'rgba(127,127,127,0.2)',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: number) => {
          const d = new Date(time * 1000);
          return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
        },
      },
      localization: {
        priceFormatter: (p: number) => p.toFixed(2),
        timeFormatter: (time: number) => {
          const d = new Date(time * 1000);
          return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} IST`;
        },
      },
      height: 300,
      autoSize: true,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    });
    series.setData(
      data.bars.map((b) => ({ time: toChartTime(b.startMs), open: b.open, high: b.high, low: b.low, close: b.close }))
    );
    series.attachPrimitive(new ZonesPrimitive(data.blocks, data.bars));

    // The confirming (BOS) candle — the moment each zone became knowable.
    const markers: SeriesMarker<Time>[] = data.blocks
      .map((ob) => {
        const bos = data.bars.find((b) => b.endMs === ob.confirmedAtMs);
        if (!bos) return null;
        const bull = ob.side === 'bullish';
        return {
          time: toChartTime(bos.startMs),
          position: bull ? 'belowBar' : 'aboveBar',
          shape: bull ? 'arrowUp' : 'arrowDown',
          color: bull ? '#10b981' : '#ef4444',
          text: 'OB',
        } as SeriesMarker<Time>;
      })
      .filter((m): m is SeriesMarker<Time> => m !== null)
      .sort((a, b) => Number(a.time) - Number(b.time));
    if (markers.length > 0) createSeriesMarkers(series, markers);

    const line = (price: number | null | undefined, title: string, color: string, style: LineStyle) => {
      if (price == null || !Number.isFinite(price)) return;
      series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
    };
    line(entry, 'Entry', '#3b82f6', LineStyle.Solid);
    line(stop, 'SL', '#ef4444', LineStyle.Dashed);
    line(target, 'Target', '#10b981', LineStyle.Dashed);

    chart.subscribeClick((param) => {
      if (!param.point || param.time === undefined) {
        setSelected(null);
        return;
      }
      const price = series.coordinateToPrice(param.point.y);
      const tMs = (Number(param.time) - IST_SEC) * 1000;
      if (price === null) return;
      const hit = data.blocks
        .filter((ob) => {
          const end = ob.invalidatedAtMs ?? ob.expiredAtMs ?? Number.POSITIVE_INFINITY;
          return tMs >= ob.originStartMs && tMs < end && price >= ob.zoneLow && price <= ob.zoneHigh;
        })
        .sort((a, b) => b.confirmedAtMs - a.confirmedAtMs)[0];
      setSelected(hit ?? null);
    });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data, entry, stop, target]);

  if (error) return <div className="mt-2 text-[11px] text-muted-foreground">Order blocks unavailable: {error}</div>;
  if (!data) {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading 5-min candles…
      </div>
    );
  }
  if (data.bars.length === 0) {
    return <div className="mt-2 text-[11px] text-muted-foreground">No recorded 5-min candles for {symbol} on {date} up to this read.</div>;
  }

  return (
    <div className="mt-2 rounded-lg border border-border/50 bg-background/40 p-2">
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        <span
          className={`rounded px-1.5 py-px font-bold ${data.label === 'DELAYED' ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300' : 'bg-muted text-foreground'}`}
          title="Recorded 5-min candles — up to one bar plus one poller cycle behind the market"
        >
          {data.label}
        </span>
        <span className="font-semibold text-foreground">{symbol} · 5-min · as of {fmtIst(Date.parse(asOf.includes('T') ? asOf : `${asOf.replace(' ', 'T')}+05:30`))} IST</span>
        <span>
          {data.blocks.length} order block{data.blocks.length === 1 ? '' : 's'} · {data.algorithmVersion}
        </span>
        {!data.atrReady && <span className="text-amber-600 dark:text-amber-400">not enough history for ATR yet — no blocks possible</span>}
      </div>
      <div ref={containerRef} className="h-[300px] w-full" />
      <div className="mt-1 text-[9.5px] leading-snug text-muted-foreground">
        Green/red boxes are <b>order-block zones from our documented rule set</b> — the last opposite candle before a strong
        5-min close through a confirmed swing level. They are inferred price areas, <b>not institutional orders</b> and not a
        trade signal; each appears only after its ▲/▼ OB candle closed. Faded dashed = invalidated or expired. Blue/red/green
        lines are this pick&apos;s Entry / SL / Target. Click a box for its rule checks.
      </div>
      {selected && (
        <div className="mt-1.5 rounded border border-border/60 bg-muted/30 p-2 text-[10.5px] leading-relaxed">
          <div className="font-semibold text-foreground">
            {selected.side === 'bullish' ? 'Bullish' : 'Bearish'} order block {rupee(selected.zoneLow)} – {rupee(selected.zoneHigh)}
          </div>
          <div>
            Source candle {fmtIst(selected.originStartMs)}–{fmtIst(selected.originEndMs)} IST (the last{' '}
            {selected.side === 'bullish' ? 'red' : 'green'} candle before the move); zone = its full high–low.
          </div>
          <div>
            Confirmed at the {fmtIst(selected.confirmedAtMs)} IST close: it closed{' '}
            {selected.side === 'bullish' ? 'above the swing high' : 'below the swing low'} {rupee(selected.brokenPivotPrice)} (known
            since {fmtIst(selected.brokenPivotKnownAtMs)}).
          </div>
          <div>
            Strength checks: body {Math.round(selected.bodyRatio * 100)}% of the candle (needs ≥ {Math.round(data.config.minBodyRatio * 100)}%) ·
            body {selected.bodyAtrRatio.toFixed(2)}× ATR (needs ≥ {data.config.minBodyAtr}×) · {selected.preconfirmationOverlapBars} bar(s)
            touched the zone before confirmation.
          </div>
          <div>
            State: <b>{STATE_LABEL[selected.state]}</b>
            {selected.firstRetestAtMs != null && <> · first retest {fmtIst(selected.firstRetestAtMs)}</>}
            {selected.invalidatedAtMs != null && <> · invalidated {fmtIst(selected.invalidatedAtMs)}</>}. Invalidation rule: a 5-min
            close {selected.side === 'bullish' ? `below ${rupee(selected.zoneLow)}` : `above ${rupee(selected.zoneHigh)}`} (a wick alone
            does not count).
          </div>
        </div>
      )}
    </div>
  );
}
