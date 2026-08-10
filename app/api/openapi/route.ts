import { NextResponse } from 'next/server';
import { adminOnly } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/openapi — hand-maintained OpenAPI 3.1 description of every route
 * under /app/api. Served as JSON and rendered by the Swagger UI page at
 * /api-docs. Keep this in sync when adding/changing API routes.
 *
 * (Hand-written on purpose: the project avoids new third-party deps, so there's
 * no codegen step. It's a small, stable surface — one object to update.)
 */

const ok = (description: string) => ({
  description,
  content: { 'application/json': { schema: { type: 'object' } } },
});

const errorResponse = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error: { type: 'string' },
        },
      },
    },
  },
});

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'AI OI Trade Finder API',
    version: '0.0.1',
    description:
      'Internal HTTP API for AI OI Trade Finder: replay engine, backtesting, NSE bhavcopy sync, live urgency, sector heatmap, and the AI trade assistant. All routes are `force-dynamic`. Most return `{ success, data }` on success and `{ success: false, error }` on failure.',
  },
  servers: [{ url: '/', description: 'This server' }],
  tags: [
    {
      name: 'Simulator',
      description: 'Replay engine: load a dataset, drive playback, stream ticks.',
    },
    {
      name: 'Backtest',
      description: 'Signal scan + vectorbt backtest over TradeFinder trades.',
    },
    {
      name: 'Market Data',
      description: 'NSE bhavcopy sync, trading calendar, F&O lot sizes.',
    },
    {
      name: 'Live',
      description: 'Real-time urgency, intraday OI series, dynamic sector watchlist.',
    },
    {
      name: 'Trade Suggest',
      description: 'Daily near-ATM option suggestions (09:40–11:00 IST) + same-day scorecard.',
    },
    {
      name: 'Config',
      description: 'Runtime feature toggles + numeric settings (the /config page).',
    },
    {
      name: 'Fyers',
      description: 'Fyers auth + the autonomous 5-min candle/OI recorder.',
    },
    {
      name: 'NSE',
      description: 'Official NSE data: indices heatmap, pulse feeds, EOD movers, OI audit.',
    },
    {
      name: 'Heatmap',
      description: 'F&O sector treemap + cross-check vs official NSE indices.',
    },
    {
      name: 'AI Assistant',
      description: 'Azure OpenAI trade assistant with function calling.',
    },
    {
      name: 'Dhan Auth',
      description: 'Dhan access-token status + TOTP regeneration.',
    },
  ],
  paths: {
    // ───────────────────────── Simulator ─────────────────────────
    '/api/simulator/control': {
      get: {
        tags: ['Simulator'],
        summary: 'Current replay engine status',
        responses: {
          '200': ok('Engine status (loaded dataset, position, play state, speed).'),
        },
      },
      post: {
        tags: ['Simulator'],
        summary: 'Drive the replay engine',
        description:
          'Single action-dispatched control surface. `load` accepts a partial SimulatorConfig; `seek`/`seekTime`/`speed` use the matching field.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['action'],
                properties: {
                  action: {
                    type: 'string',
                    enum: ['load', 'play', 'pause', 'step', 'seek', 'seekTime', 'speed', 'reset'],
                  },
                  config: { $ref: '#/components/schemas/SimulatorConfig' },
                  candleIndex: {
                    type: 'integer',
                    description: 'For action=seek',
                  },
                  time: {
                    type: 'integer',
                    description: 'For action=seekTime (epoch seconds)',
                  },
                  speed: {
                    type: 'number',
                    description: 'For action=speed (multiplier)',
                  },
                },
              },
              examples: {
                load: {
                  value: {
                    action: 'load',
                    config: {
                      symbol: 'RELIANCE',
                      instrumentKind: 'FUTSTK',
                      fromDate: '2026-01-01',
                      toDate: '2026-01-31',
                      interval: '5',
                    },
                  },
                },
                play: { value: { action: 'play' } },
                seek: { value: { action: 'seek', candleIndex: 42 } },
                speed: { value: { action: 'speed', speed: 4 } },
              },
            },
          },
        },
        responses: {
          '200': ok('Updated engine status'),
          '400': errorResponse('Invalid JSON / unknown action'),
          '500': errorResponse('Engine error'),
        },
      },
    },
    '/api/simulator/search': {
      get: {
        tags: ['Simulator'],
        summary: 'Symbol suggestions for the picker',
        parameters: [
          {
            name: 'q',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: 'Search query, e.g. "REL"',
          },
        ],
        responses: {
          '200': ok('Matching symbols: [{ symbol, name, securityId }]'),
          '409': errorResponse('Master contracts not synced (code: MASTER_NOT_SYNCED)'),
          '500': errorResponse('Lookup error'),
        },
      },
    },
    '/api/simulator/download': {
      get: {
        tags: ['Simulator'],
        summary: 'Catalog of already-downloaded datasets',
        responses: { '200': ok('Dataset catalog') },
      },
      post: {
        tags: ['Simulator'],
        summary: 'Download real intraday data from Dhan',
        description:
          'Fetches exact intraday candles (with OI for F&O) for a symbol + date window, caches them, and registers the dataset.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SimulatorConfig' },
              example: {
                symbol: 'RELIANCE',
                instrumentKind: 'FUTSTK',
                fromDate: '2026-01-01',
                toDate: '2026-01-31',
                interval: '5',
              },
            },
          },
        },
        responses: {
          '200': ok('Dataset summary (candles count, time range, resolved ids)'),
          '402': errorResponse('Dhan Data APIs not subscribed (code: DATA_API_NOT_SUBSCRIBED)'),
          '409': errorResponse('Master contracts not synced (code: MASTER_NOT_SYNCED)'),
          '502': errorResponse('Dhan auth failure (code: DHAN_AUTH)'),
          '500': errorResponse('Download error'),
        },
      },
    },
    '/api/simulator/stream': {
      get: {
        tags: ['Simulator'],
        summary: 'SSE stream of replay ticks',
        description:
          'Server-Sent Events mirroring the live Dhan feed contract. Connect with EventSource — not testable via "Try it out".',
        responses: {
          '200': {
            description: 'text/event-stream of tick events + heartbeats',
            content: { 'text/event-stream': { schema: { type: 'string' } } },
          },
        },
      },
    },

    // ───────────────────────── Backtest ─────────────────────────
    '/api/backtest/download-stream': {
      post: {
        tags: ['Backtest'],
        summary: 'Stream per-symbol download progress (SSE)',
        description:
          'Downloads equity/futures/option 5-min data + bhavcopy for a list of trades, emitting SSE progress events.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['symbols'],
                properties: {
                  symbols: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        symbol: { type: 'string' },
                        optionType: { type: 'string', enum: ['CE', 'PE', ''] },
                        strike: { type: 'number' },
                        date: { type: 'string', format: 'date' },
                        spotPrice: { type: 'number' },
                      },
                    },
                  },
                },
              },
              example: {
                symbols: [
                  {
                    symbol: 'RELIANCE',
                    optionType: 'CE',
                    strike: 1300,
                    date: '2026-03-20',
                    spotPrice: 1295,
                  },
                ],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'text/event-stream of progress/error/complete events',
            content: { 'text/event-stream': { schema: { type: 'string' } } },
          },
          '400': errorResponse('No symbols provided'),
        },
      },
    },
    '/api/backtest/tf-validate': {
      get: {
        tags: ['Backtest'],
        summary: 'TF-validation data status',
        responses: {
          '200': ok('Row counts + TF trades'),
          '500': errorResponse('Status error'),
        },
      },
      post: {
        tags: ['Backtest'],
        summary: 'TF-validation actions (download / backtest / detail …)',
        description:
          'Action-dispatched. Each action takes its own fields (e.g. trade-detail needs symbol/date/optionType/strike).',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['action'],
                properties: {
                  action: {
                    type: 'string',
                    enum: [
                      'status',
                      'download',
                      'backtest',
                      'all-tf-trades',
                      'symbol-status',
                      'download-symbols',
                      'download-all-tf',
                      'trade-detail',
                      'trade-context',
                      'simulate',
                      'tf-trades-list',
                      'debug',
                    ],
                  },
                  symbol: { type: 'string' },
                  date: { type: 'string', format: 'date' },
                  optionType: { type: 'string' },
                  strike: { type: 'number' },
                  symbols: { type: 'array', items: { type: 'string' } },
                  fromDate: { type: 'string', format: 'date' },
                  toDate: { type: 'string', format: 'date' },
                  days: { type: 'integer' },
                },
              },
              examples: {
                status: { value: { action: 'status' } },
                backtest: { value: { action: 'backtest' } },
                tradeDetail: {
                  value: {
                    action: 'trade-detail',
                    symbol: 'RELIANCE',
                    date: '2026-03-20',
                    optionType: 'CE',
                    strike: 1300,
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': ok('Action-specific payload'),
          '400': errorResponse('Unknown action / no symbols'),
          '500': errorResponse('Action error'),
        },
      },
    },

    // ───────────────────────── Market Data ─────────────────────────
    '/api/bhavcopy': {
      get: {
        tags: ['Market Data'],
        summary: 'Bhavcopy coverage status',
        responses: {
          '200': ok('Coverage status of bhavcopy_days'),
          '500': errorResponse('Status error'),
        },
      },
      post: {
        tags: ['Market Data'],
        summary: 'Sync missing trading days from NSE',
        description: 'User-triggered. When `days` is omitted the window auto-covers every downloaded trade.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  days: {
                    type: 'integer',
                    description: 'Lookback in weekdays (optional)',
                  },
                },
              },
              example: { days: 25 },
            },
          },
        },
        responses: {
          '200': ok('Sync result + status'),
          '500': errorResponse('Sync error'),
        },
      },
    },
    '/api/market-calendar': {
      get: {
        tags: ['Market Data'],
        summary: 'NSE trading-holiday calendar',
        responses: {
          '200': ok('Holidays, data-derived closures, special sessions'),
          '500': errorResponse('Calendar error'),
        },
      },
    },
    '/api/fno-lots': {
      get: {
        tags: ['Market Data'],
        summary: 'F&O lot sizes (Jun/Jul/Aug) per symbol',
        responses: {
          '200': ok('[{ name, symbol, lotJun, lotJul, lotAug, sector }]'),
          '500': errorResponse('CSV read error'),
        },
      },
    },

    // ───────────────────────── Live ─────────────────────────
    '/api/live/quote': {
      post: {
        tags: ['Live'],
        summary: 'Live urgency rows for a watchlist',
        description:
          'Real-time bid/ask spread, order-book imbalance, futures OI level + turnover. Off-hours returns marketOpen:false and no rows. Max 25 symbols.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  symbols: {
                    type: 'array',
                    items: { type: 'string' },
                    maxItems: 25,
                  },
                },
              },
              example: { symbols: ['RELIANCE', 'TCS', 'INFY'] },
            },
          },
        },
        responses: {
          '200': ok('{ marketOpen, rows, symbols }'),
          '500': errorResponse('Quote error'),
        },
      },
    },
    '/api/live/oi-series': {
      get: {
        tags: ['Live'],
        summary: 'Intraday futures-OI series for one symbol',
        parameters: [
          {
            name: 'symbol',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            example: 'RELIANCE',
          },
          {
            name: 'date',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'date' },
            description: 'Defaults to today (IST)',
          },
        ],
        responses: {
          '200': ok('{ symbol, date, series, urgency }'),
          '400': errorResponse('symbol required'),
          '500': errorResponse('Series error'),
        },
      },
    },
    '/api/live/sector-leaders': {
      get: {
        tags: ['Live'],
        summary: 'Dynamic sector-leader watchlist from bhavcopy',
        description: "Per-sector leaders from synced bhavcopy. Gated to F&O-only, excluding the 'avoid' lot-size band.",
        parameters: [
          {
            name: 'basis',
            in: 'query',
            required: false,
            schema: {
              type: 'string',
              enum: ['gainers', 'losers', 'movers'],
              default: 'gainers',
            },
          },
          {
            name: 'perSector',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 4, default: 2 },
          },
        ],
        responses: {
          '200': ok('{ picks, meta }'),
          '400': errorResponse('Not enough bhavcopy sessions'),
          '500': errorResponse('Ranking error'),
        },
      },
    },
    '/api/live/nse-watchlist': {
      get: {
        tags: ['Live'],
        summary: 'Watchlist from a live NSE movers feed',
        description:
          "Builds a Live Urgency watchlist from an NSE pulse feed, gated to F&O-only names with a live future, excluding the 'avoid' lot-size band. Same response shape as /api/live/sector-leaders.",
        parameters: [
          {
            name: 'source',
            in: 'query',
            required: true,
            schema: {
              type: 'string',
              enum: ['nse-oi', 'nse-gainers', 'nse-losers', 'nse-active-value', 'nse-active-volume', 'nse-52wh'],
            },
          },
        ],
        responses: {
          '200': ok('{ picks, meta }'),
          '400': errorResponse('Unknown source'),
          '500': errorResponse('Feed / ranking error'),
        },
      },
    },

    '/api/live/candles': {
      get: {
        tags: ['Live'],
        summary: "Today's 5-min candle series for one stock (from the Fyers recorder)",
        description:
          "A stock's intraday 5-min bars for TODAY from the fyers_candles store (the autonomous Fyers poller refills it full-day every 5 min). The store retains the newest 20 recorded sessions for replay, while this endpoint deliberately returns today only. instrument=FUT rows carry live open interest per bucket. A symbol not yet tracked is enrolled here and appears within one cycle. Empty series = genuinely no data yet, never fabricated.",
        parameters: [
          {
            name: 'symbol',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: 'NSE underlying, e.g. RELIANCE',
          },
          {
            name: 'instrument',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['EQ', 'FUT'], default: 'EQ' },
          },
        ],
        responses: {
          '200': ok('{ symbol, instrument, date, bars }'),
          '400': errorResponse('symbol required'),
        },
      },
    },

    // ───────────────────────── Trade Suggest ─────────────────────────
    '/api/trade-suggest': {
      get: {
        tags: ['Trade Suggest'],
        summary: 'Up to MAX_PICKS near-ATM option suggestions (the /trade-suggest skill endpoint)',
        description:
          'Scans the full tradeable F&O universe (~166 names; SCAN_FULL_UNIVERSE toggle drops back to the ~48 movers-feed names) merged with the NSE movers feeds, gates on the TradeFinder fingerprint (OI evidence: futures OI ≥1.1× 20-day avg OR NSE combined fut+opt OI change ≥5%, plus the experimental USE_BREAKOUT_BYPASS path; spread ≤0.3%, R-Factor ≥4.38 on the 1–10 scale, turnover ≥1.2× avg, price/bias agreement), scores survivors (R-Factor, OI urgency, opening-range breakout, sector breadth) and returns the top MAX_PICKS (default 7, /config-tunable 1–10) with nearest listed ATM strike, live option premium (per-lot cost, −40% premium backstop, ₹5k/lot target) + spot-level entry/SL/1:2-target plan. Extended movers (≥3% from open) are hard-skipped while EXCLUDE_EXTENDED is on. Active 09:40–11:00 IST; force=1 bypasses the window (not market hours). Picks persist to trade_suggestions.',
        parameters: [
          {
            name: 'force',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['1'] },
            description: 'Bypass the time window (testing)',
          },
          {
            name: 'view',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['leaderboard'] },
            description:
              'EOD TF-style spread-linear leaderboard from bhavcopy (post-market comparator; supports &date=&limit=)',
          },
          {
            name: 'date',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'date' },
            description: 'Leaderboard session (defaults to latest synced bhavcopy)',
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', default: 15 },
            description: 'Leaderboard rows',
          },
        ],
        responses: {
          '200': ok(
            '{ window, marketOpen, scanned, gated, suggestions (each with factors: Supertrend/VWAP/ATR/eqTurnoverRatio/combinedOiLevel/combinedOiSlope30m (build rate, pct-pts per ~30 min)/sectorPct + sectorAdvanceRatio + sectorAligned (turnover-weighted sector alignment)), tilt, sectorFlow, earlierToday }'
          ),
          '500': errorResponse('Engine error'),
        },
      },
      post: {
        tags: ['Trade Suggest'],
        summary: 'Scorecard (review) or cross-day calibration stats',
        description:
          "action:'review' — fills each of today's persisted suggestions with the spot move that followed (max favorable/adverse excursion + close, % vs spot at call) from fyers_candles; must run the same day (the candle store clears at the next session). action:'stats' (+ optional days, default 30) — hit-rate (≥1% favorable), avg excursions, by-rank / by-score-bucket breakdown over all reviewed suggestions.",
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['action'],
                properties: {
                  action: { type: 'string', enum: ['review', 'stats'] },
                  days: {
                    type: 'integer',
                    default: 30,
                    description: "Look-back window for action:'stats'",
                  },
                },
              },
              example: { action: 'review' },
            },
          },
        },
        responses: {
          '200': ok('{ date, reviewed, skipped, suggestions } | { stats }'),
          '400': errorResponse('Unknown action'),
          '500': errorResponse('Review error'),
        },
      },
    },

    // ───────────────────────── Fyers ─────────────────────────
    '/api/fyers/token': {
      get: {
        tags: ['Fyers'],
        summary: 'Fyers access-token status (fetches via TOTP login if none cached)',
        description:
          'Current Fyers token: masked preview + expiry. Fetches and caches a token via the TOTP login chain when none is loaded — hit this first to validate the auth setup in isolation. Needs FYERS_ID/APP_ID/SECRET_KEY/TOTP_SECRET/PIN/REDIRECT_URI in .env.local.',
        responses: {
          '200': ok('{ tokenPreview, expiresAt, expiresInMinutes }'),
          '400': errorResponse('Credentials not configured'),
          '500': errorResponse('Login chain failed'),
        },
      },
      post: {
        tags: ['Fyers'],
        summary: 'Force a FRESH Fyers token (clears cache, re-runs TOTP login)',
        description:
          'Optional body { reveal?: boolean } — full token returned only when reveal is true (masked by default; it is a live credential).',
        responses: {
          '200': ok('{ tokenPreview | token, expiresAt }'),
          '500': errorResponse('Login chain failed'),
        },
      },
    },
    '/api/fyers/poller': {
      get: {
        tags: ['Fyers'],
        summary: '5-min recorder status (state, last cycle, universe, token expiry)',
        description:
          'Downloader loop status: started/paused, last cycle summary (universe size ~166, bars written, OI attached, errors), next tick. `?coverage=1` adds per-symbol bar counts for today. Also (re)starts the loop defensively.',
        parameters: [
          {
            name: 'coverage',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['1'] },
            description: 'Add per-symbol bar coverage for today',
          },
        ],
        responses: {
          '200': ok('{ started, paused, cycles, lastCycle, universe, token }'),
          '500': errorResponse('Status error'),
        },
      },
      post: {
        tags: ['Fyers'],
        summary: 'Control the recorder loop',
        description:
          "Body { action: 'pause' | 'resume' | 'run-once', date? }. run-once executes a full cycle immediately bypassing the market-hours guard; with `date` it backfills that day's candles (testing; pruned by the next regular cycle).",
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['action'],
                properties: {
                  action: {
                    type: 'string',
                    enum: ['pause', 'resume', 'run-once'],
                  },
                  date: {
                    type: 'string',
                    format: 'date',
                    description: 'Backfill target for run-once',
                  },
                },
              },
              example: { action: 'run-once' },
            },
          },
        },
        responses: {
          '200': ok('{ state }'),
          '400': errorResponse('Unknown action'),
        },
      },
    },

    // ───────────────────────── Config ─────────────────────────
    '/api/config/toggles': {
      get: {
        tags: ['Config'],
        summary: 'Runtime feature toggles + numeric settings (the /config page)',
        description:
          'Every registered switch (USE_BREAKOUT_BYPASS, SCAN_FULL_UNIVERSE, EXCLUDE_EXTENDED) and numeric setting (MAX_PICKS, 1–10) with its default, effective value and last-changed time. Stored overrides live in the feature_toggles table; config.ts constants are the defaults/fallback.',
        responses: {
          '200': ok('{ data: ToggleState[], numbers: NumberState[] }'),
          '500': errorResponse('DB error'),
        },
      },
      post: {
        tags: ['Config'],
        summary: 'Set one toggle (boolean) or numeric setting (number)',
        description:
          'Body { key, value }. Boolean value flips a registered toggle; number value sets a registered numeric setting (validated against its min/max). Unknown keys are rejected — the registries in lib/config/feature-toggles.ts are the allowlist. Takes effect on the next scan.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['key', 'value'],
                properties: {
                  key: { type: 'string' },
                  value: { oneOf: [{ type: 'boolean' }, { type: 'number' }] },
                },
              },
              example: { key: 'MAX_PICKS', value: 7 },
            },
          },
        },
        responses: {
          '200': ok('{ data, numbers } (fresh lists)'),
          '400': errorResponse('Unknown key / bad value'),
        },
      },
    },

    // ───────────────────────── NSE (official data) ─────────────────────────
    '/api/nse/heatmap': {
      get: {
        tags: ['NSE'],
        summary: 'Official NSE indices (139) + market status for the /nse/heatmap page',
        description:
          'All NSE indices (sectoral, broad-market, derivatives-eligible) with % change vs previous close, advances/declines — the OFFICIAL free-float index numbers (includes the overnight gap, unlike /api/heatmap which is since-open F&O-universe derived). Sequential upstream calls, 60s cache, serves last-good payload flagged stale on NSE failure.',
        responses: {
          '200': ok('{ asOf, count, indices, marketStatus, stale }'),
          '502': errorResponse('NSE unreachable and no cached payload'),
        },
      },
    },
    '/api/nse/pulse/{feed}': {
      get: {
        tags: ['NSE'],
        summary: 'One NSE market-pulse feed (oiSpurts, gainers, losers, activeValue, activeVolume, …)',
        description:
          'A single NSE pulse list fetched independently — one upstream call per feed through a 30s shared in-process cache (same data the /nse/movers page and the trade-suggest candidate builder use). On failure serves the last good value flagged stale, else 502. Never fabricates.',
        parameters: [
          {
            name: 'feed',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Feed key (e.g. oiSpurts, gainers, losers, activeValue, activeVolume, week52High)',
          },
        ],
        responses: {
          '200': ok('{ data, asOf, stale }'),
          '400': errorResponse('Unknown feed'),
          '502': errorResponse('NSE unreachable, nothing cached'),
        },
      },
    },
    '/api/nse/movers-history': {
      get: {
        tags: ['NSE'],
        summary: 'EOD movers reconstructed from synced bhavcopy (pure DB read)',
        description:
          'Per-stock close-to-close stats for a session: pctChange, turnover, volume, and oiPct = day-over-day TOTAL derivatives OI change (futures+options, counted in CONTRACTS — the same basis as NSE’s live OI-spurts). ?dates=true lists available sessions. No NSE/Dhan calls.',
        parameters: [
          {
            name: 'dates',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['true'] },
            description: 'List available session dates instead',
          },
          {
            name: 'date',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'date' },
            description: 'Session to reconstruct (defaults to latest)',
          },
        ],
        responses: {
          '200': ok('{ date, rows } | { dates }'),
          '400': errorResponse('Bhavcopy not synced for the date'),
        },
      },
    },
    '/api/nse/oi-audit': {
      get: {
        tags: ['NSE'],
        summary: 'Data-integrity check: our EOD OI% vs NSE’s live oi-spurts feed',
        description:
          'Per F&O stock, compares day-over-day OI% reconstructed from the last two synced bhavcopy sessions (contracts basis) against NSE’s live feed. Rows over ?threshold (default 5 pct-points) are flagged — usually an NSE live-feed quirk, not local corruption (verified precedent: TECHM 2026-07-02→03).',
        parameters: [
          {
            name: 'threshold',
            in: 'query',
            required: false,
            schema: { type: 'integer', default: 5 },
            description: 'Flag |ours − NSE| above this many points',
          },
        ],
        responses: {
          '200': ok('{ compared, flagged, rows }'),
          '400': errorResponse('Need 2 synced bhavcopy sessions'),
        },
      },
    },

    // ───────────────────────── Heatmap ─────────────────────────
    '/api/heatmap': {
      get: {
        tags: ['Heatmap'],
        summary: 'F&O sector treemap (live or EOD)',
        description:
          'Live Dhan quotes during market hours, else last two NSE bhavcopy sessions. Tile size = traded value, color = % change.',
        responses: {
          '200': ok('{ source, tiles, sectors }'),
          '400': errorResponse('Need 2 synced bhavcopy sessions'),
          '500': errorResponse('Heatmap error'),
        },
      },
    },
    '/api/heatmap/cross-check': {
      get: {
        tags: ['Heatmap'],
        summary: 'Cross-check sector moves vs official NSE indices',
        responses: {
          '200': ok('{ sectors, composition, … }'),
          '400': errorResponse('Need 2 synced bhavcopy sessions'),
          '500': errorResponse('Cross-check error'),
        },
      },
    },

    // ───────────────────────── AI Assistant ─────────────────────────
    '/api/ai-assistant/chat': {
      post: {
        tags: ['AI Assistant'],
        summary: 'Chat with the trade assistant',
        description:
          'Azure OpenAI Responses API with function calling. Returns a friendly reply even on error / when unconfigured.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['message'],
                properties: {
                  message: { type: 'string', maxLength: 2000 },
                  history: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        role: { type: 'string', enum: ['user', 'assistant'] },
                        content: { type: 'string' },
                      },
                    },
                  },
                },
              },
              example: {
                message: 'Which F&O stocks have the highest OI build today?',
                history: [],
              },
            },
          },
        },
        responses: {
          '200': ok('{ reply, toolTrace }'),
          '400': errorResponse('Empty / too-long message'),
          '500': errorResponse('Model error (still returns a reply)'),
        },
      },
    },

    // ───────────────────────── Dhan Auth ─────────────────────────
    '/api/dhan/token': {
      get: {
        tags: ['Dhan Auth'],
        summary: 'Current Dhan access-token status',
        description:
          'Returns whether Dhan auth is configured plus the active token preview (masked) and expiry. Does NOT regenerate.',
        responses: {
          '200': ok('{ configured, tokenPreview, expiresAt, expiresInMinutes }'),
          '400': errorResponse('No Dhan credentials configured'),
          '502': errorResponse('Token fetch failed'),
        },
      },
      post: {
        tags: ['Dhan Auth'],
        summary: 'Force-regenerate the Dhan access token',
        description:
          'Clears the in-memory + disk cache, then regenerates a fresh token via TOTP (renew / static fallback as configured). Dhan rate-limits this to ~once per 2 minutes.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  reveal: {
                    type: 'boolean',
                    default: false,
                    description: 'Return the full token (a live credential — masked by default).',
                  },
                },
              },
              example: { reveal: false },
            },
          },
        },
        responses: {
          '200': ok('{ regenerated: true, tokenPreview, expiresAt, expiresInMinutes, token? }'),
          '400': errorResponse('No Dhan credentials configured'),
          '502': errorResponse('Token generation failed'),
        },
      },
    },
  },
  components: {
    schemas: {
      SimulatorConfig: {
        type: 'object',
        description: 'Partial accepted — unset fields fall back to DEFAULT_SIMULATOR_CONFIG.',
        properties: {
          symbol: { type: 'string', example: 'RELIANCE' },
          instrumentKind: {
            type: 'string',
            enum: ['EQUITY', 'FUTSTK', 'OPTSTK'],
            example: 'FUTSTK',
          },
          segment: { type: 'string', example: 'NSE_FNO' },
          securityId: { type: 'string' },
          lotSize: { type: 'integer', example: 1 },
          fromDate: { type: 'string', format: 'date', example: '2026-01-01' },
          toDate: { type: 'string', format: 'date', example: '2026-01-31' },
          interval: {
            type: 'string',
            example: '5',
            description: 'Candle granularity in minutes',
          },
          speed: { type: 'number', example: 1 },
          baseTickMs: { type: 'integer', example: 700 },
          ticksPerCandle: { type: 'integer', example: 1 },
          startPaused: { type: 'boolean', example: true },
          loop: { type: 'boolean', example: false },
          seed: { type: 'integer', example: 1337 },
        },
      },
    },
  },
} as const;

export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  return NextResponse.json(spec);
}
