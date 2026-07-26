/** Response-only redaction for viewer-readable trading pages. Internal engine
 * objects remain unchanged so position management keeps its full evidence. */

export function tradeSuggestForRole<T extends { managedPositionSignals?: unknown }>(result: T, viewer: boolean): T {
  if (!viewer) return result;
  const publicResult = { ...result };
  delete publicResult.managedPositionSignals;
  return publicResult;
}

interface CommentaryLike {
  promptKey?: string | null;
  text: string;
  picks: unknown[];
  picksCount: number;
}

export function commentaryForRole<T extends CommentaryLike>(rows: readonly T[], viewer: boolean): T[] {
  if (!viewer) return [...rows];
  return rows.map((row) =>
    row.promptKey === 'auto-trader'
      ? ({
          ...row,
          text: 'Position-management commentary is available to the operator only.',
          picks: [],
          picksCount: 0,
        } as T)
      : row
  );
}
