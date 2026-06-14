'use client';

import { ColorType, createChart, type IChartApi, LineSeries, type Time } from 'lightweight-charts';
import { useEffect, useRef } from 'react';

interface PnlChartProps {
  curve: { timestamp: number; pnl: number }[];
  tfPnl?: number;
  height?: number;
}

export function PnlChart({ curve, tfPnl, height = 180 }: PnlChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current || curve.length === 0) return;

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
      handleScale: { mouseWheel: true, pinch: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
    });

    const pnlSeries = chart.addSeries(LineSeries, {
      color: '#22c55e',
      lineWidth: 2,
      title: 'P&L',
      priceLineVisible: false,
      lastValueVisible: true,
    });

    const toIST = (ts: number) => ts + 5.5 * 3600;
    pnlSeries.setData(curve.map((c) => ({ time: toIST(c.timestamp) as Time, value: c.pnl })));

    // Zero line
    pnlSeries.createPriceLine({
      price: 0,
      color: 'rgba(100, 116, 139, 0.3)',
      lineWidth: 1,
      lineStyle: 0,
      axisLabelVisible: false,
    });

    // TF P&L reference
    if (tfPnl) {
      pnlSeries.createPriceLine({
        price: tfPnl,
        color: '#eab308',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `TF: \u20B9${tfPnl.toLocaleString()}`,
      });
    }

    chart.timeScale().fitContent();
    chartRef.current = chart;

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) chart.applyOptions({ width: e.contentRect.width });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [curve, tfPnl]);

  return (
    <div className="rounded-xl bg-card border border-border p-4">
      <h3 className="text-xs font-bold text-muted-foreground uppercase mb-3">
        P&L from Entry <span className="text-yellow-600 dark:text-yellow-500 text-[10px]">(dashed = TF&apos;s P&L)</span>
      </h3>
      <div ref={containerRef} style={{ height }} className="w-full" />
    </div>
  );
}
