# AI investigation agent package — handoff

**Update, later on 2026-11-15: this package is finished.** The four "Not written" items below now exist, and `npx vitest run` (451 of 451), `npx tsc --noEmit` (0 errors) and `npm test` (63 of 63) are green. Still open: the real OpenAI path has never run; the signed-in frontend has never been walked in a browser; three API gaps the frontend works around (no route for a discrepancy's investigations, the caller's role, or stored supplier drafts). The rest of this file is the record of the pause.

Stopped by accident on 2026-11-15, partway through. Nothing is committed; all files are in the working tree on branch `feat/hybrid-ai-agent`. Do not restart from scratch: the pieces below are written, and the tests that define the rest already exist.

## Written (do not rewrite)

| File | Lines | What it is |
|---|---|---|
| `server/agent/tools.ts` | 87 | Registry of the nine tools: Zod validation, organisation from the job, `tool_calls` logging |
| `server/agent/model.ts` | 239 | Only file importing `openai`; OpenAI implementation and the deterministic scripted model |
| `server/agent/prompt.ts` | 53 | System prompt for `PROMPT_VERSION`, untrusted-data wrapper |
| `server/agent/verify.ts` | 88 | `AgentOutput` → `InvestigationResult`: evidence-id check, engine-sourced amount, unsupported-claim drop |
| `tests-server/agent/tools.test.ts` | 97 | |
| `tests-server/agent/verify.test.ts` | 95 | Passes |
| `tests-server/agent/investigate.test.ts` | 373 | Written first; defines the job handler's behaviour |
| `tests-server/agent/dev-server.test.ts` | 60 | Written first; defines the dev server's behaviour |
| `tests-server/agent/env.ts` | 105 | Shared test setup for the agent tests |

`@vercel/functions` was added to `package.json` for `waitUntil`.

The agent's last words before it was stopped: "Now `investigate.ts`, the job handler and loop."

## Not written (the remaining work, in order)

1. `server/agent/investigate.ts` — job handler and loop: mark `in_progress`; run the model/tool loop with caps (tool calls, iterations, output tokens, timeout, from env); store the verified result, evidence references, recommendation, confidence, model actually used and usage with estimated cost; audit event with actor type `agent`; `failed` with a safe error and retry on error or timeout; reuse the stored result for an unchanged discrepancy without calling the model. `tests-server/agent/investigate.test.ts` and `env.ts` show the exports and `Deps` fields the tests expect.
2. `server/http/router.ts` — add the public `GET /api/config` handler (the `supabase` variant of `ConfigDto` only) and a `publicConfig` and `defer(fn)` field on `Deps`; after the investigate route enqueues, kick the worker through `defer`.
3. `api/index.ts` — register the investigate handler, wire the OpenAI model, pass `waitUntil` as `defer`.
4. `scripts/dev-server.ts` and an `npm run dev` script — serves `dist/`, mounts the router, PGlite with the real migrations, in-memory storage, three fake users returned by `GET /api/config` in `dev` mode, seeded $480 PO / $540 invoice scenario, in-process jobs, scripted model unless `OPENAI_API_KEY` is set; refuses to start under `VERCEL` or `NODE_ENV=production`.

## State of checks when stopped

- `npm test`: 63 of 63 pass.
- `npx vitest run`: 408 tests pass; 3 of 12 files fail to load (`dev-server.test.ts`, `investigate.test.ts`, `tools.test.ts`) because they import the unwritten modules.
- `npx tsc --noEmit`: 7 errors, all from items 1, 2 and 4 above.

Done means: those three commands are green, and the real OpenAI path is reported as not exercised.

## Constraints that applied to this package

No commits, no branch switches. Do not edit `dist/`, `supabase/` or `server/contracts/`. Do not read `.env`. Never call the real OpenAI API in tests. Few small files, plain functions; one loop with nine tools, not a framework. Tests first.

## After this package

Browser walk of the signed-in frontend flow against the dev server (the frontend was never run signed-in), then the evaluation harness, config and docs, and the security and code review. See `docs/IMPLEMENTATION_PLAN.md`.
