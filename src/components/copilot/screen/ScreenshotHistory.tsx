import { formatBytes, formatClock, type Screenshot } from "@/lib/screen/screenshot";
import { cn } from "@/lib/utils";

export function ScreenshotHistory({ screenshots }: { screenshots: Screenshot[] }) {
  if (screenshots.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Screenshots you take will appear here, newest first.
      </p>
    );
  }
  return (
    <ul className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto pr-1">
      {screenshots.map((shot) => (
        <li key={shot.id} className="overflow-hidden rounded-md border border-border bg-muted/30">
          <div className="aspect-video w-full bg-background/60">
            {shot.status === "captured" ? (
              <img
                src={shot.dataUrl}
                alt={`Screen capture at ${formatClock(shot.createdAt)}`}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <p className="flex h-full items-center justify-center px-2 text-center text-[10px] text-destructive">
                {shot.error || "Capture failed"}
              </p>
            )}
          </div>
          <div className="flex items-center justify-between gap-1 px-1.5 py-1 text-[10px]">
            <span className="font-mono tabular-nums text-muted-foreground">
              {formatClock(shot.createdAt)}
            </span>
            <span
              className={cn(
                "rounded-full border px-1.5",
                shot.source === "manual"
                  ? "border-primary/40 text-primary"
                  : "border-border text-muted-foreground",
              )}
            >
              {shot.source === "manual" ? "Manual" : "Auto"}
            </span>
          </div>
          {shot.status === "captured" ? (
            <p className="px-1.5 pb-1 text-[10px] text-muted-foreground">
              {shot.width}×{shot.height} · {formatBytes(shot.bytes)}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
