import { Button } from "@/components/ui/button";
import { Camera, MonitorUp, Pause, Play, Square } from "lucide-react";
import { CAPTURE_INTERVALS, type CaptureIntervalSeconds } from "@/lib/screen/screenshot";
import { cn } from "@/lib/utils";
import type { ScreenCaptureController } from "@/hooks/useScreenCapture";

export function ScreenCaptureControls({ screen }: { screen: ScreenCaptureController }) {
  const paused = screen.state === "paused";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {!screen.sharing ? (
          <Button
            size="sm"
            className="h-7 gap-1 text-[11px]"
            disabled={!screen.supported || screen.state === "requesting"}
            onClick={() => void screen.start()}
          >
            <MonitorUp className="size-3.5" />
            {screen.state === "requesting" ? "Waiting…" : "Start screen sharing"}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-[11px]"
              onClick={screen.captureNow}
            >
              <Camera className="size-3.5" /> Capture now
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-[11px]"
              onClick={paused ? screen.resume : screen.pause}
            >
              {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              {paused ? "Resume auto" : "Pause auto"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 text-[11px]"
              onClick={screen.stop}
            >
              <Square className="size-3.5" /> Stop sharing
            </Button>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">Auto capture every</span>
        <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5">
          {CAPTURE_INTERVALS.map((s: CaptureIntervalSeconds) => (
            <button
              key={s}
              type="button"
              onClick={() => screen.setIntervalSeconds(s)}
              className={cn(
                "rounded-[5px] px-2 py-0.5 text-[11px] font-medium transition-colors",
                s === screen.intervalSeconds
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s}s
            </button>
          ))}
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Shortcut: Ctrl/Cmd + Shift + S takes a screenshot while sharing.
      </p>
    </div>
  );
}
