'use client';

import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  type IChartApi,
  type Time,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';

interface OptionChartProps {
  bars: { timestamp: number; open: number; high: number; low: number; close: number; volume?: number }[];
  entryBar?: { timestamp: number; price: number; label?: string };
  exitBar?: { timestamp: number; price: number; label?: string };
  title?: string;
  height?: number;
}

export function OptionChart({ bars, entryBar, exitBar, title, height = 350 }: OptionChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current || bars.length === 0) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#9ca3af',
        fontSize: 12,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      crosshair: {
        horzLine: { labelBackgroundColor: '#374151' },
        vertLine: { labelBackgroundColor: '#374151' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.1)',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: number) => {
          const d = new Date(time * 1000);
          const h = d.getUTCHours();
          const m = d.getUTCMinutes();
          const ampm = h >= 12 ? 'PM' : 'AM';
          const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
          return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
        },
      },
      localization: {
        timeFormatter: (time: number) => {
          const d = new Date(time * 1000);
          const h = d.getUTCHours();
          const m = d.getUTCMinutes();
          const ampm = h >= 12 ? 'PM' : 'AM';
          const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
          return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
        },
      },
      handleScale: { mouseWheel: true, pinch: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    });

    const toIST = (ts: number) => ts + 5.5 * 3600;

    candleSeries.setData(
      bars.map((b) => ({
        time: toIST(b.timestamp) as Time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    );

    // Volume histogram
    const hasVolume = bars.some((b) => (b.volume ?? 0) > 0);
    if (hasVolume) {
      const volSeries = chart.addSeries(HistogramSeries, {
        color: 'rgba(59, 130, 246, 0.3)',
        priceFormat: { type: 'volume' },
        priceScaleId: '',
      });
      chart.priceScale('').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      volSeries.setData(
        bars.map((b) => ({
          time: toIST(b.timestamp) as Time,
          value: b.volume ?? 0,
          color: b.close >= b.open ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)',
        })),
      );
    }

    // Trade markers
    const markers: {
      time: Time;
      position: 'belowBar' | 'aboveBar';
      color: string;
      shape: 'arrowUp' | 'arrowDown';
      text: string;
    }[] = [];
    if (entryBar) {
      markers.push({
        time: toIST(entryBar.timestamp) as Time,
        position: 'belowBar',
        color: '#10b981',
        shape: 'arrowUp',
        text: entryBar.label ?? `BUY \u20B9${entryBar.price}`,
      });
    }
    if (exitBar) {
      markers.push({
        time: toIST(exitBar.timestamp) as Time,
        position: 'aboveBar',
        color: '#ef4444',
        shape: 'arrowDown',
        text: exitBar.label ?? `SELL \u20B9${exitBar.price}`,
      });
    }
    if (markers.length > 0) {
      markers.sort((a, b) => (a.time as number) - (b.time as number));
      createSeriesMarkers(candleSeries, markers);
    }

    // Entry/exit price lines
    if (entryBar) {
      candleSeries.createPriceLine({
        price: entryBar.price,
        color: 'rgba(16, 185, 129, 0.5)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `Entry \u20B9${entryBar.price}`,
      });
    }
    if (exitBar) {
      candleSeries.createPriceLine({
        price: exitBar.price,
        color: 'rgba(239, 68, 68, 0.5)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `Exit \u20B9${exitBar.price}`,
      });
    }

    chart.timeScale().fitContent();
    chartRef.current = chart;

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        chart.applyOptions({ width: e.contentRect.width });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [bars, entryBar, exitBar]);

  return (
    <div className="rounded-xl bg-card border border-border p-4">
      <h3 className="text-xs font-bold text-muted-foreground uppercase mb-3">
        {title ?? 'Option Premium'} (5-min Candlestick)
      </h3>
      <div ref={containerRef} style={{ height }} className="w-full" />
    </div>
  );
}
