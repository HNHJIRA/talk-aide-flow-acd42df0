/**
 * Dock control for the Private Overlay (native always-on-top bubble).
 *
 * The browser can never provide always-on-top or hidden-from-capture behaviour,
 * so this panel is explicit about what runs natively and what the OS actually
 * guarantees per platform.
 */
import { EyeOff, Layers, ShieldCheck, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  BROWSER_ONLY_LIMITATION,
  type OverlayMode,
  type OverlaySettings,
  type OverlayStatus,
} from "@/lib/overlay/overlay-protocol";
import type { OverlayLinkState } from "@/lib/overlay/overlay-link";
import type { CompanionHealth } from "@/lib/companion/companion-client";

const MODES: { key: OverlayMode; label: string; hint: string }[] = [
  { key: "bubble", label: "Bubble", hint: "Tiny launcher dot" },
  { key: "mini", label: "Mini", hint: "Question + short answer" },
  { key: "focus", label: "Focus", hint: "Full question + answer" },
];

const SHORTCUTS: [string, string][] = [
  ["Toggle overlay", "Ctrl/⌘ + Shift + O"],
  ["Cycle size", "Ctrl/⌘ + Shift + S"],
  ["Next answer", "Ctrl/⌘ + Shift + ."],
  ["Previous answer", "Ctrl/⌘ + Shift + ,"],
  ["Minimise to bubble", "Ctrl/⌘ + Shift + H"],
];

export function OverlayControl({
  settings,
  patch,
  linkState,
  status,
  health,
  pairingCode,
  busy,
  error,
  onPair,
  onDisconnect,
  onRefresh,
}: {
  settings: OverlaySettings;
  patch: (next: Partial<OverlaySettings>) => void;
  linkState: OverlayLinkState;
  status: OverlayStatus | null;
  health: CompanionHealth | null;
  pairingCode: string | null;
  busy: boolean;
  error: string | null;
  onPair: () => void;
  onDisconnect: () => void;
  onRefresh: () => void;
}) {
  const connected = linkState === "connected";
  const caps = status?.capabilities;
  const protectionOn = Boolean(caps?.captureExclusionActive);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-[11px] font-medium transition-colors duration-200",
            connected && settings.enabled
              ? "border-primary/50 bg-primary/10 text-primary"
              : "border-border/70 bg-card/50 text-muted-foreground hover:text-foreground",
          )}
        >
          <Layers className="size-3.5" />
          Overlay
          {connected && settings.enabled ? (
            <span className="size-1.5 rounded-full bg-primary" aria-hidden />
          ) : null}
        </button>
      </PopoverTrigger>

      <PopoverContent side="top" align="end" className="w-[340px] space-y-3 text-xs">
        <div>
          <p className="flex items-center gap-2 text-sm font-medium">
            <EyeOff className="size-4 text-primary" /> Private overlay
          </p>
          <p className="mt-1 text-muted-foreground">
            A native always-on-top bubble showing the latest question and answer above Zoom, Meet or
            your slides.
          </p>
        </div>

        {!health ? (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-warning">
            Desktop Companion not detected. {BROWSER_ONLY_LIMITATION}
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="outline" onClick={onRefresh}>
                Check again
              </Button>
              <Button size="sm" variant="ghost" asChild>
                <a href="/download">Get the companion</a>
              </Button>
            </div>
          </div>
        ) : pairingCode ? (
          <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
            <p className="text-muted-foreground">Enter this code in the companion app:</p>
            <p className="mt-1 font-mono text-2xl tracking-[0.3em] text-foreground">{pairingCode}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">Waiting for approval…</p>
          </div>
        ) : !connected ? (
          <Button size="sm" className="w-full" disabled={busy} onClick={onPair}>
            {busy ? "Preparing…" : "Enable private overlay"}
          </Button>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="font-medium text-foreground">Overlay visible</span>
              <Switch
                checked={settings.enabled}
                onCheckedChange={(enabled) => patch({ enabled })}
              />
            </div>

            <div>
              <p className="mb-1.5 text-muted-foreground">Display mode</p>
              <div className="inline-flex w-full rounded-lg border border-border bg-muted/40 p-0.5">
                {MODES.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    title={m.hint}
                    onClick={() => patch({ mode: m.key })}
                    className={cn(
                      "flex-1 rounded-[7px] px-2 py-1.5 font-medium transition-colors duration-200",
                      settings.mode === m.key
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between text-muted-foreground">
                <span>Opacity</span>
                <span>{Math.round(settings.opacity * 100)}%</span>
              </div>
              <Slider
                value={[Math.round(settings.opacity * 100)]}
                min={60}
                max={100}
                step={10}
                onValueChange={([v]) => patch({ opacity: (v ?? 100) / 100 })}
              />
            </div>

            <div>
              <p className="mb-1.5 text-muted-foreground">Show</p>
              <div className="inline-flex w-full rounded-lg border border-border bg-muted/40 p-0.5">
                {(["both", "question", "answer"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => patch({ show: key })}
                    className={cn(
                      "flex-1 rounded-[7px] px-2 py-1.5 font-medium capitalize transition-colors duration-200",
                      settings.show === key
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {key}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2 border-t border-border pt-2">
              <Row
                label="Always on top"
                checked={settings.alwaysOnTop}
                onChange={(v) => patch({ alwaysOnTop: v })}
              />
              <Row
                label="Hide from screen capture"
                checked={settings.hideFromCapture}
                onChange={(v) => patch({ hideFromCapture: v })}
                disabled={!caps?.captureExclusion}
              />
              <Row
                label="Lock position"
                checked={settings.lockPosition}
                onChange={(v) => patch({ lockPosition: v })}
              />
              <Row
                label="Open overlay when session starts"
                checked={settings.launchOnSessionStart}
                onChange={(v) => patch({ launchOnSessionStart: v })}
              />
            </div>

            <div
              className={cn(
                "flex items-start gap-2 rounded-md border p-2",
                protectionOn
                  ? "border-primary/40 bg-primary/5 text-foreground"
                  : "border-border bg-muted/30 text-muted-foreground",
              )}
            >
              {protectionOn ? (
                <ShieldCheck className="mt-0.5 size-3.5 text-primary" />
              ) : (
                <ShieldAlert className="mt-0.5 size-3.5" />
              )}
              <span>{caps?.note ?? "Checking screen-capture protection support…"}</span>
            </div>

            <div className="space-y-1 border-t border-border pt-2 text-muted-foreground">
              {SHORTCUTS.map(([label, keys]) => (
                <div key={label} className="flex items-center justify-between">
                  <span>{label}</span>
                  <kbd className="rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]">
                    {keys}
                  </kbd>
                </div>
              ))}
            </div>

            <Button size="sm" variant="ghost" className="w-full" onClick={onDisconnect}>
              Close overlay & unlink
            </Button>
          </>
        )}

        {error ? <p className="text-destructive">{error}</p> : null}
        {linkState === "reconnecting" ? (
          <p className="text-muted-foreground">Reconnecting to the companion…</p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function Row({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={cn("text-muted-foreground", disabled && "opacity-50")}>{label}</span>
      <Switch checked={checked && !disabled} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}
