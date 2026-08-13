import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SourceCardState = "disconnected" | "connecting" | "connected" | "warning" | "error";

const STATE_STYLES: Record<SourceCardState, { ring: string; dot: string; text: string }> = {
  disconnected: {
    ring: "border-border/70",
    dot: "bg-muted-foreground/50",
    text: "text-muted-foreground",
  },
  connecting: {
    ring: "border-primary/40",
    dot: "bg-warning live-dot",
    text: "text-warning",
  },
  connected: {
    ring: "border-success/40",
    dot: "bg-success",
    text: "text-success",
  },
  warning: {
    ring: "border-warning/40",
    dot: "bg-warning",
    text: "text-warning",
  },
  error: {
    ring: "border-destructive/50",
    dot: "bg-destructive",
    text: "text-destructive",
  },
};

/** Compact, smoothly animated level meter — driven by the real audio level only. */
export function LevelBars({
  level,
  active,
  tone = "primary",
  label,
}: {
  level: number;
  active: boolean;
  tone?: "primary" | "accent";
  label: string;
}) {
  const bars = 14;
  const filled = active ? Math.round(Math.min(1, Math.max(0, level)) * bars) : 0;
  return (
    <div className="flex items-end gap-[3px]" role="meter" aria-label={`${label} input level`} aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "w-[3px] rounded-full transition-all duration-150 ease-out",
            i < filled
              ? i > bars - 3
                ? "bg-warning"
                : tone === "accent"
                  ? "bg-accent"
                  : "bg-primary"
              : "bg-foreground/10",
          )}
          style={{ height: `${6 + (i % 3) * 2 + (i < filled ? 6 : 0)}px` }}
        />
      ))}
    </div>
  );
}

export function SourceCard({
  icon: Icon,
  title,
  state,
  statusLabel,
  description,
  tone = "primary",
  level,
  meterLabel,
  action,
  children,
  footerNote,
}: {
  icon: LucideIcon;
  title: string;
  state: SourceCardState;
  statusLabel: string;
  description: ReactNode;
  tone?: "primary" | "accent";
  level: number;
  meterLabel: string;
  action?: ReactNode;
  children?: ReactNode;
  footerNote?: ReactNode;
}) {
  const styles = STATE_STYLES[state];
  return (
    <div
      className={cn(
        "flex h-full flex-col rounded-xl border bg-card/60 p-4 transition-colors duration-200 hover:border-foreground/20",
        styles.ring,
      )}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-lg border border-border/70",
            tone === "accent" ? "bg-accent/10 text-accent" : "bg-primary/10 text-primary",
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{title}</p>
          <p className={cn("mt-0.5 flex items-center gap-1.5 text-xs", styles.text)}>
            <span className={cn("size-1.5 shrink-0 rounded-full", styles.dot)} aria-hidden />
            <span className="truncate">{statusLabel}</span>
          </p>
        </div>
      </div>

      <div className="mt-3 min-h-[32px] text-xs leading-relaxed text-muted-foreground">{description}</div>

      {children ? <div className="mt-3">{children}</div> : null}

      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
        <LevelBars level={level} active={state === "connected"} tone={tone} label={meterLabel} />
        {action}
      </div>
      {footerNote ? <div className="mt-2 text-[11px] text-muted-foreground">{footerNote}</div> : null}
    </div>
  );
}
