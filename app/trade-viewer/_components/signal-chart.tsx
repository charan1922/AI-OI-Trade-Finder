'use client';

import { ColorType, createChart, type IChartApi, LineSeries, type Time } from 'lightweight-charts';
import { useEffect, useRef } from 'react';

interface SignalChartProps {
  signals: { timestamp: number; rFactor: number; adx: number }[];
  height?: number;
}

export function SignalChart({ signals, height = 200 }: SignalChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current || signals.length === 0) return;

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
      rightPriceScale: {
        borderColor: 'rgba(245, 158, 11, 0.2)',
        scaleMargins: { top: 0.05, bottom: 0.05 },
      },
      leftPriceScale: {
        visible: true,
        borderColor: 'rgba(59, 130, 246, 0.2)',
        scaleMargins: { top: 0.05, bottom: 0.05 },
      },
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

    const toIST = (ts: number) => ts + 5.5 * 3600;

    // R-Factor line — LEFT axis (blue)
    const rSeries = chart.addSeries(LineSeries, {
      color: '#3b82f6',
      lineWidth: 2,
      title: 'R-Factor',
      priceLineVisible: false,
      lastValueVisible: true,
      priceScaleId: 'left',
    });
    rSeries.setData(signals.map((s) => ({ time: toIST(s.timestamp) as Time, value: s.rFactor })));

    // R=2.0 reference line
    rSeries.createPriceLine({
      price: 2.0,
      color: 'rgba(59, 130, 246, 0.3)',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: 'R=2.0',
    });

    // ADX line — RIGHT axis (amber, default)
    const adxSeries = chart.addSeries(LineSeries, {
      color: '#f59e0b',
      lineWidth: 2,
      title: 'ADX',
      priceLineVisible: false,
      lastValueVisible: true,
    });
    adxSeries.setData(
      signals.filter((s) => s.adx > 0).map((s) => ({ time: toIST(s.timestamp) as Time, value: s.adx })),
    );

    // ADX=28 reference
    adxSeries.createPriceLine({
      price: 28,
      color: 'rgba(245, 158, 11, 0.3)',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: 'ADX=28',
    });

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
  }, [signals]);

  return (
    <div className="rounded-xl bg-card border border-border p-4">
      <h3 className="text-xs font-bold text-muted-foreground uppercase mb-3">
        R-Factor <span className="text-blue-600 dark:text-blue-400">(blue, left)</span> + ADX{' '}
        <span className="text-amber-600 dark:text-amber-400">(amber, right)</span>
      </h3>
      <div ref={containerRef} style={{ height }} className="w-full" />
    </div>
  );
}
