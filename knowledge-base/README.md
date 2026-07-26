# Project-R Knowledge Base

This folder is the durable handoff for Project-R decisions, production behavior,
rollout status, and future work. It exists so a new development session does not
have to rely on old chat history.

## Structure

- `init/01-priority-refresh-implementation.md` — what was implemented and what it actually does.
- `init/02-production-operations.md` — where to inspect it in production and which settings matter.
- `init/03-live-enablement-plan.md` — evidence and engineering required before enabling live capped refresh.
- `init/04-new-session-handoff.md` — a ready-to-paste prompt for a new Codex session.
- `init/05-live-loss-review-2026-07-22.md` — production evidence for the losing streak, tag comparison, and the local cash-target hotfix.
- `init/06-rfactor-v2-shadow.md` — the shadow activity/direction engine.
- `init/07-premium-stop-review-2026-07-23.md` — why the premium stop was resized to the option itself, the SRF proof case, the replay verdict and its limits, the 10-setting configuration drift, and the toggle audit. **Supersedes the stop-loss half of `05`.**
- `init/08-expiry-roll-and-privacy-release-2026-07-26.md` — the 26 July production release in plain English: the expiry-week contract roll (first fires Monday 27 July), the AI-config bug that could have switched off the stop-loss, three read-only-viewer position leaks, the four damaged-download checks, restart recovery, what was measured versus reasoned, a mistake caught in review, and the seven remaining gaps. **LIVE on `prod` at `88ede7f`.**

## Maintenance rule

Update this knowledge base whenever behavior, defaults, production controls, or
rollout decisions change. Include the date, relevant PRs, and an honest statement
of what is live, shadow-only, disabled, or deferred.

Do not treat a document here as proof that production is healthy. Confirm effective
runtime settings and current production behavior before making trading changes.
