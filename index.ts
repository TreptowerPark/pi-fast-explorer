import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { DungeonWidget, explorerActivityFromTool, type DungeonOutcome, type ExplorerActivity } from "./dungeon-widget.ts";

const DEFAULT_MODEL = "openai-codex/gpt-5.6-luna";
const DEFAULT_THINKING = "high";
const DEFAULT_MAX_TURNS = 5;
const DEFAULT_MAX_TOOL_CALLS = 10;
const MAX_TOOL_CALLS = 30;
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_QUESTION_CHARS = 8_000;
const MAX_REPORT_CHARS = 6_000;
const STATUS_KEY = "explore-fast";
const STATUS_REFRESH_MS = 1_000;
const STATUS_CLEAR_DELAY_MS = 2_500;
const CHILD_EXTENSION = path.join(path.dirname(fileURLToPath(import.meta.url)), "child-tools.ts");
const FINALIZATION_MARKER = "PI_FAST_EXPLORER_FINALIZATION=1";
const TOOL_FINALIZATION_MARKER = "PI_FAST_EXPLORER_FINALIZATION_TRIGGER=tools";
const COVERAGE_OPEN = "[COVERAGE]";
const COVERAGE_CLOSE = "[/COVERAGE]";
const COVERAGE_REPAIR_TIMEOUT_MS = 30_000;
const COVERAGE_STATES = ["CONFIRMED", "NOT_CONFIRMED", "NOT_INVESTIGATED"] as const;
const COVERAGE_STATE_SET = new Set<string>(COVERAGE_STATES);

export type CoverageState = typeof COVERAGE_STATES[number];

export interface ExplicitRequirement {
  id: string;
  text: string;
}

export interface CoverageEntry {
  id: string;
  state: string;
}

export interface CoverageValidation {
  valid: boolean;
  entries: CoverageEntry[];
  errors: string[];
  coverageEntries: number;
  confirmed: number;
  notConfirmed: number;
  notInvestigated: number;
}

export interface CoverageTrailer {
  start: number;
  end: number;
  body: string;
}

const EXPLORER_SYSTEM_PROMPT = `You are a fast, read-only repository explorer.

Your purpose is to answer a narrowly delegated question while keeping exploratory context out of the parent agent.

Optimize, in order, for:
1. correctness
2. low latency
3. low token usage

Rules:

- Investigate only the delegated question.
- Search before reading files.
- Prefer repo_search (backed by rg/git grep), repo_list (shallow find), and repo_read (targeted sed-like line ranges) over whole-file reads.
- Use repo_git only for explicitly relevant status, log, or diff context.
- Read the minimum code necessary to establish the answer.
- Normally inspect no more than roughly 6 relevant files.
- Do not follow secondary dependencies unless they are necessary to answer the question.
- Batch independent searches and reads when possible.
- You have a limited repository-tool budget. Do not spend remaining tool calls merely because they are available.
- Before starting another tool batch, decide whether the requested conclusions are already supported; if so, stop exploring and produce the final report.
- Prefer targeted searches and reads over redundant confirmation.
- Once the requested facts can be established from existing evidence, stop using tools and synthesize.
- Do not keep exploring merely to make the answer more comprehensive.
- Preserve enough remaining budget to produce the final report.
- Stop as soon as sufficient evidence exists.
- Do not modify files or repository state. The only available tools are read-only repository inspection tools.
- Do not run builds or tests unless the caller explicitly requests them.
- Do not invoke or delegate to other agents. No agent, web, network, package, or arbitrary shell tools are available.
- Do not perform broad architecture reviews unless explicitly requested.
- If the answer cannot be established cheaply, report what remains uncertain rather than continually broadening the investigation.
- Clearly mark any requested point that remains uncertain; never invent evidence.
- Do not narrate routine searches or intermediate reasoning.
- Aim to finish in 2–3 turns. Never start new exploratory work after the investigation allowance (turn 4 by default): the final turn is reserved for synthesis and tools are disabled then, so stop exploring once sufficient evidence exists.

Return only:

Conclusion:
<short answer>

Evidence:
- <path:line/function — significance>
- ...

Next:
<optional single next action>

Normally stay below 600 output tokens.`;

type TerminationReason = "completed" | "budget-finalized" | "turn budget" | "timeout" | "error";

interface ExplorerTelemetry {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  toolCalls: number;
  toolLimit: number;
  elapsedMs: number;
  model: string;
  thinking: string;
  termination: TerminationReason;
  finalizationTrigger?: "turn" | "tools";
  requirements?: number;
  confirmed?: number;
  notConfirmed?: number;
  notInvestigated?: number;
  coverageEntries?: number;
  coverageValid?: boolean;
  coverageRepair?: boolean;
}

interface ExplorerResult {
  report: string;
  telemetry: ExplorerTelemetry;
  diagnostic?: string;
}

interface PiInvocation {
  command: string;
  args: string[];
}

let lastTelemetry: ExplorerTelemetry | undefined;
let activeChild: ReturnType<typeof spawn> | undefined;
let activeStatus: ExplorerStatus | undefined;
let activeDungeon: DungeonWidget | undefined;

/**
 * Extract only line-oriented numbered list items. This intentionally does not
 * infer requirements from prose or ask a model to split the question.
 */
export function extractExplicitRequirements(question: string): ExplicitRequirement[] {
  const lines = question.split(/\r?\n/);
  const marker = /^\s*\d+[.)]\s+(.+?)\s*$/;
  const candidates = lines
    .map((line, lineIndex) => ({ line, lineIndex, match: line.match(marker) }))
    .filter((candidate): candidate is { line: string; lineIndex: number; match: RegExpMatchArray } => Boolean(candidate.match));

  return candidates.map((candidate, index) => {
    const parts = [candidate.match[1]!.trim()];
    let nextLine = candidate.lineIndex + 1;
    const nextCandidate = candidates[index + 1]?.lineIndex;
    while (nextLine < lines.length && (nextCandidate === undefined || nextLine < nextCandidate)) {
      const line = lines[nextLine]!;
      if (!line.trim()) break;
      if (!/^\s+/.test(line)) break;
      parts.push(line.trim());
      nextLine += 1;
    }

    return {
      id: `R${index + 1}`,
      text: parts.join(" ").replace(/\s+/g, " ").trim(),
    };
  });
}

function buildCoverageInstructions(requirements: ExplicitRequirement[]): string[] {
  if (requirements.length === 0) return [];
  return [
    "Requested coverage:",
    "",
    ...requirements.map((requirement) => `[${requirement.id}] ${requirement.text}`),
    "",
    "You have a limited exploration budget.",
    "Prioritize investigating requirements that are still uncovered rather than",
    "spending excessive effort on requirements already adequately supported.",
    "",
    "Your final report must account for every requirement.",
    "",
    "Allowed coverage states:",
    "CONFIRMED",
    "- sufficient inspected evidence supports the answer.",
    "NOT_CONFIRMED",
    "- investigated, but evidence was insufficient to establish a conclusion.",
    "NOT_INVESTIGATED",
    "- exploration budget ended before adequate investigation.",
    "",
    "Never silently omit a requested requirement.",
    "After the useful prose report, append exactly one compact coverage trailer:",
    COVERAGE_OPEN,
    ...requirements.map((requirement) => `${requirement.id} <one allowed state>`),
    COVERAGE_CLOSE,
    "Replace the placeholder with exactly one allowed state; do not output placeholders.",
    "Use one entry per required ID and no unknown IDs.",
  ];
}

export function findFinalCoverageTrailer(report: string): CoverageTrailer | null {
  const contentEnd = report.trimEnd().length;
  if (!report.slice(0, contentEnd).endsWith(COVERAGE_CLOSE)) return null;

  const closeStart = contentEnd - COVERAGE_CLOSE.length;
  const start = report.lastIndexOf(COVERAGE_OPEN, closeStart);
  if (start < 0) return null;

  return {
    start,
    end: contentEnd,
    body: report.slice(start + COVERAGE_OPEN.length, closeStart),
  };
}

export function validateCoverageReport(report: string, requirements: ExplicitRequirement[]): CoverageValidation {
  if (requirements.length === 0) {
    return {
      valid: true,
      entries: [],
      errors: [],
      coverageEntries: 0,
      confirmed: 0,
      notConfirmed: 0,
      notInvestigated: 0,
    };
  }

  const entries: CoverageEntry[] = [];
  const errors: string[] = [];
  const expected = new Set(requirements.map((requirement) => requirement.id));
  const trailer = findFinalCoverageTrailer(report);

  if (!trailer) errors.push("Missing or malformed [COVERAGE]...[/COVERAGE] block.");

  for (const line of (trailer?.body ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(?:[-*]\s*)?([A-Za-z][A-Za-z0-9_-]*)\s+(\S+)$/);
    if (!match) {
      errors.push(`Malformed coverage entry: ${trimmed}`);
      continue;
    }
    entries.push({ id: match[1]!, state: match[2]! });
  }

  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) duplicateIds.add(entry.id);
    seen.add(entry.id);
  }
  if (duplicateIds.size > 0) errors.push(`Duplicate coverage IDs: ${[...duplicateIds].join(", ")}.`);

  const unknownIds = [...new Set(entries.map((entry) => entry.id).filter((id) => !expected.has(id)))];
  if (unknownIds.length > 0) errors.push(`Unknown coverage IDs: ${unknownIds.join(", ")}.`);

  const invalidStates = entries
    .filter((entry) => !COVERAGE_STATE_SET.has(entry.state))
    .map((entry) => `${entry.id} ${entry.state}`);
  if (invalidStates.length > 0) errors.push(`Invalid coverage states: ${invalidStates.join(", ")}.`);

  const missingIds = requirements
    .map((requirement) => requirement.id)
    .filter((id) => !entries.some((entry) => entry.id === id));
  if (missingIds.length > 0) errors.push(`Missing coverage IDs: ${missingIds.join(", ")}.`);

  const effectiveStates = new Map<string, CoverageState>();
  for (const entry of entries) {
    if (expected.has(entry.id) && COVERAGE_STATE_SET.has(entry.state) && !effectiveStates.has(entry.id)) {
      effectiveStates.set(entry.id, entry.state as CoverageState);
    }
  }

  return {
    valid: errors.length === 0,
    entries,
    errors: [...new Set(errors)],
    coverageEntries: effectiveStates.size,
    confirmed: [...effectiveStates.values()].filter((state) => state === "CONFIRMED").length,
    notConfirmed: [...effectiveStates.values()].filter((state) => state === "NOT_CONFIRMED").length,
    notInvestigated: [...effectiveStates.values()].filter((state) => state === "NOT_INVESTIGATED").length,
  };
}

export function stripCoverageTrailer(report: string): string {
  const trailer = findFinalCoverageTrailer(report);
  if (!trailer) return report.trim();
  return `${report.slice(0, trailer.start)}${report.slice(trailer.end)}`.trim();
}

function recordCoverageTelemetry(
  telemetry: ExplorerTelemetry,
  requirements: ExplicitRequirement[],
  validation: CoverageValidation,
  repair: boolean,
): void {
  telemetry.requirements = requirements.length;
  telemetry.confirmed = validation.confirmed;
  telemetry.notConfirmed = validation.notConfirmed;
  telemetry.notInvestigated = validation.notInvestigated;
  telemetry.coverageEntries = validation.coverageEntries;
  telemetry.coverageValid = validation.valid;
  telemetry.coverageRepair = repair;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1_000) return String(Math.round(value));
  if (value < 100_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  return `$${value.toFixed(4)}`;
}

function formatStatusElapsed(elapsedMs: number, precise = false): string {
  const seconds = Math.max(0, elapsedMs) / 1_000;
  return precise ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds)}s`;
}

class ExplorerStatus {
  private telemetry: ExplorerTelemetry | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private clearTimer: ReturnType<typeof setTimeout> | undefined;
  private finalizing = false;
  private disposed = false;

  constructor(
    private readonly ctx: ExtensionContext,
    private readonly startedAt: number,
    private readonly maxTurns: number,
  ) {}

  start(): void {
    if (this.disposed) return;
    this.renderRunning();
    this.refreshTimer = setInterval(() => this.renderRunning(), STATUS_REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  update(telemetry: ExplorerTelemetry): void {
    if (this.disposed) return;
    this.telemetry = telemetry;
    this.renderRunning();
  }

  setFinalizing(): void {
    if (this.disposed) return;
    this.finalizing = true;
    this.renderRunning();
  }

  finish(telemetry: ExplorerTelemetry): void {
    if (this.disposed) return;
    this.telemetry = telemetry;
    this.stopRefresh();

    const tokens = telemetry.input > 0 ? ` · ${formatTokens(telemetry.input)}` : "";
    const status = telemetry.termination === "completed"
      ? this.statusText("success", "✓", ` explore-fast · ${telemetry.turns}t${tokens} · ${formatStatusElapsed(telemetry.elapsedMs, true)}`)
      : telemetry.termination === "budget-finalized"
        ? this.statusText("success", "✓", ` explore-fast · ${telemetry.turns}t${tokens} · budget-finalized · ${formatStatusElapsed(telemetry.elapsedMs, true)}`)
        : telemetry.termination === "timeout"
          ? this.statusText("warning", "!", ` explore-fast · timeout · ${formatStatusElapsed(telemetry.elapsedMs)}`)
          : this.statusText("error", "!", " explore-fast · error");
    this.set(status);
    this.clearTimer = setTimeout(() => this.dispose(), STATUS_CLEAR_DELAY_MS);
    this.clearTimer.unref?.();
  }

  fail(): void {
    if (this.disposed) return;
    this.stopRefresh();
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.set(this.statusText("error", "!", " explore-fast · error"));
    this.clearTimer = setTimeout(() => this.dispose(), STATUS_CLEAR_DELAY_MS);
    this.clearTimer.unref?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopRefresh();
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = undefined;
    this.set(undefined);
    if (activeStatus === this) activeStatus = undefined;
  }

  private renderRunning(): void {
    const elapsedMs = Date.now() - this.startedAt;
    const turns = this.telemetry?.turns ?? 0;
    const tokens = this.telemetry && this.telemetry.input > 0 ? ` · ${formatTokens(this.telemetry.input)}` : "";
    const label = this.finalizing
      ? ` explore-fast · finalizing · ${formatStatusElapsed(elapsedMs)} · t${turns}/${this.maxTurns}`
      : ` explore-fast · ${formatStatusElapsed(elapsedMs)} · t${turns}/${this.maxTurns}${tokens}`;
    this.set(this.statusText("accent", "●", label));
  }

  private statusText(color: "accent" | "success" | "warning" | "error", icon: string, text: string): string {
    return this.ctx.ui.theme.fg(color, icon) + this.ctx.ui.theme.fg("dim", text);
  }

  private set(text: string | undefined): void {
    try {
      if (this.ctx.hasUI) this.ctx.ui.setStatus(STATUS_KEY, text);
    } catch {
      // The session may have been shut down or reloaded; cleanup remains best effort.
    }
  }

  private stopRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }
}

function formatTelemetryLine(telemetry: ExplorerTelemetry): string {
  const cached = telemetry.cacheRead > 0 ? ` · ${formatTokens(telemetry.cacheRead)} cached` : "";
  const finalization = telemetry.finalizationTrigger ? ` · finalized:${telemetry.finalizationTrigger}` : "";
  return `explore-fast: ${telemetry.turns} turns · ${formatTokens(telemetry.input)} in · ${formatTokens(telemetry.output)} out${cached} · ${(
    telemetry.elapsedMs / 1_000
  ).toFixed(1)}s · ${formatCost(telemetry.cost)} · ${telemetry.toolCalls}/${telemetry.toolLimit} tools${finalization} · ${telemetry.termination}`;
}

function formatCoverageTelemetry(telemetry: ExplorerTelemetry): string[] {
  if (telemetry.requirements === undefined) return [];
  return [
    `requirements: ${telemetry.requirements}`,
    `confirmed: ${telemetry.confirmed ?? 0}`,
    `not_confirmed: ${telemetry.notConfirmed ?? 0}`,
    `not_investigated: ${telemetry.notInvestigated ?? 0}`,
    `coverage_entries: ${telemetry.coverageEntries ?? 0}/${telemetry.requirements}`,
    `coverage_valid: ${telemetry.coverageValid ? "yes" : "no"}`,
    `coverage_repair: ${telemetry.coverageRepair ? "yes" : "no"}`,
  ];
}

function formatTelemetryDetails(telemetry: ExplorerTelemetry): string {
  return [
    formatTelemetryLine(telemetry),
    `model: ${telemetry.model}`,
    `thinking: ${telemetry.thinking}`,
    `cache write: ${formatTokens(telemetry.cacheWrite)}`,
    ...formatCoverageTelemetry(telemetry),
  ].join("\n");
}

function extractText(message: any): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim();
}

function hasToolCall(message: any): boolean {
  return Boolean(
    message &&
      Array.isArray(message.content) &&
      message.content.some((part: any) => part?.type === "toolCall"),
  );
}

function isUsableReportMessage(message: any, text: string): boolean {
  return Boolean(
    text &&
      !hasToolCall(message) &&
      (!message.stopReason || ["stop", "end"].includes(message.stopReason)),
  );
}

function addUsage(telemetry: ExplorerTelemetry, usage: any): void {
  if (!usage || typeof usage !== "object") return;
  telemetry.input += Number(usage.input) || 0;
  telemetry.output += Number(usage.output) || 0;
  telemetry.cacheRead += Number(usage.cacheRead) || 0;
  telemetry.cacheWrite += Number(usage.cacheWrite) || 0;
  telemetry.cost += Number(usage.cost?.total) || 0;
}

function getPiInvocation(args: string[]): PiInvocation {
  const override = process.env.PI_FAST_EXPLORER_PI_BINARY?.trim();
  if (override) return { command: override, args };

  // Match the installed Pi subagent example: invoke the current Pi script when
  // running under Bun/Node, and fall back to the pi executable otherwise.
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const executableName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executableName)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

function killProcess(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const hardKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best effort; the close handler will report the failure.
      }
    }
  }, 2_000);
  hardKill.unref();
}

function truncateReport(report: string): string {
  const trimmed = report.trim();
  if (trimmed.length <= MAX_REPORT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_REPORT_CHARS)}\n\n[explorer report truncated]`;
}

/**
 * The only explorer content that enters parent session context: an explicit
 * handoff containing the original task plus the child's already-compressed
 * final report. Tool calls, search output, file contents, and telemetry stay
 * out.
 */
export function buildParentHandoff(question: string, report: string): string {
  return [
    "[pi-fast-explorer]",
    "",
    "Exploration for the current user request is complete.",
    "",
    "Answer the user's original request now, using the findings below as evidence.",
    "Produce the actual final answer to the user.",
    "",
    "Do not merely acknowledge this report.",
    "Do not summarize the exploration process unless relevant to the answer.",
    "Do not ask what to do next if the original request can now be answered.",
    "",
    "Original task:",
    question.trim(),
    "",
    "Findings:",
    stripCoverageTrailer(report),
  ].join("\n");
}

/**
 * Minimal failure marker for genuinely failed runs (timeout / error / turn
 * budget without a report). No diagnostics or child output are persisted.
 */
function buildFailureContent(termination: TerminationReason): string {
  const reason = termination === "timeout"
    ? "timeout"
    : termination === "turn budget"
      ? "turn budget exhausted"
      : "error";
  return `[pi-fast-explorer]\nExploration failed: ${reason} before a usable report was produced.`;
}

interface SessionFlushTarget {
  getSessionFile(): string | undefined;
  appendMessage(message: {
    role: "assistant";
    content: { type: "text"; text: string }[];
    api: string;
    provider: string;
    model: string;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    };
    stopReason: "stop";
    timestamp: number;
  }): string;
}

/**
 * Failure-only durability fallback. Pi 0.84.3 defers creating a fresh session
 * file until an assistant message exists. Successful runs do not use this:
 * their genuine parent assistant response naturally flushes the handoff.
 */
function persistExplorerFailure(ctx: any): void {
  try {
    const sm = ctx.sessionManager as SessionFlushTarget;
    const file = sm.getSessionFile();
    if (!file || fs.existsSync(file)) return;
    const model = ctx.model;
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: model?.api ?? "unknown",
      provider: model?.provider ?? "unknown",
      model: model?.id ?? "unknown",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
  } catch {
    // Best effort: the custom message above still renders in the live session.
  }
}

export function buildChildPrompt(
  cwd: string,
  question: string,
  requirements: ExplicitRequirement[] = [],
  maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
): string {
  const coverageInstructions = buildCoverageInstructions(requirements);
  return [
    `Repository path: ${cwd}`,
    `Repository tool-call ceiling: ${maxToolCalls}. An already-issued batch may finish before finalization.`,
    "",
    "Delegated question:",
    question,
    ...(coverageInstructions.length > 0 ? ["", ...coverageInstructions] : []),
    "",
    "Do not modify anything. Return the requested compact report directly; do not explain routine tool use.",
  ].join("\n");
}

const COVERAGE_REPAIR_SYSTEM_PROMPT = `You repair the structure of a repository exploration report.

Use only the current report and evidence already present in it. Do not research,
call tools, infer new facts, or add unsupported conclusions. Preserve the useful
human-readable prose, then append exactly one machine-readable coverage block.
Append exactly one protocol coverage trailer as the final non-whitespace content
of the response. The closing [/COVERAGE] marker must be the final non-whitespace
content. Do not place prose after the trailer. Earlier literal [COVERAGE] or
[/COVERAGE] text in the report is ordinary prose and must not be treated as
metadata.
Account for every required ID exactly once using only CONFIRMED,
NOT_CONFIRMED, or NOT_INVESTIGATED. Mark NOT_INVESTIGATED when the report does
not contain evidence that the item was investigated. Return only the rewritten
report.`;

interface CoverageRepairResult {
  report: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  };
}

function buildCoverageRepairPrompt(
  requirements: ExplicitRequirement[],
  report: string,
  errors: string[],
): string {
  return [
    "Structural coverage repair is required.",
    "",
    "Exact validation errors:",
    ...errors.map((error) => `- ${error}`),
    "",
    "Required IDs:",
    ...requirements.map((requirement) => `[${requirement.id}] ${requirement.text}`),
    "",
    "Current report:",
    report,
    "",
    "Rewrite the final report using only evidence already gathered in the current report.",
    "Do not perform additional research.",
    "Account for every required ID.",
    "If evidence for an item was not gathered, mark it NOT_INVESTIGATED.",
    "Append exactly one protocol coverage trailer as the final non-whitespace content of the response.",
    "The closing [/COVERAGE] marker must be the final non-whitespace content.",
    "Do not place prose after the trailer.",
    "Earlier literal [COVERAGE] or [/COVERAGE] text in the report is ordinary prose and must not be treated as metadata.",
    "The report must end with exactly one block in this format:",
    COVERAGE_OPEN,
    ...requirements.map((requirement) => `${requirement.id} <one allowed state>`),
    COVERAGE_CLOSE,
    "Replace the placeholder with exactly one allowed state; do not output placeholders.",
  ].join("\n");
}

async function runCoverageRepair(
  cwd: string,
  requirements: ExplicitRequirement[],
  report: string,
  errors: string[],
  model: string,
  thinking: string,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<CoverageRepairResult> {
  const args = [
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-builtin-tools",
    "--model",
    model,
    "--thinking",
    thinking,
    "--system-prompt",
    COVERAGE_REPAIR_SYSTEM_PROMPT,
    "--append-system-prompt",
    "",
    "--",
    buildCoverageRepairPrompt(requirements, report, errors),
  ];
  const invocation = getPiInvocation(args);
  const env = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    PI_FAST_EXPLORER_CHILD: "1",
    PI_FAST_EXPLORER_REQUIREMENT_IDS: requirements.map((requirement) => requirement.id).join(","),
  };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

  return await new Promise<CoverageRepairResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ report: "", usage });
      return;
    }

    activeChild = child;
    let stdoutBuffer = "";
    let latestText = "";
    let timedOut = false;
    let abortedByParent = false;
    let settled = false;

    const processEvent = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      const eventUsage = event.message.usage;
      if (eventUsage && typeof eventUsage === "object") {
        usage.input += Number(eventUsage.input) || 0;
        usage.output += Number(eventUsage.output) || 0;
        usage.cacheRead += Number(eventUsage.cacheRead) || 0;
        usage.cacheWrite += Number(eventUsage.cacheWrite) || 0;
        usage.cost += Number(eventUsage.cost?.total) || 0;
      }
      const text = extractText(event.message);
      if (text && !hasToolCall(event.message)) latestText = text;
    };

    child.stdout?.on("data", (data: Buffer | string) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) processEvent(line);
    });
    child.stderr?.resume();

    const timeout = setTimeout(() => {
      timedOut = true;
      killProcess(child);
    }, Math.min(timeoutMs, COVERAGE_REPAIR_TIMEOUT_MS));

    const abortHandler = () => {
      abortedByParent = true;
      killProcess(child);
    };
    if (parentSignal) {
      if (parentSignal.aborted) abortHandler();
      else parentSignal.addEventListener("abort", abortHandler, { once: true });
    }

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = undefined;
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortHandler);
      if (stdoutBuffer.trim()) processEvent(stdoutBuffer);
      if (timedOut || abortedByParent || exitCode !== 0 || signal) latestText = "";
      resolve({ report: truncateReport(latestText), usage });
    };

    child.once("error", () => finish(1, null));
    child.once("close", finish);
  });
}

async function runExplorer(
  cwd: string,
  question: string,
  requirements: ExplicitRequirement[] = [],
  parentSignal?: AbortSignal,
  onTelemetry?: (telemetry: ExplorerTelemetry) => void,
  onActivity?: (activity: ExplorerActivity) => void,
  onFinalizing?: () => void,
): Promise<ExplorerResult> {
  const startedAt = Date.now();
  const model = process.env.PI_FAST_EXPLORER_MODEL?.trim() || DEFAULT_MODEL;
  const thinking = process.env.PI_FAST_EXPLORER_THINKING?.trim() || DEFAULT_THINKING;
  const maxTurns = boundedInteger(process.env.PI_FAST_EXPLORER_MAX_TURNS, DEFAULT_MAX_TURNS, 1, 8);
  const maxToolCalls = boundedInteger(
    process.env.PI_FAST_EXPLORER_MAX_TOOL_CALLS,
    DEFAULT_MAX_TOOL_CALLS,
    1,
    MAX_TOOL_CALLS,
  );
  const timeoutMs = boundedInteger(process.env.PI_FAST_EXPLORER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 15_000, 300_000);
  const telemetry: ExplorerTelemetry = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
    toolCalls: 0,
    toolLimit: maxToolCalls,
    elapsedMs: 0,
    model,
    thinking,
    termination: "error",
    ...(requirements.length > 0
      ? {
        requirements: requirements.length,
        confirmed: 0,
        notConfirmed: 0,
        notInvestigated: 0,
        coverageEntries: 0,
        coverageValid: false,
        coverageRepair: false,
      }
      : {}),
  };

  const args = [
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-builtin-tools",
    "--tools",
    "repo_search,repo_read,repo_list,repo_git",
    "--model",
    model,
    "--thinking",
    thinking,
    "--system-prompt",
    EXPLORER_SYSTEM_PROMPT,
    // An explicitly empty append list prevents a user's global APPEND_SYSTEM.md
    // from being discovered and keeps the child prompt limited to this worker.
    "--append-system-prompt",
    "",
    "--extension",
    CHILD_EXTENSION,
    "--",
    buildChildPrompt(cwd, question, requirements, maxToolCalls),
  ];

  const invocation = getPiInvocation(args);
  const env = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    PI_FAST_EXPLORER_CHILD: "1",
    PI_FAST_EXPLORER_MAX_TURNS: String(maxTurns),
    PI_FAST_EXPLORER_MAX_TOOL_CALLS: String(maxToolCalls),
    PI_FAST_EXPLORER_REQUIREMENT_IDS: requirements.map((requirement) => requirement.id).join(","),
  };

  return await new Promise<ExplorerResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      telemetry.elapsedMs = Date.now() - startedAt;
      telemetry.termination = "error";
      resolve({
        report: `Conclusion:\nExplorer could not start.\n\nEvidence:\n- ${error instanceof Error ? error.message : String(error)}`,
        telemetry,
      });
      return;
    }

    activeChild = child;

    let stdoutBuffer = "";
    let stderr = "";
    let latestText = "";
    let terminalText = "";
    let finalizationText = "";
    let lastStopReason = "";
    let finalizingEngaged = false;
    let finalizationTurnActive = false;
    let finalizationTurnObserved = false;
    let turnStartsSeen = 0;
    let finalizationTrigger: "turn" | "tools" | undefined;
    let timedOut = false;
    let abortedByParent = false;
    let settled = false;

    const processEvent = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (event.type === "turn_start") {
        // Pi emits turn_start on the JSON stream after extension turn_start
        // handlers have run and before the corresponding message_end. Use that
        // ordered stream event to classify the synthesis turn even if the
        // separate stderr marker is delivered later by the parent OS pipe.
        const turnIndex = turnStartsSeen;
        turnStartsSeen += 1;
        finalizationTurnActive =
          turnIndex >= maxTurns - 1 || telemetry.toolCalls >= maxToolCalls;
        if (finalizationTurnActive) finalizationTurnObserved = true;
        return;
      }

      if (event.type === "turn_end") {
        finalizationTurnActive = false;
        return;
      }

      if (event.type === "tool_execution_start") {
        const activity = explorerActivityFromTool(event.toolName);
        if (activity) onActivity?.(activity);
        return;
      }

      if (event.type === "message_end" && event.message?.role === "assistant") {
        const message = event.message;
        telemetry.turns += 1;
        telemetry.toolCalls += Array.isArray(message.content)
          ? message.content.filter((part: any) => part?.type === "toolCall").length
          : 0;
        addUsage(telemetry, message.usage);
        if (typeof message.stopReason === "string") lastStopReason = message.stopReason;
        onTelemetry?.(telemetry);

        const toolCall = Array.isArray(message.content)
          ? message.content.find((part: any) => part?.type === "toolCall")
          : undefined;
        const activity = explorerActivityFromTool(toolCall?.name);
        if (activity) onActivity?.(activity);

        const text = extractText(message);
        if (text) {
          latestText = text;
          if (isUsableReportMessage(message, text)) {
            if (finalizationTurnActive) finalizationText = text;
            else terminalText = text;
          }
        }
      }
    };

    const consumeStdout = (data: Buffer | string) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) processEvent(line);
    };

    child.stdout?.on("data", consumeStdout);
    child.stderr?.on("data", (data: Buffer | string) => {
      stderr += data.toString();
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
      // The child writes this marker when the first finalization turn starts, so
      // the live UI can switch to the "finalizing" state before the run ends.
      if (stderr.includes(TOOL_FINALIZATION_MARKER)) finalizationTrigger = "tools";
      if (!finalizingEngaged && stderr.includes(FINALIZATION_MARKER)) {
        finalizingEngaged = true;
        onFinalizing?.();
      }
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      killProcess(child);
    }, timeoutMs);

    const abortHandler = () => {
      abortedByParent = true;
      killProcess(child);
    };
    if (parentSignal) {
      if (parentSignal.aborted) abortHandler();
      else parentSignal.addEventListener("abort", abortHandler, { once: true });
    }

    const finish = async (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = undefined;
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortHandler);
      if (stdoutBuffer.trim()) processEvent(stdoutBuffer);

      telemetry.elapsedMs = Date.now() - startedAt;
      // Finalization is identified from the marker or the ordered JSON turn
      // stream. A budget-finalized run may use only text from that actual
      // synthesis turn; ordinary completion keeps the existing terminal/latest
      // selection.
      const reachedBudgetBoundary = finalizingEngaged || finalizationTurnObserved || telemetry.turns >= maxTurns;
      if (reachedBudgetBoundary) telemetry.finalizationTrigger = finalizationTrigger ?? "turn";
      let report = truncateReport(reachedBudgetBoundary ? finalizationText : terminalText || latestText);

      if (timedOut) telemetry.termination = "timeout";
      else if (abortedByParent) telemetry.termination = "error";
      else if (reachedBudgetBoundary) telemetry.termination = report ? "budget-finalized" : "turn budget";
      else if (exitCode === 0 && report) telemetry.termination = "completed";
      else telemetry.termination = "error";

      const diagnostic = telemetry.termination === "completed" || telemetry.termination === "budget-finalized"
        ? undefined
        : (stderr.trim() || (signal ? `child terminated by ${signal}` : `child exited with code ${exitCode ?? "unknown"}`)).trim();

      if (requirements.length > 0 && report && (telemetry.termination === "completed" || telemetry.termination === "budget-finalized")) {
        let validation = validateCoverageReport(report, requirements);
        recordCoverageTelemetry(telemetry, requirements, validation, false);
        if (!validation.valid) {
          // Structural repair is deliberately a separate, no-tools, one-shot
          // call. It receives only the current report and exact local errors.
          const repair = await runCoverageRepair(
            cwd,
            requirements,
            report,
            validation.errors,
            model,
            thinking,
            timeoutMs,
            parentSignal,
          );
          telemetry.input += repair.usage.input;
          telemetry.output += repair.usage.output;
          telemetry.cacheRead += repair.usage.cacheRead;
          telemetry.cacheWrite += repair.usage.cacheWrite;
          telemetry.cost += repair.usage.cost;
          if (repair.report) report = repair.report;
          validation = validateCoverageReport(report, requirements);
          recordCoverageTelemetry(telemetry, requirements, validation, true);
        }
      }

      telemetry.elapsedMs = Date.now() - startedAt;
      const finalReport = report || [
        "Conclusion:",
        `Explorer ended without a final report (${telemetry.termination}).`,
        "",
        "Evidence:",
        `- ${diagnostic || "No child output was captured."}`,
      ].join("\n");
      onTelemetry?.(telemetry);
      resolve({ report: finalReport, telemetry, diagnostic });
    };

    child.once("error", (error) => {
      stderr += error instanceof Error ? error.message : String(error);
      finish(1, null);
    });
    child.once("close", finish);
  });
}

function notify(ctx: any, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
}

export default function piFastExplorer(pi: ExtensionAPI) {
  let runtimeActive = true;

  // Render visible explorer custom messages exactly once: the content's own
  // "[pi-fast-explorer]" header line is the label, followed by the report. The
  // successful handoff is contextual-only (`display: false`) so the user sees
  // the normal parent answer without a duplicate report.
  pi.registerMessageRenderer("pi-fast-explorer", (message, _options, theme) => {
    const content = typeof message.content === "string"
      ? message.content
      : message.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
    const newline = content.indexOf("\n");
    const headerLine = (newline === -1 ? content : content.slice(0, newline)).trim();
    const rest = newline === -1 ? "" : content.slice(newline + 1);

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    if (headerLine) {
      box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(headerLine)), 0, 0));
    }
    if (rest.trim()) {
      box.addChild(new Spacer(1));
      box.addChild(new Markdown(rest, 0, 0, getMarkdownTheme(), { color: (text) => theme.fg("customMessageText", text) }));
    }

    const component = new Container();
    component.addChild(new Spacer(1));
    component.addChild(box);
    return component;
  });

  pi.on("session_shutdown", () => {
    runtimeActive = false;
    activeStatus?.dispose();
    activeDungeon?.dispose();
    if (activeChild) killProcess(activeChild);
  });

  pi.registerCommand("explore-fast", {
    description: "Run a fresh, read-only, low-token repository explorer for a focused question",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (!question) {
        notify(ctx, "Usage: /explore-fast <focused repository question>", "warning");
        return;
      }
      if (question.length > MAX_QUESTION_CHARS) {
        notify(ctx, `Question is too long; limit is ${MAX_QUESTION_CHARS} characters.`, "warning");
        return;
      }

      const requirements = extractExplicitRequirements(question);
      activeStatus?.dispose();
      activeDungeon?.dispose();
      const maxTurns = boundedInteger(process.env.PI_FAST_EXPLORER_MAX_TURNS, DEFAULT_MAX_TURNS, 1, 8);
      const startedAt = Date.now();
      const status = ctx.hasUI ? new ExplorerStatus(ctx, startedAt, maxTurns) : undefined;
      const dungeon = ctx.mode === "tui" ? new DungeonWidget(ctx, startedAt, maxTurns) : undefined;
      activeStatus = status;
      activeDungeon = dungeon;
      status?.start();
      dungeon?.start();

      try {
        const run = await runExplorer(
          ctx.cwd,
          question,
          requirements,
          ctx.signal,
          (telemetry) => {
            status?.update(telemetry);
            dungeon?.update(telemetry.turns);
          },
          (activity) => dungeon?.setActivity(activity),
          () => {
            status?.setFinalizing();
            dungeon?.setFinalizing();
          },
        );
        if (!runtimeActive) return;

        lastTelemetry = run.telemetry;
        status?.finish(run.telemetry);
        const outcome: DungeonOutcome = run.telemetry.termination === "completed" || run.telemetry.termination === "budget-finalized"
          ? "completed"
          : run.telemetry.termination === "timeout"
            ? "timeout"
            : "error";
        dungeon?.finish(outcome);
        const okTermination = run.telemetry.termination === "completed" || run.telemetry.termination === "budget-finalized";
        const telemetryLine = formatTelemetryLine(run.telemetry);
        const handoffContent = okTermination
          ? buildParentHandoff(question, run.report)
          : buildFailureContent(run.telemetry.termination);

        if (okTermination) {
          // Inject only the compact handoff into parent context, then let Pi
          // run exactly one ordinary parent turn. The genuine assistant
          // response is also the normal session-persistence boundary.
          pi.sendMessage(
            {
              customType: "pi-fast-explorer",
              content: handoffContent,
              display: false,
              details: {
                telemetry: run.telemetry,
                question,
                termination: run.telemetry.termination,
              },
            },
            { triggerTurn: true },
          );
        } else {
          // A failed exploration must not trigger a bogus answer from absent
          // findings. Keep the compact failure marker visible and durable.
          pi.sendMessage(
            {
              customType: "pi-fast-explorer",
              content: handoffContent,
              display: true,
              details: {
                telemetry: run.telemetry,
                question,
                termination: run.telemetry.termination,
              },
            },
            { triggerTurn: false },
          );
          persistExplorerFailure(ctx);
        }
        notify(ctx, telemetryLine, okTermination ? "info" : "warning");
      } catch (error) {
        if (!runtimeActive) return;
        status?.fail();
        dungeon?.fail();
        notify(ctx, `explore-fast failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("explore-fast-stats", {
    description: "Show telemetry for the last explore-fast invocation",
    handler: async (_args, ctx) => {
      if (!lastTelemetry) {
        notify(ctx, "No explore-fast invocation has run in this Pi process.", "info");
        return;
      }
      notify(ctx, formatTelemetryDetails(lastTelemetry), "info");
    },
  });
}
