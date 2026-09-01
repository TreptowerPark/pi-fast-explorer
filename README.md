# pi-fast-explorer

A manually invoked Pi extension for disposable, read-only repository reconnaissance.

## Commands

```text
/explore-fast <focused repository question>
/explore-deep <broader/high-confidence repository question>
/explore-fast-stats
/explore-deep-stats
```

Conceptually:

```text
fast = one bounded disposable exploration context
deep = three bounded disposable exploration contexts + one bounded reducer
```

Both start separate `pi` processes in the current working directory. The child gets a new ephemeral session, a replacement system prompt, the delegated question, and no parent transcript. Its only tools are narrow read-only repository tools:

- `repo_search` — `rg` with `git grep` fallback
- `repo_read` — bounded `sed -n` line ranges
- `repo_list` — shallow `find`
- `repo_git` — fixed read-only `status`, `log`, and `diff --stat` operations

Ambient extensions, skills, prompt templates, themes, context files, and built-in tools are disabled for the child. The child extension is the only explicit extension loaded. It cannot call `write`, `edit`, `bash`, package tools, web tools, or another agent.

The default fast child is `openai-codex/gpt-5.6-luna` at `high` thinking, with a five-turn budget (four investigation turns plus one reserved synthesis turn), a ten repository-tool-call ceiling, and a 90-second timeout. Override fast defaults with:

```bash
PI_FAST_EXPLORER_MODEL=...
PI_FAST_EXPLORER_THINKING=high
PI_FAST_EXPLORER_MAX_TURNS=5
PI_FAST_EXPLORER_MAX_TOOL_CALLS=10 # bounded to 1..30
PI_FAST_EXPLORER_TIMEOUT_MS=90000
```

Deep mode defaults to three workers, six turns per worker (five investigation turns plus one reserved synthesis turn), 15 repository-tool calls per worker, and a 180-second per-child timeout. Worker count is bounded to 1..4. Deep reuses the fast model/thinking settings unless its own overrides are set:

```bash
PI_DEEP_EXPLORER_WORKERS=3       # bounded to 1..4
PI_DEEP_EXPLORER_MODEL=...
PI_DEEP_EXPLORER_THINKING=high
PI_DEEP_EXPLORER_MAX_TURNS=6
PI_DEEP_EXPLORER_MAX_TOOL_CALLS=15 # bounded to 1..30
PI_DEEP_EXPLORER_TIMEOUT_MS=180000
```

Deep workers have primary-path, alternate-boundary, and adversarial-verification roles while still answering the full original question. Their compact reports are passed to a fresh no-tools reducer; the parent receives only the reducer result or a host-built fallback from usable reports. Reducer failure therefore does not discard worker evidence. Deep remains isolated, read-only, write-free, and without web, package, shell, or recursive-agent tools. Deep workers receive an explicit deep-mode prompt: correctness and high-confidence coverage first, bounded targeted investigation, default turns 1–5 for investigation, and turn 6 reserved for no-tools synthesis; they stop earlier when sufficient evidence exists.

When the delegated question contains explicit conservative line-oriented numbered requirements
(`1. ...` or `1) ...`), the child receives a deterministic `R1`, `R2`, ...
coverage checklist. Only column-zero items outside fenced code and quoted or nested list lines are recognized; indented continuation prose is retained when it clearly belongs to that item. Its final prose report includes coverage metadata as a strict
final `[COVERAGE]` trailer with one `CONFIRMED`, `NOT_CONFIRMED`, or
`NOT_INVESTIGATED` entry per requirement. Only the final block is interpreted;
earlier literal marker examples are ordinary prose, and the closing `[/COVERAGE]`
marker must be the final non-whitespace content. The host validates this structure
locally. Fast mode gives a malformed trailer at most one no-tools repair using the
current report; no additional research is allowed. Deep mode consumes coverage
entries only from structurally valid worker trailers and aggregates their
investigation states deterministically; invalid coverage metadata does not make an
otherwise usable worker report unusable. The trailer is stripped before a report
enters a parent handoff. `/explore-fast-stats` shows fast coverage counts;
`/explore-deep-stats` shows the aggregate deep ledger, including invalid coverage
metadata counts.

Unstructured questions keep the existing path and do not invoke coverage repair.

Deep runs the workers concurrently and aggregates explicit-requirement coverage deterministically. `CONFIRMED`, `NOT_CONFIRMED`, and `NOT_INVESTIGATED` are investigation states, not semantic disagreement; actual contradictory conclusions must be identified by the reducer from worker prose/evidence. If all workers fail, deep persists only a compact failure marker and does not trigger a parent answer. With at least one usable worker, a reducer success yields `completed` or `partial-completed`; reducer failure yields `fallback` using only the already-compressed labeled worker reports.

The parent parses JSON-mode child events and persists only one compact custom-message handoff into the parent session. Fast uses `pi-fast-explorer`; deep uses `pi-deep-explorer`. A successful or fallback deep run triggers exactly one ordinary parent-model turn. The handoff contains an explicit instruction to answer the original task, the full original task, and the child's compressed final report. It participates in LLM context and survives session save/resume. Telemetry is not persisted into context; `/explore-fast-stats` shows the last invocation's telemetry in the current Pi process.

## Parent persistence

Only the compressed result enters parent context. For successful runs (`completed` or `budget-finalized`) the persisted entry is:

```text
[pi-fast-explorer]
Task: <delegated question, one line>

Conclusion:
...

Evidence:
- path:line — ...

Uncertainty:
- none material

Next:
<single highest-value file/path/question, or none if sufficiently established>
```

The child's human-readable report body is kept for the handoff; its host-only `[COVERAGE]` trailer is stripped first. Tool calls, search output, file contents, intermediate reasoning, animation frames, and telemetry are never persisted. Genuine failures (`timeout`, `error`, `turn budget` without a report) persist only a compact marker such as `[pi-fast-explorer]\nExploration failed: timeout before a usable report was produced.` — no diagnostics.

Two Pi mechanisms are used:

- `pi.sendMessage({ customType: "pi-fast-explorer", ... }, { triggerTurn: true })` sends a `custom_message` entry through Pi's normal agent loop. The entry participates in LLM context (converted to a user-role text message by pi's `convertToLlm`) and triggers exactly one ordinary parent-model turn. The successful handoff uses `display: false`, so it is contextual without duplicating facts before the final answer.
- Pi persists the `custom_message` and then the genuine non-empty assistant response through its normal `message_end` path. The assistant response causes a fresh session file to be flushed, so the successful path has no synthetic assistant entry. A failure/no-turn path keeps a compact visible marker and may use the legacy zero-usage flush fallback because no real assistant response exists.

A registered message renderer is retained for visible failure markers and any restored handoff explicitly marked for display. The normal successful result is rendered by Pi's standard assistant renderer.

## TUI feedback

In interactive Pi, `/explore-fast` keeps its existing footer status and also shows a transient, UI-only dungeon corridor widget immediately above the editor. The widget uses four precomputed frames at a 320 ms interval, shows `EXPLORE · <activity> · <elapsed> · t<turn>/<max>`, and maps child tool events to `search`, `read`, `list`, or `git` when available. It falls back to a single compact status line below 42 terminal columns.

On completion, timeout, or error, animation stops and the widget displays a static outcome for 1.6 seconds before clearing. Its interval and clear timer are stopped during normal cleanup, session shutdown, and `/reload`. Widget updates are rendered directly through `ctx.ui.setWidget()` and never create parent session messages or model context.

When the child enters its reserved synthesis turn, the widget switches to `EXPLORE · finalizing · <elapsed> · t<turn>/<max>`. A successful budget finalization shows the normal green completion state, never an error visual.

## Turn budget semantics

Pi has no general CLI `--max-turns` flag. The child treats the configured limit as an *investigation allowance plus one reserved synthesis turn*:

- turns `1..maxTurns-1` — normal read-only exploration;
- turn `maxTurns` — the normal reserved synthesis turn. When it starts, the child tells the model to stop using tools, appends that instruction to the LLM context, strips all tools from the outgoing provider payload (so the model mechanically cannot call a tool), and blocks any tool call that still occurs. The run then ends naturally after the synthesis opportunity; no `ctx.abort()` is involved, so no synthetic extra turn appears.
- the repository-tool ceiling is checked between turns. If an assistant has already emitted a parallel batch that reaches or exceeds the ceiling, every call in that batch is allowed to finish; the next turn enters the same finalization path early instead of starting another investigative batch. Whichever trigger starts finalization, it provides one intended synthesis turn and no continued exploratory turns.

Telemetry termination values:

- `completed` — natural completion before the budget boundary;
- `budget-finalized` — the run reached the reserved synthesis turn and returned a usable report (persisted exactly like `completed`); `/explore-fast-stats` reports the tool count against its configured ceiling and whether finalization was triggered by `turn` or `tools`;
- `turn budget` — even the reserved synthesis turn produced no usable report (genuine failure; compact marker only);
- `timeout` / `error` — unchanged (compact marker only).

A coverage repair, when needed, is a single separate no-tools rewrite and does not add to the normal investigation or tool budget. After successful exploration, the parent receives one normal model turn and emits the actual answer to the original task. Failure markers do not trigger a model turn.
