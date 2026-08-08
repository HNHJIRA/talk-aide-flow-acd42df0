import { ms, type LatencyWaterfall } from "@/lib/latency";
import { cn } from "@/lib/utils";

const BUDGET_MS = 1500;
const TARGET_MS = 1000;

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-foreground/90" title={hint ?? value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * Speech end -> first rendered token, broken down by stage, for the most recent
 * interviewer turn. Everything is measured on the browser's performance clock.
 */
export function LatencyWaterfallPanel({
  latency,
  history,
}: {
  latency: LatencyWaterfall;
  history: LatencyWaterfall[];
}) {
  const total = latency.totalMs;
  const grade =
    total == null
      ? "text-muted-foreground"
      : total <= TARGET_MS
        ? "text-success"
        : total <= BUDGET_MS
          ? "text-warning"
          : "text-destructive";

  const measured = history.filter((h) => h.totalMs != null);
  const median = measured.length
    ? measured.map((h) => h.totalMs!).sort((a, b) => a - b)[Math.floor(measured.length / 2)]!
    : null;

  return (
    <div className="mt-3 rounded-lg bg-muted p-3 text-[11px] leading-relaxed">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="font-semibold uppercase tracking-wide text-muted-foreground">
          Latency waterfall
        </span>
        <span className={cn("font-mono text-sm font-semibold", grade)}>
          {total == null ? "—" : `${total} ms`}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
        <Row label="Turn" value={latency.turnId} />
        <Row label="Speech end → STT final" value={ms(latency.speechEndToFinalMs)} />
        <Row
          label="Question gate (local)"
          value={ms(latency.questionGateMs)}
          hint="Regex gate — no network"
        />
        <Row
          label="AI classifier"
          value={latency.classifierUsed ? ms(latency.classifierMs) : "skipped (local gate)"}
        />
        <Row
          label="Resume context"
          value={
            latency.contextPrefetch === "hit"
              ? "prefetched (0 ms on critical path)"
              : ms(latency.contextMs)
          }
        />
        <Row label="Final → AI request sent" value={ms(latency.aiRequestMs)} />
        <Row label="AI time to first token" value={ms(latency.aiTtftMs)} />
        <Row label="Network overhead" value={ms(latency.serverToBrowserMs)} />
        <Row label="Token → painted" value={ms(latency.browserRenderMs)} />
        <Row label="Speech end → first token on screen" value={ms(latency.totalMs)} />
        <Row label="Speech end → answer complete" value={ms(latency.completeMs)} />
        <Row label={`Median of last ${measured.length} turns`} value={ms(median)} />
      </dl>

      {history.length > 1 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {history.map((h) => (
            <span
              key={h.turnId}
              className={cn(
                "rounded px-1.5 py-0.5 font-mono text-[10px]",
                h.totalMs == null
                  ? "bg-muted-foreground/10 text-muted-foreground"
                  : h.totalMs <= TARGET_MS
                    ? "bg-success/15 text-success"
                    : h.totalMs <= BUDGET_MS
                      ? "bg-warning/15 text-warning"
                      : "bg-destructive/15 text-destructive",
              )}
            >
              {h.totalMs == null ? "—" : `${h.totalMs}`}
            </span>
          ))}
        </div>
      ) : null}
      <p className="mt-2 text-[10px] text-muted-foreground">
        Target ≤ {TARGET_MS} ms, budget ≤ {BUDGET_MS} ms from the interviewer finishing the question
        to the first word appearing on screen.
      </p>
    </div>
  );
}
