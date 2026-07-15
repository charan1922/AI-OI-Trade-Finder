# Auto-Trade & AI Commentary — The Curriculum

A plain-English course on how this app finds trades, decides on them, executes them,
and writes about them. No prior trading or coding knowledge needed — every term is
explained the first time it appears.

## How to read this

Read the lessons in order. Each one builds on the one before it.

| Lesson | What you'll learn |
| --- | --- |
| [01 — The Big Picture](01-the-big-picture.md) | What the whole system is, and one full day in its life |
| [02 — The Words You Need](02-the-words-you-need.md) | Options, premiums, lots, OI, R-Factor — the vocabulary, simply |
| [03 — The Data Engine](03-the-data-engine.md) | Where the numbers come from: the 5-minute heartbeat |
| [04 — The Scanner](04-the-scanner.md) | How the app picks which stocks are worth trading |
| [05 — The AI](05-the-ai.md) | The two jobs the AI does: deciding and explaining |
| [06 — How a Trade Happens](06-how-a-trade-happens.md) | A real trade followed step by step, entry to exit |
| [07 — The Safety Rules](07-the-safety-rules.md) | The hard limits that no one — not even the AI — can break |
| [08 — Brokers and Modes](08-brokers-and-modes.md) | Paper vs approval vs live, and how orders reach a broker |
| [09 — Record-Keeping and Review](09-record-keeping-and-review.md) | Every decision is written down; how the app grades itself |

Lessons 03–09 each end with an **"Under the hood"** section that maps the
lesson's ideas to the actual code — which method in which file does the job —
and spells out the maths (formulas checked against real recorded trades).
Beginners can skip those sections on a first read; they're there for when you
want to see exactly where a rule or a number comes from.

## The one-sentence summary

> Every 5 minutes during market hours, the app collects fresh market data, a
> rule-based scanner shortlists stocks showing unusual activity, an AI looks at the
> shortlist and manages positions — and **hard-coded safety rules have the final
> word on every single order**.

## The design law

The whole system follows one rule, worth memorizing before lesson 1:

**The AI proposes, the code disposes.**

The AI can suggest a trade, but a fixed set of safety checks written in code
(time window, money caps, loss limits) re-verifies every action. If a check
fails, the action is rejected — no matter how confident the AI sounds.
