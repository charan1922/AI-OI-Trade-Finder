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

interface TimelineLike {
  steps: { detail?: string }[];
}

/**
 * Cycle timelines are viewer-readable, but a step's `detail` is free text built
 * from engine results — and the position-guard step joins its action lines, which
 * name the held contract, its strike/side, premiums, R levels and exit reasons
 * (position-guard.ts). Redacting the commentary cards while shipping the same
 * facts in a timeline tooltip would leave the hole open, so viewers keep every
 * step name, timing and ok/fail flag (the operational value) and lose `detail`.
 */
export function timelinesForRole<T extends TimelineLike>(timelines: readonly T[], viewer: boolean): T[] {
  if (!viewer) return [...timelines];
  return timelines.map((timeline) => ({
    ...timeline,
    steps: timeline.steps.map((step) => {
      const redacted = { ...step };
      delete redacted.detail;
      return redacted;
    }),
  }));
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
