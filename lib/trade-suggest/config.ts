/**
 * /trade-suggest strategy constants — every tunable in one place.
 *
 * Grounding (see .claude/skills/trade-suggest/SKILL.md for the full story):
 * - TradeFinder's real tickets (data/tradefinder_platform_trades.json): near-ATM
 *   stock options, entries cluster 10:00–10:40, current-month expiry.
 * - Documented TF-pick fingerprint: futures OI ≈1.25–1.35× the 20-day average
 *   (gate at 1.1×), turnover ≥1.2× average, futures direction agreeing with the
 *   option side, entries only after the 9:45 opening range is set.
 * - Standard intraday conventions: near-ATM for momentum buying (delta ~0.5,
 *   best liquidity); opening-range breakout with last-candle/range SL; 1:2 R:R.
 */

import { rFactorAtRaw } from '@/lib/r-factor/scale';

/** Suggestion window (IST minutes from midnight): 09:40 – 11:00. */
export const WINDOW_START_MIN = 9 * 60 + 40;
export const WINDOW_END_MIN = 11 * 60;
export const WINDOW_LABEL = { opensAt: '09:40 IST', closesAt: '11:00 IST' };

/** When true, scans run any time the market is open — the 09:40–11:00 window
 *  becomes advisory instead of a gate. OFF by default: entries outside the
 *  window are unproven for this strategy (TF's real tickets cluster
 *  10:00–10:40), and out-of-window picks persist into trade_suggestions and
 *  dilute the scorecard stats. Runtime-flippable from /config. */
export const SCAN_OUTSIDE_WINDOW = false;

/** Hard gates — a candidate must clear ALL of these. */
// raw 0.375 of the R-Factor span, unchanged since it was 2.5 on 1–5 and 3.6
// on 1–8. Stated via rFactorAtRaw so a future rescale cannot silently move
// the gate: the bare number 3.6 would mean raw 0.289 on today's 1–10 span.
export const MIN_RFACTOR = rFactorAtRaw(0.375);
export const MIN_CONFIDENCE = 0.2; // directional-factor agreement [0,1]
export const MIN_OI_LEVEL = 1.1; // futures OI ÷ 20d avg — the TF minimum fingerprint
/**
 * Alternate OI-evidence path: NSE's combined (futures + options) OI change.
 * Options-led builds don't register in futures-only OI level — seen live
 * 2026-07-03: SUNPHARMA futures 0.90× avg but NSE combined +8.1%, and TF's
 * winning trade that day was the SUNPHARMA 1920 CE. The gate passes on
 * EITHER futures level ≥ MIN_OI_LEVEL OR the NSE-combined path below.
 */
export const MIN_NSE_OI_PCT = 5;
/**
 * The NSE-combined path additionally requires the build to be GENUINELY
 * options-led and the options tradeable — combined-OI %-change alone was a loose
 * proxy (it rises on futures builds too). Both thresholds set empirically from
 * the full 215-name oi-spurts distribution (2026-07-14):
 *  - `MIN_OPT_SHARE` = options premium ÷ (fut+opt value). The median single-stock
 *    name is only ~6.4% (Indian single-stock F&O is futures-dominated), so 10% is
 *    clearly above-normal options participation. NOT higher: 15% is the ~95th pct
 *    and would reject TATAELXSI (14%), a genuine top-of-board options-led build.
 *    A ratio, so ~time-invariant through the day.
 *  - `MIN_OPT_PREMIUM_CR` = a light liquidity floor. premValue is CUMULATIVE and
 *    the entry window is early (09:45–11:00), so it's only partly accumulated by
 *    10am — ₹5Cr removes dead option chains without over-blocking the morning
 *    (real candidates are ₹20Cr+ by EOD). Value is ₹ Crore.
 * So the options-led path passes on: NSE combined ≥ MIN_NSE_OI_PCT AND
 * optShare ≥ MIN_OPT_SHARE AND premValue ≥ MIN_OPT_PREMIUM_CR.
 */
export const MIN_OPT_SHARE = 0.1;
export const MIN_OPT_PREMIUM_CR = 5;

/**
 * EXPERIMENTAL hard gate on the TF 3-check breakout verdict (lib/breakout).
 * Off by default. When on, a candidate must grade `confirmed` (or `strong`) in
 * the trade's direction — morning test held + ≥1 named level cleared — to be
 * suggested; watch/fakeout-risk/none/no-candles are gated out (reported as
 * gated.tfBreakoutGate).
 *
 * Why OFF: the 320-trade TF-book backtest (scripts/backtest-breakout.ts)
 * validated the signal's DIRECTION (91.4%) and timing (98% ≤10:30), but its
 * grades did NOT separate TF's wins from losses (their edge is exit discipline
 * — only 6/25 losses were un-confirmed at entry, and entry-time fakeout flags
 * were all wins). Enable only after a replay A/B over recorded live sessions
 * (the full scan universe, not TF's curated book) shows the gate improves picks.
 */
export const USE_TF_BREAKOUT_GATE = false;
/**
 * EXPERIMENTAL chaotic-open gate (lib/trade-suggest/chaotic-open.ts): skip a
 * candidate whose opening 15-min range exceeded CHAOTIC_OPEN_MAX_RATIO × its
 * own settled 5-min ATR — the "violent open, spike, fade" profile. Evidence
 * (N=4, 2026-07-15/16): both auto-trade losers opened at 5.5×/5.7×, both
 * winners at 2.5×/2.9×; full table + honest over-fitting caveat in the module
 * doc. Default ON at the user's explicit request (2026-07-17) — the standing
 * multi-day-replay discipline still applies: this switch comes OFF if the
 * replay turns against it.
 */
export const USE_CHAOTIC_OPEN_GATE = true;
/** Skip when opening-range ÷ settled-ATR exceeds this. Calibrated at 5 by the
 *  2026-07-17 full-universe backtest: 4 would have blocked the trend-day class
 *  at ~10:30 (KALYANKJIL 4.46, SIEMENS 4.37, CGPOWER 4.29 — the exact winners
 *  the strategy lives on), while 5 keeps them all AND still blocks both proven
 *  chaotic-open losers (HYUNDAI 5.48 at its 09:48 entry, SRF 5.74) plus 6
 *  losing picks with zero winners lost. Margin over HYUNDAI is only 0.48 —
 *  don't raise further without new evidence. */
export const CHAOTIC_OPEN_MAX_RATIO = 5;

/** Bid-ask spread ceiling on the UNDERLYING EQUITY, as % of mid — a candidate
 *  wider than this is too costly to trade and never becomes a suggestion
 *  (matches setup-score). Do NOT confuse with the two OPTION spread limits:
 *  OPTION_WARN_SPREAD_PCT (2, warns) below, and ORDER_ENTRY_MAX_SPREAD_PCT
 *  (3, refuses the order) in lib/auto-trade/config.ts. Three different
 *  instruments, three different jobs — they were all called MAX_SPREAD_PCT
 *  until the naming was split. */
export const SUGGESTION_MAX_SPREAD_PCT = 0.3;
/**
 * Third TF pillar: turnover ≥ 1.2× its (time-adjusted) 20-day average.
 * The R-Factor turnover score is clamp((ratio−1)/2, 0, 1), so 1.2× ⇔ 0.1 —
 * gating on the factor score applies the pillar without re-deriving the ratio.
 */
export const MIN_TURNOVER_SCORE = 0.1;

/**
 * Premium stop distance, as a % of the entry price of the OPTION.
 *
 * This is sized to the option's OWN noise, not to the underlying's. An intraday
 * near-ATM option re-prices on three things the spot knows nothing about — time
 * decay, the post-open volatility cool-off, and the bid-ask spread — so a stop
 * narrower than that noise measures the contract breathing, not the idea failing.
 *
 * Evidence (2026-07-23 review of all 9 completed live trades):
 *  - SRF 23-Jul: the stock sat 1 point from entry (4.6% of the way to the spot
 *    stop) while the option had already burned 78% of its stop budget. It was
 *    stopped at ₹36, then the call proved RIGHT — the stock fell 175 points and
 *    the same contract's bid reached ₹178 by 14:50, a ₹26,880/lot MAX FAVORABLE
 *    move against the −₹1,610 actually booked. That ₹26,880 is what the contract
 *    OFFERED, not what the exit policy would take: the auto-trader holds to a
 *    ~₹1,100 cash target, so a surviving SRF books ≈₹1,100. The point the number
 *    proves is narrow and real — the tight stop fired on noise and flipped a
 *    winner into a loser — NOT that a wider stop harvests the whole move.
 *  - The SRF option's own bid ranged ₹36.10–₹45.05 (20.3% of entry) inside the
 *    6.5-minute hold, with the stock nearly flat.
 *  - Sorted by stop width, the live record separates almost perfectly: every
 *    stop tighter than 12% of premium lost (INDUSINDBK 7.7%, AXISBANK 8.1%,
 *    NESTLEIND 9.2%, POLYCAB 9.4%, COLPAL 11.7%); the two above 20% won
 *    (HEROMOTOCO 20.6%, M&M 23.8%).
 *
 * 25 sits above every noise band seen in this SMALL in-sample set (n=9) while
 * staying well inside the 40–50% Indian option-buying convention it replaced.
 * Treat it as a calibrated STARTING POINT, not a proven universal stop: DTE,
 * moneyness, IV regime and the bid-ask spread all move an option's true noise,
 * and the forward live sessions are the real test. It is runtime-tunable
 * (settings.optionStopPct) so it can be revised without a code change.
 */
export const OPTION_STOP_PCT = 25;
/**
 * Hard ₹ ceiling on the risk PER LOT — enforced by REFUSING the entry, never by
 * squeezing the stop.
 *
 * The old rule (MAX_LOSS_PER_LOT_RUPEES = ₹1,500, applied as
 * `max(−40%, −1500/lot)`) enforced the budget the other way round: it moved the
 * stop until the arithmetic fitted. Because ₹1,500 ÷ lotSize lands somewhere
 * different for every contract, the effective stop ranged 7.7%–23.8% across nine
 * live trades and NOBODY chose those numbers — they fell out of the lot size.
 * Big-lot names silently got the tightest leash and lost every time.
 *
 * The budget is now a SIZING filter: if OPTION_STOP_PCT of the lot's cost would
 * exceed this ceiling, the contract is too expensive for the account and the
 * entry is refused (risk/gates.ts). Choosing what to buy is the honest lever;
 * cutting the stop short is not.
 *
 * ₹2,500 against the nine recorded trades: allows all four of 23-Jul (three
 * winners plus SRF, which survives its stop instead of being shaken out at
 * −₹1,610) and refuses all five earlier losers, whose lots were ₹12.7k–₹19.4k.
 * (A surviving SRF books its ~₹1,100 cash target like any other winner — the win
 * is turning a −₹1,610 loss into a target hit, not capturing SRF's full move.)
 * NOTE the interaction with dailyLossHaltRupees — a halt at or below this value
 * stops the day after a single full-stop loss.
 */
export const MAX_RISK_PER_LOT_RUPEES = 2500;
/** TF-style profit objective per lot (₹) — translated to a premium target. */
export const TF_LOT_TARGET_RUPEES = 5000;
/** Option-liquidity warnings: bid-ask spread of the OPTION itself above this %
 *  of mid, or zero traded volume, flags the contract as hard to execute.
 *  WARNS only — the refusal happens at ORDER_ENTRY_MAX_SPREAD_PCT (3) in
 *  lib/auto-trade/config.ts. Warn first, then enforce. */
export const OPTION_WARN_SPREAD_PCT = 2;

/** Composite score weights (sum 1.0) — applied to normalized [0,1] components.
 *  Price action / opening-range breakout raised to co-lead 2026-07-03 (user
 *  directive: "price action and breakout are crucial"; the day's one TF winner,
 *  SUNPHARMA, was an OR breakout while both non-breakout picks stopped out). */
export const WEIGHTS = {
  rFactor: 0.22,
  confidence: 0.08,
  oiUrgency: 0.18,
  oiLevel: 0.12,
  orBreakout: 0.2,
  imbalanceAlign: 0.07,
  sectorBreadth: 0.08,
  setupStrong: 0.05,
} as const;

/** Max picks per run. Was 3 (the original ask); raised to 7 on the user's
 *  2026-07-08 instruction ("don't limit to 3 … make 7"). Quiet days still
 *  produce 1–2 — the gates, not this cap, are the usual constraint. With the
 *  user's ₹50–60k only the top 1–3 are actionable; the tail is watch-only. */
export const MAX_PICKS = 7;

/** The user's F&O capital (₹). A pick whose single lot costs more than this is
 *  skipped in favor of the next qualified candidate — suggestions must be
 *  tradeable for THIS account, not in theory. */
export const CAPITAL_BUDGET = 60_000;
/** How many extra ranked survivors to premium-quote as affordability fallbacks. */
export const PICK_OVERSAMPLE = 3;


/** Reward:risk multiple for the DISPLAYED spot target (entry ± N × risk).
 *
 *  With TRAIL_R active this is a reference level shown to the operator, NOT a
 *  hard exit — the position is not closed on touching it. See TRAIL_R. */
export const TARGET_RR = 2;

/**
 * Trailing stop, in R, or null to keep the old fixed-target exit.
 *
 * Once a trade is this far onside, the stop advances to
 * (best favourable price − TRAIL_R × risk) and NEVER loosens. There is no fixed
 * profit target; the 15:12 square-off still terminates everything.
 *
 * WHY. The operator's benchmark (TradeFinder, Sensibull-verified, 23 sessions
 * 2026-07-09 → 2026-08-10) makes its money entirely on the exit:
 *
 *   every losing day:  −0.14R  −0.98R  −0.94R  −0.84R   (never once beyond 1R)
 *   winning days:      3.5 … 9.6R,  avg winning day ₹15,430 vs losing ₹1,812
 *   profit factor 40.4,  82.6% winning days,  all exits 15:31–16:02 IST
 *
 * The 82.6% win rate is an OUTPUT of two rules — one stop ends the day, and
 * winners run to the close — not a target to aim at directly. Our engine did
 * the opposite: every winner capped at 2R while a second loss was still allowed.
 *
 * Measured on TF-race candidates, one entry per name per day, 1% stop: a fixed
 * 1:2 target capped the best available trade at exactly 2.0R; removing it
 * surfaced a 6.4R winner in the same three sessions. avg +0.700R → +0.840R.
 *
 * CAVEAT, deliberately loud: that measurement walks the SPOT path. Holding an
 * option to 15:12 pays a full day of theta, which a spot path cannot see, and
 * this change holds LONGER than the previous one. Paper mode records real
 * premiums and is how the gap gets measured — see the spec's §3a.
 */
export const TRAIL_R: number | null = 2;

/**
 * Minimum stop distance as % of entry. A last-5-min-candle SL can be
 * degenerately tight when that bar is small (seen live: MARICO risk of
 * 0.05 pts on an ₹842 stock) — a stop inside normal 5-min noise is a
 * guaranteed stop-out, not a plan. Structural SLs tighter than this floor
 * are widened to it (slBasis: 'floor').
 *
 * WIDENED 0.35 → 1.0 on 2026-08-13. This is not a tuning change; it fixes a
 * disagreement between two stops that were supposed to describe one policy.
 *
 * The premium stop is OPTION_STOP_PCT = 25% of the option's own entry price.
 * For a near-ATM option (delta ≈ 0.5, premium ≈ 2% of spot) a 1% adverse SPOT
 * move is worth roughly a 25% premium move — so 1.0% is where the spot stop and
 * the premium stop finally describe the same risk. At 0.35% the spot stop fired
 * about THREE TIMES sooner than the premium stop the operator actually chose,
 * and the tighter, unchosen one won every time.
 *
 * Measured over 2026-08-10..12 on TF-race candidates at a 1:2 target, changing
 * ONLY this number: win rate 42% → 74%, ₹625 → ₹2,184 per trade. Both improved,
 * which is the signature of a bug being removed rather than a trade-off being
 * chosen. Same reasoning as the 2026-07-23 premium-stop widening (see the SRF
 * case in CLAUDE.md) — that fix was applied to the premium side only, and the
 * spot plan never got it.
 */
export const MIN_RISK_PCT = 1.0;
/** Volatility floor: risk floor becomes max(MIN_RISK_PCT%, SL_ATR_MULT × ATR14
 *  of the 5-min series). 0 = % floor only. Set from the replay benchmark
 *  (scripts/replay-window.ts) — change ONLY with fresh replay evidence. */
export const SL_ATR_MULT = 0;

/** Score multiplier for 'extended' movers (setupScore flags |chg from open|
 *  ≥3%) — the soft-penalty path, active only when EXCLUDE_EXTENDED is off. */
export const EXTENDED_SCORE_MULT = 0.6;
/** Hard-skip extended movers at pick time. Evidence: extended picks are
 *  0-for-5 (live 2026-07-03: MUTHOOTFIN/POLICYBZR/MARICO all stopped; replay
 *  benchmark same day: banning was the ONLY variant that improved ΣR, +1.00
 *  vs 0.00). Revisit if a recorded day shows extended continuation working —
 *  flip to false to fall back to the ×0.6 penalty, or leave ON and use the
 *  trend-aligned bypass below to admit only genuine trend-day continuations. */
export const EXCLUDE_EXTENDED = true;

/** Extended-trend bypass (opt-in). When EXCLUDE_EXTENDED hard-gates a name that
 *  has run ≥3% from open, this lets a genuine TREND-day continuation back in —
 *  breakout still extending AND price holding VWAP AND Supertrend(10,3) aligned.
 *  Evidence FOR: KALYANKJIL 2026-07-09 gap-open +4.5% → +17.5% with <2.2%
 *  pullbacks, refused on all 91 scans. The guard it preserves: the 0-for-5 chase
 *  losers (MUTHOOTFIN/POLICYBZR/MARICO, 2026-07-03) reversed — they lost
 *  VWAP/Supertrend, so the predicate still rejects them. Score keeps the extended
 *  ×0.6 penalty, so a bypassed name ranks conservatively. OFF by default.
 *  REPLAY RESULT (2026-07-09, N=1): turning this ON made the day WORSE —
 *  ΣR +0.00 vs shipped +2.00. The predicate DID admit KALYANKJIL correctly
 *  (breakout+VWAP+Supertrend all aligned), but the TRADE still stopped out −1R:
 *  the 10:20 entry @420 was late (+10.6% from open) and the tight last-candle SL
 *  (₹417) was run by a routine 1.1% pullback before the stock resumed to +17.5%.
 *  PAGEIND (also extended, admitted) stopped too. Lesson: admitting extended
 *  trends is not enough — they need a WIDER (opening-range/ATR) stop to survive
 *  normal pullbacks. Keep OFF until that pairing is built and re-validated.
 *  See extended-bypass.ts. */
export const USE_EXTENDED_TREND_BYPASS = false;
/** R-Factor floor for the extended-trend bypass. = base MIN_RFACTOR (extended
 *  survivors already cleared it); the breakout + VWAP + Supertrend trend is the
 *  real discriminator, so no extra R bar is imposed by default. */
export const EXTENDED_BYPASS_MIN_RFACTOR = rFactorAtRaw(0.375); // = base MIN_RFACTOR
/** Require an actually-computed, aligned Supertrend(10,3) for the bypass (not just
 *  VWAP). True also blocks the first ~1h of raw-spike noise before the trend
 *  proves itself — the conservative default when overriding a 0-for-5 ban. */
export const EXTENDED_BYPASS_REQUIRE_SUPERTREND = true;

/**
 * EXPERIMENTAL stale-move gate (lib/trade-suggest/move-freshness.ts): drop a
 * candidate whose move is already BEHIND it — the gap-and-flat profile (a big
 * day move with ~nothing since 09:45) and the fading profile (giving it back
 * since 09:45). This is the "App Since 9:45" column finally acting on a scan
 * instead of only being displayed.
 *
 * Ships OFF, and the reason is not timidity: `sinceEntryPct` was never
 * PERSISTED to the EOD table until 2026-08-07, so there is no multi-day history
 * to replay this against. Turning it on now would be a guess wearing a gate's
 * clothes. Everything the gate would use is attached to every pick as evidence
 * regardless (`moveFreshness`), it is written into the entry bar both AIs read,
 * and it is surfaced in the reasons list — so the signal is fully in play
 * today. Flip this ON from /config once the replay has ~10 sessions of
 * sinceEntryPct history and shows the profiles separate winners from losers.
 */
export const USE_MOVE_FRESHNESS_GATE = false;

// ─── TF Running Race selector (2026-08-13) ───────────────────────────────────

/**
 * Take trade candidates from TradeFinder's Running Race instead of the App
 * R-Factor sweep. Operator rule: auto-trade considers ONLY race stocks.
 *
 * The gates that used to live here — MIN_RFACTOR, MIN_CONFIDENCE, MIN_OI_LEVEL,
 * MIN_NSE_OI_PCT, MIN_TURNOVER_SCORE — are bypassed on this path. They all
 * re-asked the question TF's R-Factor already answers (is big money here?), and
 * the App R-Factor that fed them had NO discriminating power: over the three
 * sessions with TF captures it scored every graded pick 3.65–6.45 while half of
 * them sat below TF R = 1.0 and lost. Tradeability gates (spread, lot cost vs
 * capital, chaotic open) still apply — those ask a different question.
 *
 * This is a permanent fail-closed invariant, not a runtime toggle. Missing or
 * stale TF data means no new entry while open positions remain manageable.
 */

/**
 * How stale TradeFinder's board may be before the selector refuses to trade
 * (minutes). TradeFinder signs this account out roughly daily and INCLUDING
 * mid-session — on 2026-08-10 captures ran cleanly until 12:10 IST, then 263
 * consecutive requests failed for 3h20m. A stale board is exactly how you buy a
 * name that stopped accumulating an hour ago, so there is deliberately NO
 * fallback to the old engine: no fresh board means no new entries, and the
 * reason is surfaced rather than swallowed. Open positions keep being managed.
 */
export const TF_BOARD_MAX_AGE_MIN = 10;

/** Only names inside TF's own top-N count as "on the board". Matches the /tf
 *  race display (`maxRank`). Rank ≤ 20 corresponded to TF R ≈ 1.4 on all three
 *  measured sessions, which is what makes the sub-1.0 band (−0.317R, t=−11.12)
 *  structurally unreachable rather than merely discouraged. */
export const TF_RACE_MAX_RANK = 20;
