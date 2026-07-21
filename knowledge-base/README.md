# Project-R Knowledge Base

This folder is the durable handoff for Project-R decisions, production behavior,
rollout status, and future work. It exists so a new development session does not
have to rely on old chat history.

## Structure

- `init/01-priority-refresh-implementation.md` — what was implemented and what it actually does.
- `init/02-production-operations.md` — where to inspect it in production and which settings matter.
- `init/03-live-enablement-plan.md` — evidence and engineering required before enabling live capped refresh.
- `init/04-new-session-handoff.md` — a ready-to-paste prompt for a new Codex session.

## Maintenance rule

Update this knowledge base whenever behavior, defaults, production controls, or
rollout decisions change. Include the date, relevant PRs, and an honest statement
of what is live, shadow-only, disabled, or deferred.

Do not treat a document here as proof that production is healthy. Confirm effective
runtime settings and current production behavior before making trading changes.
