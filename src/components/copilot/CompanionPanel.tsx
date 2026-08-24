import { useEffect, useRef, useState } from "react";
import { Laptop, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AudioLevelMeter, StatusDot } from "@/components/copilot/StatusIndicators";
import { CompanionRequiredCard } from "@/components/download/MacDownloadButton";
import { createCompanionPairing, getCompanionPairing } from "@/lib/companion.functions";
import type { CompanionHealth, CompanionState } from "@/lib/companion/companion-client";

const TONE: Record<string, "ok" | "pending" | "error" | "off"> = {
  capturing: "ok",
  connected: "ok",
  ready: "ok",
  silent: "pending",
  pairing: "pending",
  requesting_permission: "pending",
  reconnecting: "pending",
  error: "error",
  not_installed: "off",
  disconnected: "off",
  stopped: "off",
};

const label = (state: CompanionState, app: string) => LABEL[state].replace("{app}", app);

const LABEL: Record<CompanionState, string> = {
  not_installed: "Companion not detected",
  disconnected: "Not connected",
  pairing: "Pairing…",
  connected: "Paired — ready to capture",
  requesting_permission: "Waiting for OS audio permission",
  ready: "Ready",
  capturing: "Capturing {app} audio",
  silent: "Paired but no {app} audio detected",
  reconnecting: "Reconnecting to companion…",
  error: "Companion error",
  stopped: "Stopped",
};

/**
 * Pairing + control surface for the native Desktop Companion.
 * The browser never receives platform API keys: it mints a short-lived pairing
 * code, the companion redeems it for a session-scoped bridge token, and only
 * then does this panel open the local bridge.
 */
export function CompanionPanel({
  sessionId,
  appLabel = "Zoom Desktop",
  health,
  state,
  level,
  onRefresh,
  onConnect,
  onStartCapture,
  onStopCapture,
  onFallback,
  embedded = false,
}: {
  sessionId: string;
  /** Which desktop meeting app this session captures (Zoom Desktop, Microsoft Teams Desktop). */
  appLabel?: string;
  health: CompanionHealth | null;
  state: CompanionState;
  level: number;
  onRefresh: () => Promise<CompanionHealth | null>;
  onConnect: (bridgeToken: string) => Promise<boolean>;
  onStartCapture: () => void;
  onStopCapture: () => void;
  onFallback: () => void;
  embedded?: boolean;
}) {

  const [code, setCode] = useState<string | null>(null);
  const [pairingId, setPairingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    void onRefresh();
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPairing = async () => {
    setBusy(true);
    try {
      const detected = await onRefresh();
      if (!detected) {
        toast.error("Companion app not detected on this computer.");
        return;
      }
      const pairing = await createCompanionPairing({ data: { sessionId } });
      setCode(pairing.code);
      setPairingId(pairing.pairingId);
      if (poll.current) clearInterval(poll.current);
      poll.current = setInterval(async () => {
        try {
          const status = await getCompanionPairing({ data: { pairingId: pairing.pairingId } });
          if (status.approved && status.bridgeToken) {
            if (poll.current) clearInterval(poll.current);
            poll.current = null;
            setCode(null);
            await onConnect(status.bridgeToken);
            toast.success("Desktop Companion paired.");
          } else if (status.status === "expired" || status.status === "revoked") {
            if (poll.current) clearInterval(poll.current);
            poll.current = null;
            setCode(null);
            toast.error("Pairing code expired. Generate a new one.");
          }
        } catch {
          /* keep polling */
        }
      }, 2000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create a pairing code.");
    } finally {
      setBusy(false);
    }
  };

  const capturing = state === "capturing" || state === "silent";
  const paired = capturing || state === "connected" || state === "ready" || state === "requesting_permission";

  return (
    <div className={embedded ? "" : "rounded-lg border border-border p-3"}>
      {embedded ? null : (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Laptop className="size-4 text-primary" /> {appLabel} (companion)
            </p>
            <div className="mt-1.5">
              <StatusDot label={label(state, appLabel)} status={TONE[state] ?? "off"} detail={health ? `v${health.version} · ${health.captureBackend}` : ""} />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <AudioLevelMeter level={level} label={appLabel} />
            <Button size="icon" variant="ghost" onClick={() => void onRefresh()} aria-label="Re-check companion">
              <RefreshCw className="size-4" />
            </Button>
          </div>
        </div>
      )}



      {code ? (
        <div className="mt-3 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
          <p className="text-muted-foreground">Enter this code in the InterviewCopilot Companion app:</p>
          <p className="mt-1 font-mono text-2xl tracking-[0.3em] text-foreground">{code}</p>
          <p className="mt-1 text-xs text-muted-foreground">Expires in 10 minutes · waiting for approval…</p>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {!paired ? (
          <Button size="sm" onClick={() => void startPairing()} disabled={busy || Boolean(code)}>
            {code ? "Waiting for companion…" : "Pair companion"}
          </Button>
        ) : capturing ? (
          <Button size="sm" variant="outline" onClick={onStopCapture}>
            Stop capture
          </Button>
        ) : (
          <Button size="sm" onClick={onStartCapture}>
            Connect {appLabel} audio
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onFallback}>
          Use browser tab audio instead
        </Button>
      </div>

      {!health ? (
        <div className="mt-3">
          <CompanionRequiredCard onCheckAgain={() => void onRefresh()} />
        </div>
      ) : null}
      {state === "silent" ? (
        <p className="mt-2 text-xs text-warning">
          The companion is connected but no {appLabel} audio is arriving — check that the meeting is playing through
          the selected output device and that screen-recording permission is granted.
        </p>
      ) : null}
    </div>
  );
}
