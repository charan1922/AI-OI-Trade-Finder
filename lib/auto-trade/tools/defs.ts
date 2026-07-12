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
    name: 'get_account_state',
    description:
      'Current caps and exposure: mode, kill switch, entries used today vs max, open lots vs max, premium ' +
      '₹ deployed vs budget, realized P&L today vs the daily loss halt, entry-window state, pending ' +
      'approvals, broker funds. ALWAYS call this first each pass.',
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
      properties: { symbol: { type: 'string', description: 'NSE underlying, e.g. "RELIANCE".' } },
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
      properties: { symbol: { type: 'string', description: 'Symbol of a pick from get_scan_picks.' } },
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
        symbol: { type: 'string', description: 'Symbol of an eligible pick from get_scan_picks.' },
        reason: { type: 'string', description: 'One sentence: why this entry, now.' },
      },
      required: ['symbol', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_open_positions',
    description:
      'Every open auto-trade position with live premium, latest spot, points from entry, and the current ' +
      'stop/target levels (spot plan + premium backstops). Manage these BEFORE considering any new entry.',
    parameters: NO_ARGS,
  },
  {
    name: 'modify_stop',
    description:
      'TIGHTEN the spot stop of an open position (bullish: only upward, bearish: only downward — loosening ' +
      'is rejected in code). Use after real progress to protect gains, e.g. move to breakeven after +1R.',
    parameters: {
      type: 'object',
      properties: {
        tradeId: { type: 'number', description: 'id from get_open_positions.' },
        newSlSpot: { type: 'number', description: 'New spot stop level.' },
        reason: { type: 'string', description: 'One sentence: why the stop moves.' },
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
  {
    name: 'record_note',
    description:
      'Log a short reasoning note to the audit trail when you deliberately do NOTHING (no entry clears ' +
      'the bar, holding through noise). Keeps the decision record complete.',
    parameters: {
      type: 'object',
      properties: { note: { type: 'string', description: 'One or two sentences.' } },
      required: ['note'],
      additionalProperties: false,
    },
  },
];
