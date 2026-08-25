import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

const WIDGET_KEY = "explore-fast-dungeon";
const FRAME_INTERVAL_MS = 320;
const FINISH_CLEAR_DELAY_MS = 1_600;
const MIN_ART_WIDTH = 42;

export type DungeonOutcome = "completed" | "budget-finalized" | "timeout" | "error";
export type ExplorerActivity = "search" | "read" | "list" | "git" | "thinking" | "working";

type DungeonState = "running" | "completed" | "timeout" | "error";

const RUNNING_FRAMES = [
  [
    "       ▓▓╲               ╱▓▓",
    "       ▓▒ ╲      ·      ╱ ▒▓",
    "       ▓▒  ╲    ░░░    ╱  ▒▓",
    "       ▓▒   ╲  ░ █ ░  ╱   ▒▓",
    "       ▓▓──────╲▓▓▓╱──────▓▓",
  ],
  [
    "       ▓▓╲               ╱▓▓",
    "       ▓▒ ╲     ··      ╱ ▒▓",
    "       ▓▒  ╲   ░░░░    ╱  ▒▓",
    "       ▓▒   ╲  ░ █ ░  ╱   ▒▓",
    "       ▓▓─────╲▓▓▓▓╱─────▓▓",
  ],
  [
    "       ▓▓╲               ╱▓▓",
    "       ▓▒ ╲      ·      ╱ ▒▓",
    "       ▓▒  ╲    ░█░    ╱  ▒▓",
    "       ▓▒   ╲  ░░█░░  ╱   ▒▓",
    "       ▓▓────╲▓▓▓▓▓▓╱────▓▓",
  ],
  [
    "       ▓▓╲               ╱▓▓",
    "       ▓▒ ╲     ··      ╱ ▒▓",
    "       ▓▒  ╲   ░░█░    ╱  ▒▓",
    "       ▓▒   ╲  ░███░  ╱   ▒▓",
    "       ▓▓───╲▓▓▓▓▓▓▓▓╱───▓▓",
  ],
] as const;

const COMPLETE_FRAME = [
  "       ▓▓╲               ╱▓▓",
  "       ▓▒ ╲             ╱ ▒▓",
  "       ▓▒  ╲    ███    ╱  ▒▓",
  "       ▓▒   ╲   █ █   ╱   ▒▓",
  "       ▓▓──────╲███╱──────▓▓",
] as const;

function elapsedSeconds(startedAt: number): string {
  return `${Math.floor(Math.max(0, Date.now() - startedAt) / 1_000)}s`;
}

function padCenter(line: string, width: number): string {
  const padding = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
  return " ".repeat(padding) + line;
}

function activityFromTool(toolName: string | undefined): ExplorerActivity | undefined {
  switch (toolName) {
    case "repo_search":
      return "search";
    case "repo_read":
      return "read";
    case "repo_list":
      return "list";
    case "repo_git":
      return "git";
    default:
      return undefined;
  }
}

export function explorerActivityFromTool(toolName: string | undefined): ExplorerActivity | undefined {
  return activityFromTool(toolName);
}

class DungeonComponent {
  constructor(
    private readonly widget: DungeonWidget,
    private readonly tui: TUI,
    private readonly theme: Theme,
  ) {}

  requestRender(): void {
    this.tui.requestRender();
  }

  invalidate(): void {
    // Render strings are rebuilt with the current theme on every render.
  }

  render(width: number): string[] {
    return this.widget.render(width, this.theme);
  }
}

/** UI-only controller for the transient explorer widget. */
export class DungeonWidget {
  private component: DungeonComponent | undefined;
  private animationTimer: ReturnType<typeof setInterval> | undefined;
  private clearTimer: ReturnType<typeof setTimeout> | undefined;
  private frameIndex = 0;
  private turns = 0;
  private activity: ExplorerActivity = "working";
  private finalizing = false;
  private state: DungeonState = "running";
  private disposed = false;

  constructor(
    private readonly ctx: ExtensionContext,
    private readonly startedAt: number,
    private readonly maxTurns: number,
  ) {}

  start(): void {
    if (this.disposed || this.ctx.mode !== "tui") return;

    this.setWidget((tui, theme) => {
      const component = new DungeonComponent(this, tui, theme);
      this.component = component;
      return component;
    });
    this.requestRender();

    this.animationTimer = setInterval(() => {
      if (this.disposed || this.state !== "running") return;
      this.frameIndex = (this.frameIndex + 1) % RUNNING_FRAMES.length;
      this.requestRender();
    }, FRAME_INTERVAL_MS);
    this.animationTimer.unref?.();
  }

  update(turns: number): void {
    if (this.disposed || this.state !== "running") return;
    this.turns = turns;
    this.requestRender();
  }

  setActivity(activity: ExplorerActivity | undefined): void {
    if (this.disposed || this.state !== "running" || !activity) return;
    this.activity = activity;
    this.requestRender();
  }

  setFinalizing(): void {
    if (this.disposed || this.state !== "running") return;
    this.finalizing = true;
    this.requestRender();
  }

  finish(outcome: DungeonOutcome): void {
    if (this.disposed) return;
    this.stopAnimation();
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = undefined;
    this.state = outcome === "completed" || outcome === "budget-finalized"
      ? "completed"
      : outcome === "timeout"
        ? "timeout"
        : "error";
    this.requestRender();
    this.clearTimer = setTimeout(() => this.dispose(), FINISH_CLEAR_DELAY_MS);
    this.clearTimer.unref?.();
  }

  fail(): void {
    this.finish("error");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAnimation();
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = undefined;
    this.component = undefined;
    this.setWidget(undefined);
  }

  render(width: number, theme: Theme): string[] {
    const status = this.statusLine(theme);
    if (width < MIN_ART_WIDTH) {
      return [padCenter(truncateToWidth(`[ ${status} ]`, width), width)];
    }

    const art = this.state === "completed" ? COMPLETE_FRAME : RUNNING_FRAMES[this.frameIndex]!;
    return [...art.map((line) => padCenter(this.paintLine(line, theme), width)), padCenter(status, width)];
  }

  private statusLine(theme: Theme): string {
    if (this.state === "completed") {
      return theme.fg("success", "EXPLORE · complete ✓");
    }
    if (this.state === "timeout") {
      return theme.fg("warning", "EXPLORE · timeout");
    }
    if (this.state === "error") {
      return theme.fg("error", "EXPLORE · error");
    }

    if (this.finalizing) {
      return [
        theme.fg("accent", "EXPLORE"),
        theme.fg("dim", ` · finalizing · ${elapsedSeconds(this.startedAt)} · `),
        theme.fg("muted", `t${this.turns}/${this.maxTurns}`),
      ].join("");
    }

    return [
      theme.fg("accent", "EXPLORE"),
      theme.fg("dim", ` · ${this.activity} · ${elapsedSeconds(this.startedAt)} · `),
      theme.fg("muted", `t${this.turns}/${this.maxTurns}`),
    ].join("");
  }

  private paintLine(line: string, theme: Theme): string {
    let output = "";
    let run = "";
    let color: "dim" | "muted" | "accent" | "success" | undefined;

    const flush = () => {
      if (!run) return;
      output += color ? theme.fg(color, run) : run;
      run = "";
    };

    for (const char of line) {
      const nextColor: "dim" | "muted" | "accent" | "success" | undefined = char === "▓" || char === "▒"
        ? "dim"
        : char === "╲" || char === "╱" || char === "─"
          ? "muted"
          : char === "░" || char === "·"
            ? "accent"
            : char === "█"
              ? this.state === "completed" ? "success" : "accent"
              : undefined;
      if (nextColor !== color) {
        flush();
        color = nextColor;
      }
      run += char;
    }
    flush();
    return output;
  }

  private requestRender(): void {
    try {
      this.component?.requestRender();
    } catch {
      // The TUI may already have been disposed during a reload or shutdown.
    }
  }

  private setWidget(
    content: ((tui: TUI, theme: Theme) => DungeonComponent) | undefined,
  ): void {
    try {
      this.ctx.ui.setWidget(WIDGET_KEY, content);
    } catch {
      // Session shutdown/reload can race with best-effort widget cleanup.
    }
  }

  private stopAnimation(): void {
    if (this.animationTimer) clearInterval(this.animationTimer);
    this.animationTimer = undefined;
  }
}
