/** Active provider. Dhan source remains in the repository but is inactive. */
export const MARKET_DATA_PROVIDER = 'fyers' as const;
export const DHAN_RETIRED_MESSAGE = 'Dhan is inactive. Use Fyers for market data and new trades.';

export function fyersDataLimits() {
  const prime = process.env.FYERS_API_PLAN?.trim().toLowerCase() === 'prime';
  return { perSecond: prime ? 10 : 5, perMinute: prime ? 500 : 50, perDay: prime ? 500_000 : 5_000 };
}
