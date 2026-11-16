# Rekono hybrid AI exception agent — implementation plan

Status: Milestone 1 (assessment) done. Nothing below is built yet.

## Assessment (2026-11-15)

- **App**: static, browser-only ES modules in `dist/` (hand-written, no build step). State in `localStorage`. No backend, auth or database.
- **Deterministic engines** (pure ESM, already imported by Node tests, so they run server-side unchanged):
  - `dist/engine.js` — invoice validation, `cents`/`money` (integer cents), CSV export
  - `dist/matching-engine.js` — `validateDocument`, `compareDocuments`, `correctionDraft`
  - `dist/duplicates-engine.js` — `scanDuplicates`, `comparePair`, reference normalisation
  - `dist/supplier.js` — vendor normalisation, near-match evidence
  - `dist/case-engine.js`, `dist/workflow-engine.js` — correction case and inbox linking
- **UI**: `app.js` (inbox), `matching.js`, `case-ui.js`, `duplicates-ui.js`, `extraction-review.js`.
- **Tests**: 40 passing (`node --test`), plus three synthetic benchmarks with frozen engine hashes.
- **Deployment**: the repo only has a GitHub Pages workflow. There is no `vercel.json`; `.env` is empty; no `vercel`, `supabase` or `gh` CLI is installed.
- **Limits that matter**: USD only, credit notes rejected, extraction is pattern-based in the browser.

## Decisions

1. **Engines stay where they are.** API code imports `dist/*-engine.js` directly. One copy serves browser and server, and the frozen benchmark hashes stay valid. Engine files are not edited; new behaviour goes in server wrappers.
2. **Money**: integer cents in code, `numeric(14,2)` in Postgres, converted at the data-access boundary only.
3. **Frontend stays vanilla ES modules.** New modules: `dist/api-client.js`, `dist/auth-ui.js`, `dist/investigation-ui.js`. The local demo mode keeps working when signed out.
4. **Extraction stays in the browser** (PDF.js/Tesseract) for now. The server stores the original file, receives extracted fields with per-field confidence, and re-validates everything. Server-side extraction is a later step.
5. **Durable jobs**: a Postgres `jobs` table with idempotency key, lease and attempt count. A worker endpoint claims with `FOR UPDATE SKIP LOCKED`; it is kicked on enqueue and by a scheduled sweep that reclaims expired leases.
6. **AI output**: the model returns findings, causes, recommendation and confidence only. The server fills `verified_financial_impact` from the engine result, rejects any `evidence_ids` not returned by a tool in that run, and downgrades to `insufficient_evidence` on failure.
7. **Tests**: Vitest for new code; existing `node --test` suite untouched. Schema and row-level-security tests run against PGlite (in-process Postgres) so no Supabase project is needed locally. OpenAI is called through one thin client that tests replace with scripted responses.

## Layout

```
supabase/migrations/      SQL schema, RLS policies, append-only audit trigger
api/                      Vercel Functions (thin: auth, Zod, call a service)
server/contracts/         Zod schemas shared by API, agent and tests
server/db/                data access (cents <-> numeric)
server/services/          validation, matching, duplicates (wrap dist engines), jobs, audit
server/agent/             tool registry (9 tools), loop, prompt, output verifier, cost limits
dist/                     existing UI + three new modules
tests/                    existing suite
tests-server/             Vitest: services, RLS, agent, authz, end-to-end
eval/                     baseline A vs system B harness
docs/                     architecture, env vars, local dev, deployment, limitations
```

## Work packages

Each package owns its directories; no two write the same files.

| # | Package | Owns | Depends on | Agent |
|---|---------|------|------------|-------|
| 1 | Contracts: Zod schemas, API response shapes, status enums | `server/contracts/` | — | planner (Fable) |
| 2 | Schema, RLS, audit trigger, jobs table, RLS tests | `supabase/`, `tests-server/db/` | 1 | ECC tdd-guide |
| 3 | Data access, engine services, auth middleware, API endpoints, idempotency, rate limit | `server/db/`, `server/services/`, `api/` | 1 | ECC tdd-guide |
| 4 | Agent: tools, loop, verifier, prompt-injection handling, cost and iteration caps | `server/agent/`, `tests-server/agent/` | 1, 3 (service signatures) | ECC tdd-guide |
| 5 | Frontend: sign-in, inbox columns, investigation panel, evidence viewer, resolution controls, states | `dist/` new modules + small edits | 1 | ECC tdd-guide, then e2e-runner |
| 6 | Evaluation harness and metrics report | `eval/` | 3, 4 | ECC tdd-guide |
| 7 | `vercel.json`, `.env.example`, docs | root config, `docs/` | all | Sonnet |
| 8 | Review: security-reviewer and code-reviewer on each package; fixes | — | each package | ECC reviewers |

Order: 1 → (2, 3 in parallel) → (4, 5 in parallel) → 6, 7 → 8 → deploy.

## Needed from the owner before deployment

- A Supabase project (URL, anon key, service-role key) and an OpenAI API key, placed in `.env` locally and in Vercel environment variables. Never pasted into chat or committed.
- Confirmation that the Vercel project is linked to this GitHub repo, and push access to it.

Everything through package 8 can be built and tested locally without these.

## Known gaps this plan does not close

- Extraction accuracy on real documents is unmeasured; synthetic results are not OCR accuracy.
- USD only; credit notes unsupported.
- The deployed workflow (Definition of Done item 15) cannot be verified until the credentials above exist.
