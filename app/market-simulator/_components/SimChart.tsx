'use client';

import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
  type Time,
} from 'lightweight-charts';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { SimCandle } from '@/lib/simulator/types';
import type { UseSimulator } from '../_hooks/use-simulator';
import { ema, type IndicatorBar, vwapByDay } from '../_lib/indicators';

// Dhan timestamps are UTC epoch seconds; shift to IST so the axis reads 09:15–15:30.
// lightweight-charts has no native timezone, so we pre-shift and render the
// shifted value as if UTC — the axis then shows IST wall-clock.
const IST_OFFSET = 5.5 * 3600;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const VISIBLE_BARS = 90; // fixed window → consistent candle width + left→right fill

/** Which overlays/series are shown — toggled from the page legend. */
export interface SeriesVisibility {
  volume: boolean;
  oi: boolean;
  vwap: boolean;
  ema9: boolean;
  ema20: boolean;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Axis tick label for an IST-shifted unix-seconds value. */
function istTick(time: number, tickType: number): string {
  const d = new Date(time * 1000);
  // tickType: 0=Year 1=Month 2=DayOfMonth 3=Time 4=TimeWithSeconds
  if (tickType <= 2) return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** Full IST datetime for the crosshair label. */
function istCrosshair(time: number): string {
  const d = new Date(time * 1000);
  return `${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}  ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** Indian compact notation for volume / OI axes (1.23Cr, 4.50L, 12.3K). */
function compactINR(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return `${Math.round(v)}`;
}

const upColor = (up: boolean) => (up ? 'rgba(16,185,129,0.45)' : 'rgba(239,68,68,0.45)');

interface Props {
  sim: UseSimulator;
  /** OI is only meaningful for F&O (gates the OI series). */
  showOi: boolean;
  visibility: SeriesVisibility;
}

export default function SimChart({ sim, showOi, visibility }: Props) {
  const { resolvedTheme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const oiRef = useRef<ISeriesApi<'Line'> | null>(null);
  const vwapRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ema20Ref = useRef<ISeriesApi<'Line'> | null>(null);

  // Revealed bars only — powers the viewport window AND indicators (fog-of-war).
  const barsRef = useRef<IndicatorBar[]>([]);

  const { onQuote, onSnapshot } = sim;

  // Live refs so handlers bound once always see current values without re-subscribing.
  const seekTimeRef = useRef(sim.seekTime);
  const visibilityRef = useRef(visibility);
  const showOiRef = useRef(showOi);
  useEffect(() => {
    seekTimeRef.current = sim.seekTime;
  }, [sim.seekTime]);

  const palette = useMemo(() => {
    const isDark = resolvedTheme !== 'light';
    return {
      bg: 'transparent', // inherit the themed container background (bg-card/bg-background)
      text: isDark ? '#94a3b8' : '#475569',
      grid: isDark ? '#1e293b' : '#e2e8f0',
    };
  }, [resolvedTheme]);

  /**
   * Keep a FIXED-width window so candle width is constant regardless of how many
   * bars are revealed. While the revealed count is smaller than the window, we
   * still show the full window (bars fill from the left, empty space to the
   * right for not-yet-revealed time). Once bars exceed the window, it scrolls.
   */
  const applyWindow = useCallback((count: number) => {
    if (!chartRef.current || count <= 0) return;
    const RIGHT_PAD = 3;
    let from: number;
    let to: number;
    if (count + RIGHT_PAD <= VISIBLE_BARS) {
      from = -1;
      to = VISIBLE_BARS - 1; // fixed full window → constant (small) candle width
    } else {
      to = count + RIGHT_PAD;
      from = to - VISIBLE_BARS;
    }
    chartRef.current.timeScale().setVisibleLogicalRange({ from, to });
  }, []);

  /** Recompute VWAP + EMAs from revealed bars and push to their line series. */
  const recomputeIndicators = useCallback(() => {
    const bars = barsRef.current;
    const vw = vwapRef.current;
    const e9 = ema9Ref.current;
    const e20 = ema20Ref.current;
    if (!vw || !e9 || !e20 || bars.length === 0) return;
    const closes = bars.map((b) => b.close);
    const vwapVals = vwapByDay(bars);
    const ema9Vals = ema(closes, 9);
    const ema20Vals = ema(closes, 20);
    vw.setData(bars.map((b, i) => ({ time: (b.time + IST_OFFSET) as Time, value: vwapVals[i] })));
    e9.setData(bars.map((b, i) => ({ time: (b.time + IST_OFFSET) as Time, value: ema9Vals[i] })));
    e20.setData(bars.map((b, i) => ({ time: (b.time + IST_OFFSET) as Time, value: ema20Vals[i] })));
  }, []);

  // -- build chart --
  useEffect(() => {
    if (!containerRef.current) return;
    const vis = visibilityRef.current;
    const oiVisible = showOiRef.current && vis.oi;

    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: palette.bg }, textColor: palette.text },
      grid: { vertLines: { color: palette.grid }, horzLines: { color: palette.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      localization: {
        locale: 'en-IN',
        timeFormatter: (t: unknown) => istCrosshair(t as number),
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: palette.grid,
        rightOffset: 3,
        barSpacing: 7,
        minBarSpacing: 2,
        shiftVisibleRangeOnNewBar: false,
        tickMarkFormatter: (t: unknown, tickType: number) => istTick(t as number, tickType),
      },
      rightPriceScale: { borderColor: palette.grid, scaleMargins: { top: 0.1, bottom: 0.26 } },
      autoSize: true,
    });

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
      priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
      lastValueVisible: true,
      priceLineVisible: true, // TradingView-style last-price tag
    });

    // VWAP + EMAs overlay the candle (right) price scale.
    const vwap = chart.addSeries(LineSeries, {
      color: '#3b82f6',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      visible: vis.vwap,
    });
    const ema9 = chart.addSeries(LineSeries, {
      color: '#22d3ee',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      visible: vis.ema9,
    });
    const ema20 = chart.addSeries(LineSeries, {
      color: '#a855f7',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      visible: vis.ema20,
    });

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'custom', formatter: compactINR, minMove: 1 },
      priceScaleId: 'vol',
      visible: vis.volume,
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    const oi = chart.addSeries(LineSeries, {
      color: '#f59e0b',
      lineWidth: 2,
      priceScaleId: 'oi',
      priceFormat: { type: 'custom', formatter: compactINR, minMove: 1 },
      priceLineVisible: false,
      lastValueVisible: oiVisible,
      visible: oiVisible,
    });
    chart.priceScale('oi').applyOptions({ scaleMargins: { top: 0.05, bottom: 0.85 } });

    // Click a candle → replay from there (undo IST shift to recover real epoch).
    chart.subscribeClick((param) => {
      if (param.time == null) return;
      seekTimeRef.current((param.time as number) - IST_OFFSET);
    });

    chartRef.current = chart;
    candleRef.current = candle;
    volumeRef.current = volume;
    oiRef.current = oi;
    vwapRef.current = vwap;
    ema9Ref.current = ema9;
    ema20Ref.current = ema20;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      oiRef.current = null;
      vwapRef.current = null;
      ema9Ref.current = null;
      ema20Ref.current = null;
    };
  }, [palette]);

  // -- snapshot: hydrate finalized candles / reset on load + seek --
  useEffect(() => {
    const hydrate = (finalized: SimCandle[]) => {
      const candle = candleRef.current;
      const volume = volumeRef.current;
      const oi = oiRef.current;
      if (!candle || !volume || !oi) return;

      barsRef.current = finalized.map((c) => ({
        time: c.time,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));

      candle.setData(
        finalized.map((c) => ({
          time: (c.time + IST_OFFSET) as Time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
      );
      volume.setData(
        finalized.map((c) => ({
          time: (c.time + IST_OFFSET) as Time,
          value: c.volume,
          color: upColor(c.close >= c.open),
        })),
      );
      oi.setData(finalized.map((c) => ({ time: (c.time + IST_OFFSET) as Time, value: c.oi })));
      recomputeIndicators();
      applyWindow(finalized.length);
    };
    return onSnapshot(hydrate);
  }, [onSnapshot, recomputeIndicators, applyWindow]);

  // -- live ticks: update the forming/closed candle --
  useEffect(() => {
    return onQuote((q) => {
      const candle = candleRef.current;
      const volume = volumeRef.current;
      const oi = oiRef.current;
      if (!candle || !volume) return;

      const bars = barsRef.current;
      const last = bars[bars.length - 1];
      const newBar = !last || last.time !== q.candleTime;
      const bar: IndicatorBar = {
        time: q.candleTime,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.candleVolume,
      };
      if (newBar) bars.push(bar);
      else bars[bars.length - 1] = bar;

      const t = (q.candleTime + IST_OFFSET) as Time;
      try {
        candle.update({ time: t, open: q.open, high: q.high, low: q.low, close: q.close });
        volume.update({ time: t, value: q.candleVolume, color: upColor(q.close >= q.open) });
        if (oi) oi.update({ time: t, value: q.oi });
        recomputeIndicators();
        if (newBar) applyWindow(bars.length);
      } catch {
        // out-of-order update during a seek reset — safe to ignore
      }
    });
  }, [onQuote, recomputeIndicators, applyWindow]);

  // -- live series visibility toggles --
  useEffect(() => {
    visibilityRef.current = visibility;
    showOiRef.current = showOi;
    volumeRef.current?.applyOptions({ visible: visibility.volume });
    oiRef.current?.applyOptions({ visible: showOi && visibility.oi, lastValueVisible: showOi && visibility.oi });
    vwapRef.current?.applyOptions({ visible: visibility.vwap });
    ema9Ref.current?.applyOptions({ visible: visibility.ema9 });
    ema20Ref.current?.applyOptions({ visible: visibility.ema20 });
  }, [visibility, showOi]);

  return <div ref={containerRef} className="h-full w-full" />;
}
