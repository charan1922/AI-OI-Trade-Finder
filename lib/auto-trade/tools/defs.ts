/**
 * Function-calling tool schemas for the auto-trader — provider-NEUTRAL shape
 * (name/description/parameters), mapped to the Azure Responses format and the
 * MiMo chat.completions format by decision/providers.ts.
 *
 * The descriptions are contract language the model reads — they state the
 * hard rules up front (1 lot, scanner picks only, gates are final) so a
 * rejection never surprises it into retry loops.
 */

export interface NeutralToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };

export const AUTO_TRADE_TOOLS: NeutralToolDef[] = [
  {
    name: 'get_scan_picks',
    description:
      "This cycle's deterministic scanner output — the ONLY names you may enter. Each pick carries the " +
      'full plan (entry/SL/target spot, near-ATM contract, live premium, per-lot cost) plus the evidence ' +
      '(R-Factor, OI, breakout verdict, trend alignment, sector). Picks with eligible:false cannot be ' +
      'entered (no contract/premium) — do not try.',
    parameters: NO_ARGS,
  },
  {
    name: 'get_tf_race',
    description:
      "TradeFinder's OWN R-Factor leaderboard for today — a second, independent pipeline scoring the " +
      'same market. Returns their current board (rank + their R-Factor), plus the 09:45–11:00 "running ' +
      'race": which names have CLIMBED their board since the entry window opened, and which appeared on ' +
      'it mid-window. Use it to corroborate a scanner pick you are already considering: agreement across ' +
      'two independent pipelines is real evidence. It is NOT a source of trade ideas — you may only ever ' +
      'enter names from get_scan_picks. available:false means TradeFinder data is MISSING today (their ' +
      'session token lapsed); that is absence of evidence, never confirmation, and never a reason to ' +
      'skip a pick that is otherwise clean. hasRace:false means fewer than two captures landed inside ' +
      'the window, so no trajectory can be computed — read it as unknown, not as "nobody is climbing". ' +
      'Check ageMinutes: a board an hour old describes an hour-old market.',
    parameters: NO_ARGS,
  },
  {
    name: 'get_account_state',
    description:
      'Refresh the account state already preloaded in the first message: mode, kill switch, entries used ' +
      'today vs max, open lots vs max, deployed premium vs budget, realized P&L vs loss halt, entry ' +
      'window, pending approvals, and broker funds. Call only when a later refresh is needed.',
    parameters: NO_ARGS,
  },
  {
    name: 'get_quote',
    description:
      'Fresh live read for one symbol: option premium (bid/ask/LTP/spread) of its pick or open-position ' +
      'contract, plus the latest 5-min spot close. Use before entering or exiting to ground the decision ' +
      'in current prices.',
    parameters: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'NSE underlying, e.g. "RELIANCE".',
        },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_order',
    description:
      'DRY-RUN the hard entry gates for a scanner pick (window, caps, capital, slippage, duplicate, ' +
      'funds) without placing anything. Returns allow:true/false with every failed gate listed. Call ' +
      'this before place_entry_order; if it rejects, the answer is final for this pass — do NOT retry ' +
      'with different wording.',
    parameters: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Symbol of a pick from get_scan_picks.',
        },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'place_entry_order',
    description:
      'Enter ONE LOT of the near-ATM option chosen by the scanner for this pick (you cannot pick strike ' +
      'or size). Every hard gate re-runs here in code; a rejection is final. In approval mode this queues ' +
      'the order for the human instead of placing it. Give the one-sentence reason a trader would accept.',
    parameters: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Symbol of an eligible pick from get_scan_picks.',
        },
        reason: {
          type: 'string',
          description: 'One sentence: why this entry, now.',
        },
      },
      required: ['symbol', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_open_positions',
    description:
      'Refresh the open positions already preloaded in the first message, including live premium, latest ' +
      'spot, points from entry, and stop/target levels. Use only when a later refresh is decision-relevant.',
    parameters: NO_ARGS,
  },
  {
    name: 'modify_stop',
    description:
      'TIGHTEN the spot stop of an open position (bullish: only upward, bearish: only downward — loosening ' +
      'is rejected in code). Use after real progress to reduce spot risk. A spot stop at the entry spot ' +
      'does not guarantee option-premium breakeven or a scratch fill.',
    parameters: {
      type: 'object',
      properties: {
        tradeId: { type: 'number', description: 'id from get_open_positions.' },
        newSlSpot: { type: 'number', description: 'New spot stop level.' },
        reason: {
          type: 'string',
          description: 'One sentence: why the stop moves.',
        },
      },
      required: ['tradeId', 'newSlSpot', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'exit_position',
    description:
      'Close an open position at market, NOW. Use when the thesis is broken (breakout base lost, OI flow ' +
      'flipped, trend gone), when momentum near the target is fading, or any time you judge the risk no ' +
      'longer pays. The premium stop / target / 15:12 square-off fire automatically without you — your ' +
      'job is exiting EARLIER when the data says so. Exiting is FINAL for the day for that name.',
    parameters: {
      type: 'object',
      properties: {
        tradeId: { type: 'number', description: 'id from get_open_positions.' },
        reason: { type: 'string', description: 'One sentence: why out, now.' },
      },
      required: ['tradeId', 'reason'],
      additionalProperties: false,
    },
  },
];

/** Once no entry is possible this pass, do not keep paying to describe entry
 * tools the model cannot use. The final decision text is already the durable
 * audit record, so a separate record_note round trip is intentionally absent. */
const MANAGEMENT_TOOL_NAMES = new Set([
  'get_quote',
  'get_open_positions',
  'modify_stop',
  'exit_position',
  // Kept on management passes on purpose: a HELD name sliding down
  // TradeFinder's board is corroborating evidence for an EARLY EXIT, which is
  // the one place the AI adds value over the deterministic backstops.
  'get_tf_race',
]);
export const AUTO_TRADE_MANAGEMENT_TOOLS = AUTO_TRADE_TOOLS.filter((tool) => MANAGEMENT_TOOL_NAMES.has(tool.name));
