import { NextResponse } from 'next/server';

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
        properties: { success: { type: 'boolean', example: false }, error: { type: 'string' } },
      },
    },
  },
});

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Project-R Simulator API',
    version: '0.0.1',
    description:
      'Internal HTTP API for the Project-R market simulator: replay engine, backtesting, NSE bhavcopy sync, live urgency, sector heatmap, and the AI trade assistant. All routes are `force-dynamic`. Most return `{ success, data }` on success and `{ success: false, error }` on failure.',
  },
  servers: [{ url: '/', description: 'This server' }],
  tags: [
    { name: 'Simulator', description: 'Replay engine: load a dataset, drive playback, stream ticks.' },
    { name: 'Backtest', description: 'Signal scan + vectorbt backtest over TradeFinder trades.' },
    { name: 'Market Data', description: 'NSE bhavcopy sync, trading calendar, F&O lot sizes.' },
    { name: 'Live', description: 'Real-time urgency, intraday OI series, dynamic sector watchlist.' },
    { name: 'Heatmap', description: 'F&O sector treemap + cross-check vs official NSE indices.' },
    { name: 'AI Assistant', description: 'Azure OpenAI trade assistant with function calling.' },
    { name: 'Dhan Auth', description: 'Dhan access-token status + TOTP regeneration.' },
  ],
  paths: {
    // ───────────────────────── Simulator ─────────────────────────
    '/api/simulator/control': {
      get: {
        tags: ['Simulator'],
        summary: 'Current replay engine status',
        responses: { '200': ok('Engine status (loaded dataset, position, play state, speed).') },
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
                  candleIndex: { type: 'integer', description: 'For action=seek' },
                  time: { type: 'integer', description: 'For action=seekTime (epoch seconds)' },
                  speed: { type: 'number', description: 'For action=speed (multiplier)' },
                },
              },
              examples: {
                load: { value: { action: 'load', config: { symbol: 'RELIANCE', instrumentKind: 'FUTSTK', fromDate: '2026-01-01', toDate: '2026-01-31', interval: '5' } } },
                play: { value: { action: 'play' } },
                seek: { value: { action: 'seek', candleIndex: 42 } },
                speed: { value: { action: 'speed', speed: 4 } },
              },
            },
          },
        },
        responses: { '200': ok('Updated engine status'), '400': errorResponse('Invalid JSON / unknown action'), '500': errorResponse('Engine error') },
      },
    },
    '/api/simulator/search': {
      get: {
        tags: ['Simulator'],
        summary: 'Symbol suggestions for the picker',
        parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Search query, e.g. "REL"' }],
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
        description: 'Fetches exact intraday candles (with OI for F&O) for a symbol + date window, caches them, and registers the dataset.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SimulatorConfig' },
              example: { symbol: 'RELIANCE', instrumentKind: 'FUTSTK', fromDate: '2026-01-01', toDate: '2026-01-31', interval: '5' },
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
        description: 'Server-Sent Events mirroring the live Dhan feed contract. Connect with EventSource — not testable via "Try it out".',
        responses: {
          '200': { description: 'text/event-stream of tick events + heartbeats', content: { 'text/event-stream': { schema: { type: 'string' } } } },
        },
      },
    },

    // ───────────────────────── Backtest ─────────────────────────
    '/api/backtest/run': {
      post: {
        tags: ['Backtest'],
        summary: 'Run the vectorbt backtest',
        description: 'Prepares per-trade signal copies, runs the Python vectorbt engine, persists results, returns per-trade rows + summary.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  gateBasis: { type: 'string', enum: ['optOi', 'score'], default: 'optOi' },
                  gateThreshold: { type: 'number', description: 'Default 1.1 (optOi) or 4 (score)' },
                  profitTarget: { type: 'number', default: 5000 },
                  download: { type: 'boolean', default: false },
                },
              },
              example: { gateBasis: 'optOi', gateThreshold: 1.1, profitTarget: 5000, download: false },
            },
          },
        },
        responses: { '200': ok('{ runId, results, summary, prep }'), '500': errorResponse('Prepare or engine error') },
      },
    },
    '/api/backtest/download-stream': {
      post: {
        tags: ['Backtest'],
        summary: 'Stream per-symbol download progress (SSE)',
        description: 'Downloads equity/futures/option 5-min data + bhavcopy for a list of trades, emitting SSE progress events.',
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
              example: { symbols: [{ symbol: 'RELIANCE', optionType: 'CE', strike: 1300, date: '2026-03-20', spotPrice: 1295 }] },
            },
          },
        },
        responses: {
          '200': { description: 'text/event-stream of progress/error/complete events', content: { 'text/event-stream': { schema: { type: 'string' } } } },
          '400': errorResponse('No symbols provided'),
        },
      },
    },
    '/api/backtest/tf-validate': {
      get: {
        tags: ['Backtest'],
        summary: 'TF-validation data status',
        responses: { '200': ok('Row counts + TF trades'), '500': errorResponse('Status error') },
      },
      post: {
        tags: ['Backtest'],
        summary: 'TF-validation actions (download / backtest / detail …)',
        description: 'Action-dispatched. Each action takes its own fields (e.g. trade-detail needs symbol/date/optionType/strike).',
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
                      'status', 'download', 'backtest', 'all-tf-trades', 'symbol-status',
                      'download-symbols', 'download-all-tf', 'trade-detail', 'trade-context',
                      'simulate', 'tf-trades-list', 'debug',
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
                tradeDetail: { value: { action: 'trade-detail', symbol: 'RELIANCE', date: '2026-03-20', optionType: 'CE', strike: 1300 } },
              },
            },
          },
        },
        responses: { '200': ok('Action-specific payload'), '400': errorResponse('Unknown action / no symbols'), '500': errorResponse('Action error') },
      },
    },

    // ───────────────────────── Market Data ─────────────────────────
    '/api/bhavcopy': {
      get: {
        tags: ['Market Data'],
        summary: 'Bhavcopy coverage status',
        responses: { '200': ok('Coverage status of bhavcopy_days'), '500': errorResponse('Status error') },
      },
      post: {
        tags: ['Market Data'],
        summary: 'Sync missing trading days from NSE',
        description: 'User-triggered. When `days` is omitted the window auto-covers every downloaded trade.',
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { days: { type: 'integer', description: 'Lookback in weekdays (optional)' } } },
              example: { days: 25 },
            },
          },
        },
        responses: { '200': ok('Sync result + status'), '500': errorResponse('Sync error') },
      },
    },
    '/api/market-calendar': {
      get: {
        tags: ['Market Data'],
        summary: 'NSE trading-holiday calendar',
        responses: { '200': ok('Holidays, data-derived closures, special sessions'), '500': errorResponse('Calendar error') },
      },
    },
    '/api/fno-lots': {
      get: {
        tags: ['Market Data'],
        summary: 'F&O lot sizes (Jun/Jul/Aug) per symbol',
        responses: { '200': ok('[{ name, symbol, lotJun, lotJul, lotAug, sector }]'), '500': errorResponse('CSV read error') },
      },
    },

    // ───────────────────────── Live ─────────────────────────
    '/api/live/quote': {
      post: {
        tags: ['Live'],
        summary: 'Live urgency rows for a watchlist',
        description: 'Real-time bid/ask spread, order-book imbalance, futures OI level + turnover. Off-hours returns marketOpen:false and no rows. Max 25 symbols.',
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' }, maxItems: 25 } } },
              example: { symbols: ['RELIANCE', 'TCS', 'INFY'] },
            },
          },
        },
        responses: { '200': ok('{ marketOpen, rows, symbols }'), '500': errorResponse('Quote error') },
      },
    },
    '/api/live/oi-series': {
      get: {
        tags: ['Live'],
        summary: 'Intraday futures-OI series for one symbol',
        parameters: [
          { name: 'symbol', in: 'query', required: true, schema: { type: 'string' }, example: 'RELIANCE' },
          { name: 'date', in: 'query', required: false, schema: { type: 'string', format: 'date' }, description: 'Defaults to today (IST)' },
        ],
        responses: { '200': ok('{ symbol, date, series, urgency }'), '400': errorResponse('symbol required'), '500': errorResponse('Series error') },
      },
    },
    '/api/live/sector-leaders': {
      get: {
        tags: ['Live'],
        summary: 'Dynamic sector-leader watchlist from bhavcopy',
        parameters: [
          { name: 'basis', in: 'query', required: false, schema: { type: 'string', enum: ['gainers', 'losers', 'movers'], default: 'gainers' } },
          { name: 'perSector', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 4, default: 2 } },
        ],
        responses: { '200': ok('{ picks, meta }'), '400': errorResponse('Not enough bhavcopy sessions'), '500': errorResponse('Ranking error') },
      },
    },

    // ───────────────────────── Heatmap ─────────────────────────
    '/api/heatmap': {
      get: {
        tags: ['Heatmap'],
        summary: 'F&O sector treemap (live or EOD)',
        description: 'Live Dhan quotes during market hours, else last two NSE bhavcopy sessions. Tile size = traded value, color = % change.',
        responses: { '200': ok('{ source, tiles, sectors }'), '400': errorResponse('Need 2 synced bhavcopy sessions'), '500': errorResponse('Heatmap error') },
      },
    },
    '/api/heatmap/cross-check': {
      get: {
        tags: ['Heatmap'],
        summary: 'Cross-check sector moves vs official NSE indices',
        responses: { '200': ok('{ sectors, composition, … }'), '400': errorResponse('Need 2 synced bhavcopy sessions'), '500': errorResponse('Cross-check error') },
      },
    },

    // ───────────────────────── AI Assistant ─────────────────────────
    '/api/ai-assistant/chat': {
      post: {
        tags: ['AI Assistant'],
        summary: 'Chat with the trade assistant',
        description: 'Azure OpenAI Responses API with function calling. Returns a friendly reply even on error / when unconfigured.',
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
                    items: { type: 'object', properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: { type: 'string' } } },
                  },
                },
              },
              example: { message: 'Which F&O stocks have the highest OI build today?', history: [] },
            },
          },
        },
        responses: { '200': ok('{ reply, toolTrace }'), '400': errorResponse('Empty / too-long message'), '500': errorResponse('Model error (still returns a reply)') },
      },
    },

    // ───────────────────────── Dhan Auth ─────────────────────────
    '/api/dhan/token': {
      get: {
        tags: ['Dhan Auth'],
        summary: 'Current Dhan access-token status',
        description: 'Returns whether Dhan auth is configured plus the active token preview (masked) and expiry. Does NOT regenerate.',
        responses: {
          '200': ok('{ configured, tokenPreview, expiresAt, expiresInMinutes }'),
          '400': errorResponse('No Dhan credentials configured'),
          '502': errorResponse('Token fetch failed'),
        },
      },
      post: {
        tags: ['Dhan Auth'],
        summary: 'Force-regenerate the Dhan access token',
        description: 'Clears the in-memory + disk cache, then regenerates a fresh token via TOTP (renew / static fallback as configured). Dhan rate-limits this to ~once per 2 minutes.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  reveal: { type: 'boolean', default: false, description: 'Return the full token (a live credential — masked by default).' },
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
          instrumentKind: { type: 'string', enum: ['EQUITY', 'FUTSTK', 'OPTSTK'], example: 'FUTSTK' },
          segment: { type: 'string', example: 'NSE_FNO' },
          securityId: { type: 'string' },
          lotSize: { type: 'integer', example: 1 },
          fromDate: { type: 'string', format: 'date', example: '2026-01-01' },
          toDate: { type: 'string', format: 'date', example: '2026-01-31' },
          interval: { type: 'string', example: '5', description: 'Candle granularity in minutes' },
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

export async function GET() {
  return NextResponse.json(spec);
}
