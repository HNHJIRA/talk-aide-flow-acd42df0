import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { LevelBars, type SourceCardState } from "@/components/copilot/SourceCard";

const STATE_STYLES: Record<SourceCardState, { ring: string; dot: string; text: string }> = {
  disconnected: { ring: "border-border/70", dot: "bg-muted-foreground/50", text: "text-muted-foreground" },
  connecting: { ring: "border-primary/40", dot: "bg-warning live-dot", text: "text-warning" },
  connected: { ring: "border-success/40", dot: "bg-success", text: "text-success" },
  warning: { ring: "border-warning/40", dot: "bg-warning", text: "text-warning" },
  error: { ring: "border-destructive/50", dot: "bg-destructive", text: "text-destructive" },
};

/** Compact dock-style audio source control for the bottom meeting bar. */
export function DockSource({
  icon: Icon,
  title,
  state,
  statusLabel,
  level,
  tone = "primary",
  action,
  meta,
}: {
  icon: LucideIcon;
  title: string;
  state: SourceCardState;
  statusLabel: string;
  level: number;
  tone?: "primary" | "accent";
  action?: ReactNode;
  meta?: ReactNode;
}) {
  const s = STATE_STYLES[state];
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-xl border bg-card/50 px-3 py-2 transition-colors duration-200",
        s.ring,
      )}
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-lg border border-border/70 bg-muted/50",
          state === "connected" && (tone === "accent" ? "text-accent" : "text-primary"),
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs font-medium leading-tight">{title}</p>
        <p className={cn("flex items-center gap-1.5 truncate text-[11px] leading-tight", s.text)}>
          <span className={cn("size-1.5 shrink-0 rounded-full", s.dot)} />
          <span className="truncate">{statusLabel}</span>
        </p>
        {meta ? <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{meta}</div> : null}
      </div>
      <div className="ml-1 hidden shrink-0 xl:block">
        <LevelBars level={level} active={state === "connected"} tone={tone} label={title} />
      </div>
      {action ? <div className="ml-1 shrink-0">{action}</div> : null}
    </div>
  );
}
