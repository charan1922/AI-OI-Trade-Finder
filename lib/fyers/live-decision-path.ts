/**
 * The latency-critical capture sequence after priority candles are refreshed.
 * All shadow work is injected through `afterDecision`, which cannot run until
 * both the scan and deterministic/Auto Trade decision have completed.
 */
export async function runLiveDecisionPath<TScan, TDecision>(hooks: {
  scan: () => Promise<TScan>;
  decide: (scan: TScan) => Promise<TDecision>;
  afterDecision: (scan: TScan, decision: TDecision) => void | Promise<void>;
}): Promise<{ scan: TScan; decision: TDecision }> {
  const scan = await hooks.scan();
  const decision = await hooks.decide(scan);
  await hooks.afterDecision(scan, decision);
  return { scan, decision };
}
