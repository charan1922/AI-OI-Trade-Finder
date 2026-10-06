/**
 * Broker factory — resolves the execution venue from the runtime settings.
 * paper/approval modes always execute on the paper venue until an order is
 * APPROVED (approval-mode orders, once approved, go to the real broker);
 * live mode goes straight to the configured broker.
 */

import type { AutoTradeSettings } from '../types';
import type { BrokerAdapter } from './adapter';
import { FyersAdapter } from './fyers-adapter';
import { PaperAdapter } from './paper-adapter';

const paper = new PaperAdapter();
const fyers = new FyersAdapter();

/** The venue for a NEW order given the mode it was created under. */
export function getExecutionAdapter(settings: AutoTradeSettings, mode: AutoTradeSettings['mode']): BrokerAdapter {
  if (mode === 'paper') return paper;
  return fyers;
}

/** Dhan execution is disabled; its adapter source remains in the repository. */
export function getAdapterById(id: string): BrokerAdapter {
  if (id === 'paper') return paper;
  if (id === 'dhan') throw new Error('Dhan execution is disabled; no existing Dhan positions were retained');
  return fyers;
}
