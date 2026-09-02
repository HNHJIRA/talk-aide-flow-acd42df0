/**
 * Interpreter Output Diagnostics — deliberately separate from the meeting
 * latency metrics. Nothing here reads capture / STT / answer state.
 */
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { InterpreterOutputController } from "@/hooks/useInterpreterOutput";

const STATE_LABEL: Record<string, string> = {
  disabled: "Disabled (browser playback)",
  unavailable: "Companion unavailable — browser playback",
  connecting: "Connecting to companion",
  ready: "Native output ready",
  streaming: "Streaming interpreter voice",
  error: "Error — fell back to browser playback",
};

export function InterpreterOutputDiagnostics({
  output,
}: {
  output: InterpreterOutputController;
}) {
  const s = output.stats;
  const live = output.state === "ready" || output.state === "streaming";

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-xs font-medium">Interpreter output (native)</p>
          <p className="text-[11px] text-muted-foreground">
            ENABLE_NATIVE_INTERPRETER_OUTPUT — off means production behaviour.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="native-out" className="text-[11px] text-muted-foreground">
            Enable
          </Label>
          <Switch id="native-out" checked={output.enabled} onCheckedChange={output.setEnabled} />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            live ? "bg-emerald-500" : output.state === "error" ? "bg-red-500" : "bg-muted-foreground/50",
          )}
        />
        <span className="text-[11px]">{STATE_LABEL[output.state] ?? output.state}</span>
      </div>
      {output.detail ? (
        <p className="text-[11px] text-muted-foreground">{output.detail}</p>
      ) : null}
      {output.pairingCode ? (
        <p className="text-[11px]">
          Approve code <span className="font-mono font-semibold">{output.pairingCode}</span> in the
          Desktop Companion.
        </p>
      ) : null}

      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <Metric label="Backend" value={s.backend || "—"} />
        <Metric label="Device" value={s.device || "—"} />
        <Metric label="Sample rate" value={s.sampleRateOut ? `${s.sampleRateIn} → ${s.sampleRateOut} Hz` : "—"} />
        <Metric label="Buffer" value={s.bufferFrames ? `${s.bufferFrames} frames` : "—"} />
        <Metric label="Buffered" value={`${s.bufferedMs} ms`} />
        <Metric label="Output latency" value={`${s.latencyMs} ms`} />
        <Metric label="Dropped frames" value={String(s.droppedFrames)} />
        <Metric label="Underruns" value={String(s.underruns)} />
        <Metric label="Encode" value={output.lastEncodeMs != null ? `${output.lastEncodeMs} ms` : "—"} />
      </div>
      {s.lastError ? <p className="text-[11px] text-red-400">{s.lastError}</p> : null}

      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[11px]"
          disabled={!output.enabled || output.busy}
          onClick={() => void output.connect()}
        >
          {output.busy ? "Pairing…" : "Connect companion output"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-[11px]"
          disabled={output.state === "disabled"}
          onClick={output.disconnect}
        >
          Disconnect
        </Button>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-background/60 px-2 py-1">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="truncate font-medium">{value}</p>
    </div>
  );
}
