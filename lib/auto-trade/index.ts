/**
 * Auto-trade module — AI-driven execution over the deterministic scanner.
 * Public surface for the rest of the app; see engine.ts for the flow and
 * README-level docs in each file's header.
 */

export { runAutoTradePass, type AutoTradePassOutcome } from './engine';
export { getAutoTradeSettings, setAutoTradeSetting, SETTING_DEFS } from './settings';
export { approveTrade, rejectTrade } from './approval';
export type { AutoTrade, AutoTradeSettings, TradeMode, BrokerId, AiProvider, ProfitTargetMode } from './types';
