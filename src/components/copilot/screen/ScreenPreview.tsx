import type { RefObject } from "react";
import { cn } from "@/lib/utils";

export function ScreenPreview({
  videoRef,
  sharing,
  sourceLabel,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  sharing: boolean;
  sourceLabel: string;
}) {
  return (
    <div className="space-y-1">
      <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-muted/40">
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          aria-label="Shared screen preview"
          className={cn("h-full w-full object-contain", sharing ? "opacity-100" : "opacity-0")}
        />
        {!sharing ? (
          <p className="absolute inset-0 flex items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
            Nothing shared yet — start screen sharing to see a live preview.
          </p>
        ) : null}
      </div>
      {sharing && sourceLabel ? (
        <p className="truncate text-[10px] text-muted-foreground">Source: {sourceLabel}</p>
      ) : null}
    </div>
  );
}
