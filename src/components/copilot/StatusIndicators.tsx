import { cn } from "@/lib/utils";

type Status = "ok" | "pending" | "error" | "off";

const TONE: Record<Status, string> = {
  ok: "bg-success",
  pending: "bg-warning live-dot",
  error: "bg-destructive",
  off: "bg-muted-foreground/50",
};

export function StatusDot({
  label,
  status,
  detail,
  className,
}: {
  label: string;
  status: Status;
  detail?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2 text-xs", className)}>
      <span className={cn("size-2 rounded-full", TONE[status])} aria-hidden />
      <span className="font-medium text-foreground">{label}</span>
      {detail ? <span className="text-muted-foreground">{detail}</span> : null}
    </div>
  );
}

export function AudioLevelMeter({ level, label }: { level: number; label: string }) {
  const bars = 10;
  const active = Math.round(Math.min(1, level) * bars);
  return (
    <div className="flex items-center gap-2" aria-label={`${label} input level`}>
      <div className="flex gap-[3px]">
        {Array.from({ length: bars }).map((_, i) => (
          <span
            key={i}
            className={cn(
              "h-3 w-[5px] rounded-[2px] transition-colors",
              i < active ? (i > 7 ? "bg-warning" : "bg-primary") : "bg-muted",
            )}
          />
        ))}
      </div>
    </div>
  );
}
