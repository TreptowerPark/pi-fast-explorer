import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_SEARCH_CHARS = 12_000;
const MAX_LIST_CHARS = 8_000;
const MAX_READ_LINES = 220;
const COMMAND_TIMEOUT_MS = 8_000;

function clip(text: string, maxChars: number, maxLines = 180): string {
  const lines = text.split(/\r?\n/);
  const selected = lines.slice(0, maxLines);
  let output = "";
  for (const line of selected) {
    const next = output ? `${output}\n${line}` : line;
    if (next.length > maxChars) {
      const remaining = Math.max(0, maxChars - output.length);
      output += `${output ? "\n" : ""}${line.slice(0, remaining)}`;
      return `${output}\n[output truncated]`;
    }
    output = next;
  }
  if (lines.length > selected.length) output += `\n[${lines.length - selected.length} more lines omitted]`;
  return output;
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

interface RepoTarget {
  root: string;
  path: string;
  realPath: string;
}

async function resolveTarget(ctx: ExtensionContext, requestedPath: string | undefined): Promise<RepoTarget> {
  const root = await fs.realpath(ctx.cwd);
  const input = (requestedPath || ".").replace(/^@/, "");
  if (input.includes("\0")) throw new Error("Path contains a NUL byte.");

  const lexicalPath = resolve(root, input);
  if (!inside(root, lexicalPath)) throw new Error("Path must stay inside the repository root.");

  const realPath = await fs.realpath(lexicalPath);
  if (!inside(root, realPath)) throw new Error("Symlink target must stay inside the repository root.");

  return {
    root,
    path: relative(root, realPath) || ".",
    realPath,
  };
}

function result(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function errorResult(message: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text: `Explorer tool error: ${message}` }],
    details: { ...details, error: message },
    isError: true,
  };
}

const SearchParameters = Type.Object({
  query: Type.String({ description: "A narrow symbol, filename, or regex to search for." }),
  path: Type.Optional(Type.String({ description: "Repository-relative directory or file. Defaults to the repository root." })),
  glob: Type.Optional(Type.String({ description: "Optional ripgrep glob, for example **/*.{ts,tsx}." })),
  fixed: Type.Optional(Type.Boolean({ description: "Treat query as a literal string instead of a regex." })),
  hidden: Type.Optional(Type.Boolean({ description: "Include hidden files when needed." })),
});

const ReadParameters = Type.Object({
  path: Type.String({ description: "Repository-relative file path." }),
  startLine: Type.Optional(Type.Integer({ minimum: 1, description: "First 1-based line to return. Defaults to 1." })),
  endLine: Type.Optional(Type.Integer({ minimum: 1, description: "Last 1-based line to return. Defaults to a short range." })),
});

const ListParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "Repository-relative directory. Defaults to the repository root." })),
  pattern: Type.Optional(Type.String({ description: "Optional filename pattern or regex." })),
  maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 6, description: "Maximum directory depth. Defaults to 3." })),
  hidden: Type.Optional(Type.Boolean({ description: "Include hidden files when needed." })),
});

const GitParameters = Type.Object({
  operation: Type.Union([
    Type.Literal("status"),
    Type.Literal("log"),
    Type.Literal("diff-stat"),
  ], { description: "The read-only git inspection to perform." }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "Maximum log entries when operation is log." })),
});

export default function fastExplorerChild(pi: ExtensionAPI) {
  // Keep even read-only git inspection from refreshing the repository index.
  process.env.GIT_OPTIONAL_LOCKS = "0";

  pi.registerTool({
    name: "repo_search",
    label: "Repository Search",
    description: "Read-only narrow repository search backed by rg, with git grep fallback. Output is capped and includes line numbers.",
    parameters: SearchParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const target = await resolveTarget(ctx, params.path);
        const args = [
          "--no-heading",
          "--line-number",
          "--color",
          "never",
          "--max-count",
          "80",
          "--max-columns",
          "240",
        ];
        if (params.fixed) args.push("--fixed-strings");
        if (params.hidden) args.push("--hidden");
        if (params.glob) args.push("--glob", params.glob);
        args.push("--", params.query, target.path);

        let backend = "rg";
        let command = await pi.exec("rg", args, {
          cwd: target.root,
          signal,
          timeout: COMMAND_TIMEOUT_MS,
        });

        if (command.code === 127 || command.code === -1) {
          backend = "git grep";
          command = await pi.exec("git", ["grep", "-n", "--no-color", "-e", params.query, "--", target.path], {
            cwd: target.root,
            signal,
            timeout: COMMAND_TIMEOUT_MS,
          });
        }

        if (command.code !== 0 && command.code !== 1) {
          return errorResult(command.stderr.trim() || `${backend} exited with code ${command.code}`, {
            backend,
            path: target.path,
          });
        }

        const output = command.stdout.trim();
        const text = output
          ? `Search (${backend}) ${params.query} in ${target.path}\n${clip(output, MAX_SEARCH_CHARS)}`
          : `Search (${backend}) ${params.query} in ${target.path}\n(no matches)`;
        return result(text, { backend, path: target.path, matched: Boolean(output) });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });

  pi.registerTool({
    name: "repo_read",
    label: "Repository Read",
    description: "Read-only targeted line range from one repository file. Keep ranges small; output is line-numbered and capped.",
    parameters: ReadParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const target = await resolveTarget(ctx, params.path);
        const stat = await fs.stat(target.realPath);
        if (!stat.isFile()) return errorResult(`${params.path} is not a regular file.`);

        const start = params.startLine ?? 1;
        const requestedEnd = params.endLine ?? start + 119;
        if (start < 1 || requestedEnd < start) return errorResult("Invalid line range.");
        const end = Math.min(requestedEnd, start + MAX_READ_LINES - 1);

        const sed = await pi.exec("sed", ["-n", `${start},${end}p`, "--", target.path], {
          cwd: target.root,
          signal,
          timeout: COMMAND_TIMEOUT_MS,
        });
        if (sed.code !== 0) {
          return errorResult(sed.stderr.trim() || `sed exited with code ${sed.code}`, { path: target.path });
        }

        const rawLines = sed.stdout.replace(/\n$/, "").split(/\r?\n/);
        const numbered = rawLines
          .filter((line, index) => !(rawLines.length === 1 && line === "" && index === 0))
          .map((line, index) => `${start + index}| ${line}`)
          .join("\n");
        const suffix = requestedEnd > end ? `\n[range capped at ${MAX_READ_LINES} lines]` : "";
        return result(`Read ${target.path}:${start}-${Math.min(end, start + rawLines.length - 1)}\n${clip(numbered, MAX_SEARCH_CHARS, MAX_READ_LINES)}${suffix}`, {
          path: target.path,
          startLine: start,
          endLine: end,
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });

  pi.registerTool({
    name: "repo_list",
    label: "Repository Files",
    description: "Read-only shallow file listing backed by find. Use only when search does not identify a path.",
    parameters: ListParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const target = await resolveTarget(ctx, params.path);
        const maxDepth = params.maxDepth ?? 3;
        const args = [target.path, "-maxdepth", String(maxDepth), "-type", "f", "-print"];
        const command = await pi.exec("find", args, {
          cwd: target.root,
          signal,
          timeout: COMMAND_TIMEOUT_MS,
        });
        if (command.code !== 0) {
          return errorResult(command.stderr.trim() || `find exited with code ${command.code}`, { path: target.path });
        }

        let output = command.stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .filter((line) => params.hidden || !line.split("/").some((part) => part.startsWith(".") && part !== "."))
          .filter((line) => !params.pattern || new RegExp(params.pattern, "i").test(line))
          .slice(0, 120)
          .join("\n");
        if (!output) output = "(no files found)";
        return result(`Files under ${target.path} (depth ${maxDepth})\n${clip(output, MAX_LIST_CHARS, 140)}`, {
          path: target.path,
          maxDepth,
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });

  pi.registerTool({
    name: "repo_git",
    label: "Repository Git",
    description: "Read-only git status, recent log, or diff summary. No arbitrary git arguments are accepted.",
    parameters: GitParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const args = params.operation === "status"
          ? ["status", "--short", "--branch"]
          : params.operation === "log"
            ? ["log", "--oneline", "--decorate", "-n", String(params.limit ?? 10)]
            : ["diff", "--stat"];
        const command = await pi.exec("git", args, {
          cwd: ctx.cwd,
          signal,
          timeout: COMMAND_TIMEOUT_MS,
        });
        if (command.code !== 0) {
          return errorResult(command.stderr.trim() || `git exited with code ${command.code}`, { operation: params.operation });
        }
        return result(`git ${params.operation}\n${clip(command.stdout.trim() || "(no output)", MAX_LIST_CHARS, 120)}`, {
          operation: params.operation,
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });

  // Turn budget: investigation allowance + reserved synthesis turn.
  //
  // Pi 0.84.3 event semantics that shape this design:
  // - turn_start (turnIndex, 0-based) fires immediately before each assistant LLM
  //   call. The first turn_start (index 0) is emitted by runAgentLoop before the
  //   user prompt events; later ones fire at the top of each agent-loop iteration.
  //   Assistant turn N has turnIndex N-1.
  // - turn_end (turnIndex) fires after the assistant message and its tool results
  //   complete. Assistant turn N has turnIndex N-1.
  // - ctx.abort() aborts the run's AbortSignal, but the agent loop does not consult
  //   the signal when deciding to continue: after a turn whose message contained
  //   tool calls, the loop always starts another turn, and the aborted provider call
  //   produces a synthetic assistant message_end (empty text, stopReason "aborted").
  //   That is the old 5-vs-6 off-by-one: aborting at turn_end of turn 5 still
  //   emitted a 6th, empty assistant message that the parent counted as a turn.
  //
  // Instead of aborting, the final turn is reserved for synthesis:
  // - turns 1..(maxTurns-1) are investigation turns; tools stay available.
  // - the last turn (turnIndex === finalTurnIndex) is the reserved synthesis turn.
  //   When it starts:
  //   1. a stderr marker tells the parent finalization has engaged;
  //   2. the context event appends the finalize instruction to the LLM context;
  //   3. before_provider_request strips tools from the provider payload, so the
  //      model mechanically cannot call any tool during the final turn;
  //   4. tool_call blocks any tool call that somehow still occurs. The block is
  //      non-terminating during the reserved turn (the model gets one more chance
  //      to write the report) and terminating from the next turn on (the tool batch
  //      ends, so the loop can never run past maxTurns+1 turns).
  // The run then ends naturally after the final text-only message: exactly maxTurns
  // assistant message_end events, no synthetic aborted message, no off-by-one.
  let finalizing = false;
  let hardFinalizing = false;
  let finalizationMarkerWritten = false;
  const maxTurns = Number.parseInt(process.env.PI_FAST_EXPLORER_MAX_TURNS ?? "5", 10);
  const hardTurnLimit = Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : 5;
  const finalTurnIndex = hardTurnLimit - 1;

  const FINALIZATION_MARKER = "PI_FAST_EXPLORER_FINALIZATION=1";
  const coverageRequirementIds = (process.env.PI_FAST_EXPLORER_REQUIREMENT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const FINALIZE_INSTRUCTION = [
    "Exploration budget reached.",
    "",
    "Do not call any more tools.",
    "",
    "Using only the evidence already gathered, produce the final report now.",
    "",
    "Give the best evidence-backed answer possible.",
    "Clearly mark any requested point that remains uncertain.",
    "Do not apologize, narrate the budget, or request another run.",
    ...(coverageRequirementIds.length > 0
      ? [
        "",
        "The delegated question contains explicit coverage requirements.",
        "Keep the useful prose report, then append exactly one coverage trailer.",
        "The trailer must contain every required ID exactly once and no unknown IDs.",
        "Use only CONFIRMED, NOT_CONFIRMED, or NOT_INVESTIGATED.",
        "[COVERAGE]",
        ...coverageRequirementIds.map((id) => `${id} <one allowed state>`),
        "[/COVERAGE]",
        "Replace the placeholder with exactly one allowed state; do not output placeholders.",
      ]
      : []),
  ].join("\n");
  const TOOL_BLOCK_REASON = "Exploration budget reached: tools are disabled for the final synthesis turn.";

  pi.on("turn_start", (event) => {
    if (event.turnIndex < finalTurnIndex) return;
    finalizing = true;
    if (event.turnIndex > finalTurnIndex) {
      // The reserved synthesis turn was already consumed and the model still wants
      // another turn. Terminate any tool batch from here on so the loop cannot
      // continue past maxTurns+1 turns.
      hardFinalizing = true;
      return;
    }
    if (!finalizationMarkerWritten) {
      finalizationMarkerWritten = true;
      process.stderr.write(`${FINALIZATION_MARKER}\n`);
    }
  });

  pi.on("context", (event) => {
    if (!finalizing) return;
    // Append the finalize instruction as the latest user message. The context event
    // operates on a deep copy consumed only by this LLM call, so re-injecting on a
    // (pathological) extra finalizing call is both harmless and intended.
    return {
      messages: [
        ...event.messages,
        { role: "user", content: [{ type: "text", text: FINALIZE_INSTRUCTION }], timestamp: Date.now() },
      ],
    };
  });

  pi.on("before_provider_request", (event) => {
    if (!finalizing) return;
    const payload = event.payload as Record<string, unknown> | null | undefined;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    // Mechanically remove every tool from the outgoing provider request, so the
    // model cannot emit a tool call during the reserved synthesis turn.
    if ("tools" in payload) delete payload.tools;
    if ("tool_choice" in payload) payload.tool_choice = "none";
    return payload;
  });

  pi.on("tool_call", () => {
    if (!finalizing) return;
    return { block: true, reason: TOOL_BLOCK_REASON, terminate: hardFinalizing };
  });
}
