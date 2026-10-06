/** Fyers' public JSON master: use exchange tokens, never truncated fyTokens. */
export interface FyersMasterEntry {
  securityId: string;
  symbol: string;
  exchange: string;
  segment: string;
  instrument: string;
  name: string;
  underlying: string | null;
  expiryDate: Date | null;
  lotSize: number;
  strikePrice: number | null;
  optionType: string | null;
  syncDate: string;
  fyersSymbol: string;
}

export function parseFyersMaster(raw: unknown, today: string): FyersMasterEntry[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Fyers symbol master');
  const out: FyersMasterEntry[] = [];
  const instruments: Record<number, string> = { 0: 'EQUITY', 10: 'FUTSTK', 11: 'FUTIDX', 14: 'OPTIDX', 15: 'OPTSTK' };
  for (const [fyersSymbol, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const instrument = instruments[Number(v.exInstType)];
    if (!fyersSymbol.startsWith('NSE:') || !instrument) continue;
    if (instrument === 'EQUITY' && v.exSeries !== 'EQ') continue;
    const securityId = String(v.exToken);
    const underlying = String(v.underSym ?? v.exSymbol ?? '');
    const lotSize = Number(v.minLotSize);
    if (!/^\d+$/.test(securityId) || Number(securityId) <= 0 || !underlying || !(lotSize > 0)) {
      throw new Error(`Invalid Fyers contract ${fyersSymbol}`);
    }
    const expiryDate = instrument === 'EQUITY' ? null : new Date(Number(v.expiryDate) * 1000);
    if (expiryDate && !Number.isFinite(expiryDate.getTime())) throw new Error(`Invalid expiry for ${fyersSymbol}`);
    const optionType = instrument.startsWith('OPT') ? String(v.optType) : null;
    const strikePrice = optionType ? Number(v.strikePrice) : null;
    if (optionType && (!['CE', 'PE'].includes(optionType) || !(strikePrice! > 0))) throw new Error(`Invalid option ${fyersSymbol}`);
    out.push({
      securityId, symbol: instrument === 'EQUITY' ? underlying : fyersSymbol,
      exchange: 'NSE', segment: instrument === 'EQUITY' ? 'NSE_EQ' : 'NSE_FNO',
      instrument, name: String(v.exSymName ?? fyersSymbol),
      underlying: instrument === 'EQUITY' ? null : underlying,
      expiryDate, lotSize, strikePrice, optionType, syncDate: today, fyersSymbol,
    });
  }
  return out;
}

export async function fetchFyersMaster(today: string) {
  const entries: FyersMasterEntry[] = [];
  const texts: string[] = [];
  for (const segment of ['NSE_CM', 'NSE_FO']) {
    const response = await fetch(`https://public.fyers.in/sym_details/${segment}_sym_master.json`, {
      signal: AbortSignal.timeout(30_000), cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Fyers ${segment} master HTTP ${response.status}`);
    const text = await response.text();
    texts.push(text);
    entries.push(...parseFyersMaster(JSON.parse(text), today));
  }
  return { entries, text: texts.join('\n') };
}
