# AGENTS.md

Instructions for coding agents working in this repo. `CLAUDE.md` points here.

## Main behavioral guidelines

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think before coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity first

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-driven execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (external PRs are not a triage surface). See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo — one `CONTEXT.md` + `docs/adr/` at the root. See `docs/agents/domain.md`.

## i18n / Lingui — interpolation gotcha

Do not add interpolating `msg` translations (`` msg`${x} …` ``) inline inside a React
component or hook. React Compiler renames the interpolated locals in production builds
(`minutes` → `minutes_2`), which desyncs the message id from the compiled catalog, so
production renders the placeholders raw (`{minutes_2}`). Dev looks fine and hides it.

Rule (temporary, until Lingui moves to the Babel macro ordered before React Compiler):
translations that interpolate values live in **module-scope helper functions** (e.g. the
duration formatters in `src/app/page.tsx`), which React Compiler leaves untouched. See
`docs/dev/backlog.md`.

## Undo/redo — history handlers

Register and push through the typed façade (`createTypedHistory<Map>()` per domain), not
the raw `pushHistory`/`registerHistoryHandler`. The map binds each action type to its
payload, so a push can't drift from the handler that inverts it. Copy an existing domain
(`src/supports/history/`, `src/features/mesh-smoothing/history/`) for the shape.

Two invariants that mimicry won't teach — get either wrong and undo breaks **silently**:

- **Register at an app-root / always-mounted lifetime**, never gated on a render component.
  Handlers gated on a mesh being on screen mean Ctrl+Z stops working depending on the render
  tree (the bug this seam fixed). Supports register via `useSupportHistoryHandlers()` at the
  app root; scene/mesh-smoothing register in always-mounted hooks.
- **Everything pushed to the stack needs a handler** — even a marker with no undo behaviour
  needs a pass-through (`() => true`), or an unhandled entry strands the stack (see
  `SCENE_SLICED`). A handler returning `false` means "unrecoverable"; the entry is discarded.
