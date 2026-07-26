"catch the 79% move" as a separate entry problem to study, not a switch to flip.

above line is imp for us in future

First — you were right about the config, and I was wrong to split by "door"
23 + 24 July ran on the same stable config (last real change: 23 Jul 09:35 IST, before the first scan). Result:

8 trades · 6 wins · 2 losses · +₹4,445

My earlier "experimental vs normal" split mixed different config days together. Judged properly — one stable setup, two days — the current system is working. (One toggle was re-saved on 24 Jul at 09:59, but to the same value it already had, and it's the inert one. No behaviour change.)

The exit test — I ran it. Result flips depending on ONE trade
Using the recorded option prices for all 8 trades:

Exit rule	Total
What we actually did (fixed ₹1,100)	+₹4,445
Book half at target, trail the rest	+₹12,034
Full trail (exit on 25% giveback from peak)	+₹27,334
Hold to the close	+₹27,467
Looks like trailing wins massively. But now remove SRF alone:

Exit rule	7 trades (no SRF)
Fixed ₹1,100	+₹6,055 ✅ best by far
Full trail	+₹1,424
Half + trail	−₹1,371 ❌ loses money
On 7 of 8 trades, our fixed target was the best choice. One trade (SRF) carries the entire trailing advantage.

I also tested your capital-vs-target idea as a fixed % target (same shape as the stop-width fix you're remembering):

Target rule	Total
Actual fixed ₹1,100	+₹4,445
+25% of premium	+₹3,431
+30%	+₹1,670
+40%	+₹2,972
+50%	+₹4,683
A fixed % target does not beat what we're doing. So the answer to "how do we fix the capital/target mismatch like we fixed the stop width" is: on this evidence, it doesn't need fixing. The fixed ₹1,100 actually demanded only +8.6% to +17% on seven of the eight trades. Only INFY was an outlier at +24.9% — and INFY's loss was a stop problem, not a target problem.

Honest limits: the option-chain readings are sparse (2 to 45 per trade). Gaps between readings hide dips, which flatters the trailing rules. M&M 24-Jul had only 2 readings — ignore that row.

The finding that actually matters — TF is NOT a lottery
I checked whether TradeFinder's profits come from rare huge winners. They don't:

TF wins (307 trades)	
Median win	₹17,179
Mean win	₹17,984
Top 10% of wins share of all winning rupees	only 19%
Median return per winning trade	+79%
25th–75th percentile return	+58% to +100%
Median and mean are almost identical, and the biggest wins contribute only 19%. That means TF wins steadily at 58–100% per trade — it is not one lucky runner paying for everything.

Our returns on the same 8 trades: +11.7%, +17.9%, +15.9%…

So the gap between us and TF is not the exit rule. Their entries produce 79% option moves, repeatedly. Ours produce 12–18% moves. You can't trail your way to 79% if the move isn't there.

And proof the moves exist when the pick is right: SRF's option went from ₹44.05 to ₹178.45 (+305%) and ASTRAL from ₹19.55 to ₹32.80 (+68%). Those two were TF-shaped. The other six faded — holding them longer lost money (4 of 8 were worse at the close).

So: TF ideas, or stick with ₹900–1,100?
Stick with the fixed cash target. The evidence is clear and I won't dress it up:

It beat every alternative I tested on 7 of 8 trades.
Both trailing rules and every % target performed worse once SRF is set aside.
It's producing 6 wins from 8 with the current config.
Do NOT switch to TF-style "hold for 79%" yet — because our picks don't behave like TF's picks. Four of our eight faded after the first push. Holding them longer is a proven loss on this data.

What the evidence does support, in order:

Ship the wider 25% premium stop (PR #18, already built). SRF was stopped by the old too-tight stop. With the 25% stop it survives — and then a runner rule could catch that ₹25,910. The stop fix is the unlock, not the exit change.
Fix the INFY-type loss — protect on the option price, not a spot "breakeven". Already partly done (the prompt no longer claims a spot stop makes a trade risk-free).
Then, and only then, test a narrow runner rule: let a trade run only when it's already up big (say +40%+), which is rare. On this data it would touch just SRF and ASTRAL and leave the six that faded completely alone. That's the version worth shadow-testing — not a blanket trailing stop.
The real long game is entry quality, not exits. TF's 79% median means their entries catch a different size of move. That needs many more recorded days before we change anything.
In one line: our exit is correctly matched to what our entries currently deliver — keep it, fix the stop, and treat "catch the 79% move" as a separate entry problem to study, not a switch to flip.