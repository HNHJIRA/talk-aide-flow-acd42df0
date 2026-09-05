import { cn } from "@/lib/utils";
import { SCREEN_STATE_LABEL, type ScreenCaptureState } from "@/lib/screen/screenshot";

const TONE: Record<ScreenCaptureState, string> = {
  idle: "bg-muted-foreground/50",
  requesting: "bg-warning live-dot",
  capturing: "bg-success",
  paused: "bg-warning",
  stopped: "bg-muted-foreground/50",
  error: "bg-destructive",
};

export function ScreenCaptureStatus({
  state,
  detail,
  error,
}: {
  state: ScreenCaptureState;
  detail?: string;
  error?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <span className={cn("size-2 rounded-full", TONE[state])} aria-hidden />
        <span className="font-medium text-foreground">Screen: {SCREEN_STATE_LABEL[state]}</span>
        {detail ? <span className="text-muted-foreground">{detail}</span> : null}
      </div>
      {state === "error" && error ? (
        <p className="text-[11px] text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
