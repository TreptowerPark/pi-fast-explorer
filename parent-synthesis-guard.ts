import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TOOL_PAYLOAD_KEYS = [
  "tools",
  "tool_choice",
  "toolChoice",
  "tool_config",
  "toolConfig",
  "functions",
  "function_call",
  "functionCall",
  "additional_tools",
];

type GuardPhase = "idle" | "pending" | "active";

function stripToolFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripToolFields);
  if (!value || typeof value !== "object") return value;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (TOOL_PAYLOAD_KEYS.includes(key)) continue;
    result[key] = stripToolFields(child);
  }
  return result;
}

export interface ParentSynthesisGuard {
  arm(): void;
  cancel(): void;
}

/**
 * Guard the one parent turn started by a successful explorer handoff.
 *
 * The provider-request hook removes every provider-visible tool definition for
 * the turn. The tool_call hook is a narrow defensive fallback; the configured
 * parent tool list itself is never changed.
 */
export function installParentSynthesisGuard(pi: ExtensionAPI): ParentSynthesisGuard {
  let phase: GuardPhase = "idle";

  const clear = (): void => {
    phase = "idle";
  };

  pi.on("turn_start", () => {
    if (phase === "pending") phase = "active";
  });

  pi.on("before_provider_request", (event) => {
    if (phase === "idle") return;

    // A provider request is the final lifecycle boundary before the guarded
    // model turn. This also covers a provider implementation that reaches the
    // request hook without emitting the expected turn_start first.
    phase = "active";

    const payload = event.payload as Record<string, unknown> | null | undefined;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;

    return stripToolFields(payload);
  });

  pi.on("tool_call", () => {
    if (phase !== "active") return;
    return {
      block: true,
      reason: "Explorer synthesis turn: parent tools are disabled.",
      terminate: true,
    };
  });

  // turn_end is the exact end of the one guarded model turn. Clear before Pi
  // decides whether any later queued turn should start.
  pi.on("turn_end", () => {
    if (phase === "active") clear();
  });

  // Covers aborts/errors and also a failed send that entered _runAgentPrompt
  // but never reached a provider request.
  pi.on("agent_settled", () => {
    if (phase !== "idle") clear();
  });

  // sendMessage() is fire-and-forget in the extension API. If it fails before
  // starting an agent run, the next real input must not inherit the pending
  // guard. This is lifecycle-based cleanup, not a timeout heuristic.
  pi.on("input", (_event, ctx) => {
    if (phase === "pending" && ctx.isIdle()) clear();
  });

  pi.on("session_shutdown", () => {
    if (phase !== "idle") clear();
  });

  return {
    arm(): void {
      if (phase !== "idle") return;
      phase = "pending";
    },
    cancel(): void {
      if (phase !== "idle") clear();
    },
  };
}
