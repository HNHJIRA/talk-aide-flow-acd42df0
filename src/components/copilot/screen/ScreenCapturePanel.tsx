/**
 * Screen Intelligence panel (Phase 1) — capture only, no AI vision.
 * Additive UI: it renders alongside the existing live session and never
 * interacts with meeting audio, STT, answers or the interpreter.
 */
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ScreenPreview } from "./ScreenPreview";
import { ScreenCaptureControls } from "./ScreenCaptureControls";
import { ScreenCaptureStatus } from "./ScreenCaptureStatus";
import { ScreenshotHistory } from "./ScreenshotHistory";
import type { ScreenCaptureController } from "@/hooks/useScreenCapture";
import { MAX_SCREENSHOTS } from "@/lib/screen/screenshot";

export function ScreenCapturePanel({ screen }: { screen: ScreenCaptureController }) {
  const detail =
    screen.state === "capturing"
      ? `Auto capture: every ${screen.intervalSeconds}s`
      : screen.state === "paused"
        ? "Auto capture paused"
        : undefined;

  return (
    <section className="panel flex min-h-0 flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Screen capture
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Share Screen and capture screenshots. Screen capture is separate from meeting audio —
            the browser sharing banner only appears for this feature.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="screen-enabled" className="text-[11px] text-muted-foreground">
            Enable
          </Label>
          <Switch
            id="screen-enabled"
            checked={screen.enabled}
            onCheckedChange={screen.setEnabled}
          />
        </div>
      </div>

      <ScreenCaptureStatus
        state={screen.state}
        {...(detail ? { detail } : {})}
        error={screen.error}
      />

      {!screen.supported ? (
        <p className="text-[11px] text-muted-foreground">
          This browser cannot share a screen. Try Chrome, Edge or Firefox on desktop.
        </p>
      ) : null}

      {screen.enabled ? (
        <>
          <ScreenPreview
            videoRef={screen.videoRef}
            sharing={screen.sharing}
            sourceLabel={screen.sourceLabel}
          />
          <ScreenCaptureControls screen={screen} />

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">
              Recent screenshots ({screen.screenshots.length}/{MAX_SCREENSHOTS})
            </span>
            {screen.screenshots.length ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-[11px]"
                onClick={screen.clearHistory}
              >
                Clear
              </Button>
            ) : null}
          </div>
          <ScreenshotHistory screenshots={screen.screenshots} />
        </>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          Turn this on to Share Screen and capture screenshots. Meeting audio, transcript and
          answers are a separate pipeline and keep running exactly as they do now.
        </p>
      )}
    </section>
  );
}
