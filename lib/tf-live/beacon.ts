/**
 * TF breakout beacons for one session, read from the stored market_pulse
 * captures. FAIL CLOSED: no capture → an empty map → every name fails the
 * selector's beacon check (operator, 2026-10-08: our ORB AND TF's beacon).
 */
import { parseBeacons, type TfBeacon } from '@/lib/tf-live/parse';
import { getTfLiveCaptureForDate } from '@/lib/tf-live/store';

/** Beacons from the last market_pulse capture on `date` (IST) at or before `atOrBeforeIso`. */
export async function getTfBeaconsAt(date: string, atOrBeforeIso?: string): Promise<Map<string, TfBeacon>> {
  const capture = await getTfLiveCaptureForDate('market_pulse', date, atOrBeforeIso);
  return capture ? parseBeacons(capture.payload) : new Map();
}
