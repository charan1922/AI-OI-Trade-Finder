/**
 * Broker factory — resolves the execution venue from the runtime settings.
 * paper/approval modes always execute on the paper venue until an order is
 * APPROVED (approval-mode orders, once approved, go to the real broker);
 * live mode goes straight to the configured broker.
 */

import type { AutoTradeSettings } from '../types';
import type { BrokerAdapter } from './adapter';
import { DhanAdapter } from './dhan-adapter';
import { FyersAdapter } from './fyers-adapter';
import { PaperAdapter } from './paper-adapter';

const paper = new PaperAdapter();
const fyers = new FyersAdapter();
const dhan = new DhanAdapter();

/** The venue for a NEW order given the mode it was created under. */
export function getExecutionAdapter(settings: AutoTradeSettings, mode: AutoTradeSettings['mode']): BrokerAdapter {
  if (mode === 'paper') return paper;
  return settings.broker === 'dhan' ? dhan : fyers;
}

/** The venue a specific existing trade lives on (exits must go to the same
 *  venue the entry filled on, even if settings changed mid-day). */
export function getAdapterById(id: string): BrokerAdapter {
  if (id === 'paper') return paper;
  if (id === 'dhan') return dhan;
  return fyers;
}
