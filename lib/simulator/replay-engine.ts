/**
 * Market Simulator — replay engine (singleton).
 *
 * The server-side clock. It owns the loaded timeline, the playback cursor, and
 * the set of connected SSE clients, and advances through the synthesized tick
 * stream at the configured speed — broadcasting each tick as a `quote` event so
 * every browser sees an identical, deterministic "live" market.
 *
 * Mirrors the `LiveManager` pattern (global singleton + SSE fan-out) so the
 * front-end can consume it exactly like the real live feed. Order execution is
 * intentionally not here yet: a future order engine subscribes to the same tick
 * stream (see `onTick`) and fills against `quote.ltp`, mirroring openbull's
 * tick-driven sandbox.
 */

import { resolveConfig, type SimulatorConfig } from './config';
import { loadTimeline } from './data-source';
import { synthesizeTicks } from './quote-synthesizer';
import type { SimCandle, SimClockState, SimEvent, SimInstrumentKind, SimInterval, SimQuote, SimStatus } from './types';

const TAG = '[SimEngine]';

/** A consumer of the raw tick stream (e.g. a future paper-order engine). */
export type TickListener = (quote: SimQuote) => void;

class ReplayEngine {
  private clients: Set<ReadableStreamDefaultController> = new Set();
  private tickListeners: Set<TickListener> = new Set();

  private config: SimulatorConfig | null = null;
  private candles: SimCandle[] = [];
  private ticks: SimQuote[] = [];

  private state: SimClockState = 'idle';
  private cursor = 0;
  private error: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  // -- client management (SSE) -------------------------------------------

  addClient(controller: ReadableStreamDefaultController): void {
    this.clients.add(controller);
    console.log(`${TAG} client + (total: ${this.clients.size})`);
    // Replay current state so a freshly-connected client is in sync.
    this.send(controller, { event: 'info', data: { status: 'connected' } });
    if (this.config && this.ticks.length > 0) {
      this.send(controller, { event: 'loaded', data: this.loadedMeta() });
      this.send(controller, {
        event: 'snapshot',
        data: {
          finalizedCandles: this.finalizedCandles(),
          quote: this.quoteAt(this.cursor - 1),
          status: this.status(),
        },
      });
    }
    this.send(controller, { event: 'status', data: this.status() });
  }

  removeClient(controller: ReadableStreamDefaultController): void {
    this.clients.delete(controller);
    console.log(`${TAG} client - (remaining: ${this.clients.size})`);
  }

  /** Register a server-side tick consumer (order engine, recorder, …). */
  onTick(listener: TickListener): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  // -- session lifecycle -------------------------------------------------

  async load(partial: Partial<SimulatorConfig>): Promise<SimStatus> {
    this.stopTimer();
    this.state = 'loading';
    this.error = null;
    this.broadcastStatus();

    try {
      const requested = resolveConfig(partial);
      const { candles, config } = await loadTimeline(requested);
      this.candles = candles;
      this.config = config;
      this.ticks = synthesizeTicks(candles, config);
      this.cursor = 0;
      this.state = 'ready';

      this.broadcast({ event: 'loaded', data: this.loadedMeta() });
      this.broadcast({
        event: 'snapshot',
        data: { finalizedCandles: [], quote: null, status: this.status() },
      });
      this.broadcastStatus();

      if (!config.startPaused) this.play();
      return this.status();
    } catch (err) {
      this.state = 'idle';
      this.error = (err as Error).message;
      console.warn(`${TAG} load failed:`, this.error);
      this.broadcastStatus();
      throw err;
    }
  }

  play(): SimStatus {
    if (!this.config || this.ticks.length === 0) return this.status();
    if (this.cursor >= this.ticks.length) this.cursor = 0;
    if (this.state === 'playing') return this.status();
    this.state = 'playing';
    this.broadcastStatus();
    this.scheduleNext();
    return this.status();
  }

  pause(): SimStatus {
    this.stopTimer();
    if (this.state === 'playing') this.state = 'paused';
    this.broadcastStatus();
    return this.status();
  }

  /** Advance exactly one tick (manual stepping while paused). */
  step(): SimStatus {
    if (!this.config || this.ticks.length === 0) return this.status();
    this.stopTimer();
    this.state = 'paused';
    this.emitTick();
    this.broadcastStatus();
    return this.status();
  }

  /** Jump the cursor to a candle index; replays the chart up to that point. */
  seek(candleIndex: number): SimStatus {
    if (!this.config || this.ticks.length === 0) return this.status();
    const wasPlaying = this.state === 'playing';
    this.stopTimer();

    const clamped = Math.min(Math.max(0, Math.round(candleIndex)), this.candles.length - 1);
    // First tick of the target candle.
    const target = this.ticks.findIndex((t) => t.candleIndex === clamped);
    this.cursor = target < 0 ? 0 : target;
    this.state = wasPlaying ? 'playing' : 'paused';

    this.broadcast({
      event: 'snapshot',
      data: {
        finalizedCandles: this.finalizedCandles(),
        quote: this.quoteAt(this.cursor - 1),
        status: this.status(),
      },
    });
    this.broadcastStatus();
    if (wasPlaying) this.scheduleNext();
    return this.status();
  }

  /**
   * Jump to a historical timestamp (epoch seconds) — the "Jump to Time" control.
   * Lands on the last candle whose open time is <= the target, so we never
   * reveal a bar from the future of the requested moment.
   */
  seekTime(epochSeconds: number): SimStatus {
    if (!this.config || this.candles.length === 0) return this.status();
    let idx = 0;
    for (let i = 0; i < this.candles.length; i++) {
      if (this.candles[i].time <= epochSeconds) idx = i;
      else break;
    }
    return this.seek(idx);
  }

  setSpeed(speed: number): SimStatus {
    if (this.config) {
      this.config = resolveConfig({ ...this.config, speed });
    }
    this.broadcastStatus();
    return this.status();
  }

  reset(): SimStatus {
    this.stopTimer();
    this.cursor = 0;
    if (this.config && this.ticks.length > 0) this.state = 'ready';
    this.broadcast({
      event: 'snapshot',
      data: { finalizedCandles: [], quote: null, status: this.status() },
    });
    this.broadcastStatus();
    return this.status();
  }

  status(): SimStatus {
    const c = this.config;
    const cur = this.ticks[Math.min(this.cursor, this.ticks.length - 1)];
    return {
      state: this.state,
      symbol: c?.symbol ?? null,
      instrumentKind: (c?.instrumentKind as SimInstrumentKind) ?? null,
      interval: (c?.interval as SimInterval) ?? null,
      fromDate: c?.fromDate ?? null,
      toDate: c?.toDate ?? null,
      speed: c?.speed ?? 1,
      cursor: this.cursor,
      totalTicks: this.ticks.length,
      totalCandles: this.candles.length,
      candleIndex: cur?.candleIndex ?? 0,
      simTime: cur?.lastTradeTime ?? null,
      progress: this.ticks.length > 0 ? this.cursor / this.ticks.length : 0,
      clientCount: this.clients.size,
      error: this.error,
    };
  }

  // -- internals ---------------------------------------------------------

  private scheduleNext(): void {
    if (this.state !== 'playing' || !this.config) return;
    const interval = Math.max(10, this.config.baseTickMs / this.config.speed);
    this.timer = setTimeout(() => {
      if (this.state !== 'playing') return;
      this.emitTick();
      if (this.cursor >= this.ticks.length) {
        this.onFinished();
        return;
      }
      this.scheduleNext();
    }, interval);
  }

  /** Emit the tick at the cursor and advance. */
  private emitTick(): void {
    if (this.cursor >= this.ticks.length) {
      this.onFinished();
      return;
    }
    const quote = { ...this.ticks[this.cursor], ts: Date.now() };
    this.cursor += 1;
    this.broadcast({ event: 'quote', data: quote });
    for (const listener of this.tickListeners) {
      try {
        listener(quote);
      } catch (err) {
        console.warn(`${TAG} tick listener threw:`, (err as Error).message);
      }
    }
  }

  private onFinished(): void {
    this.stopTimer();
    if (this.config?.loop) {
      this.cursor = 0;
      this.broadcast({
        event: 'snapshot',
        data: { finalizedCandles: [], quote: null, status: this.status() },
      });
      this.scheduleNext();
      return;
    }
    this.state = 'finished';
    this.broadcastStatus();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Candles fully closed before the cursor (for chart hydration / seek). */
  private finalizedCandles(): SimCandle[] {
    const cur = this.ticks[Math.min(this.cursor, this.ticks.length - 1)];
    const upTo = cur ? cur.candleIndex : 0;
    return this.candles.slice(0, Math.max(0, upTo));
  }

  private quoteAt(index: number): SimQuote | null {
    if (index < 0 || index >= this.ticks.length) return null;
    return this.ticks[index];
  }

  private loadedMeta() {
    const c = this.config!;
    return {
      symbol: c.symbol,
      instrumentKind: c.instrumentKind,
      interval: c.interval,
      fromDate: c.fromDate,
      toDate: c.toDate,
      totalCandles: this.candles.length,
      totalTicks: this.ticks.length,
      firstTime: this.candles[0]?.time ?? 0,
      lastTime: this.candles[this.candles.length - 1]?.time ?? 0,
    };
  }

  private broadcastStatus(): void {
    this.broadcast({ event: 'status', data: this.status() });
  }

  private broadcast(event: SimEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    const encoded = new TextEncoder().encode(payload);
    const dead: ReadableStreamDefaultController[] = [];
    this.clients.forEach((client) => {
      try {
        client.enqueue(encoded);
      } catch {
        dead.push(client);
      }
    });
    for (const c of dead) this.clients.delete(c);
  }

  private send(controller: ReadableStreamDefaultController, event: SimEvent): void {
    try {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    } catch {
      this.clients.delete(controller);
    }
  }
}

console.log(`${TAG} module loaded`);

const globalRef = global as unknown as { __simReplayEngine?: ReplayEngine };
if (!globalRef.__simReplayEngine) {
  globalRef.__simReplayEngine = new ReplayEngine();
  console.log(`${TAG} new singleton created`);
}

export const replayEngine: ReplayEngine = globalRef.__simReplayEngine;
