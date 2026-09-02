/**
 * Voice Interpreter panel — presentation only.
 * Reads the interpreter hook; never touches audio capture or STT directly.
 */
import { Mic, MicOff, Headphones, Volume2, RefreshCw, Play, AudioLines } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  INTERPRETER_STATUS_DOT,
  voicesFor,
  type InterpreterSettings,
  type InterpreterStatus,
  type InterpretedUtterance,
  type InterpreterDiagnostics,
  type InterpreterRouting,
} from "@/lib/translation/interpreter-protocol";
import {
  SOURCE_LANGUAGES,
  TARGET_LANGUAGES,
  languageLabel,
  type LanguageCode,
} from "@/lib/translation/translation-protocol";
import type { AudioOutputDevice } from "@/hooks/useVoiceInterpreter";
import { InterpreterOutputDiagnostics } from "@/components/copilot/InterpreterOutputDiagnostics";
import type { InterpreterOutputController } from "@/hooks/useInterpreterOutput";

type Props = {
  settings: InterpreterSettings;
  patch: (next: Partial<InterpreterSettings>) => void;
  status: InterpreterStatus;
  diagnostics: InterpreterDiagnostics;
  devices: AudioOutputDevice[];
  routing: InterpreterRouting;
  latest: { incoming: InterpretedUtterance | null; outgoing: InterpretedUtterance | null };
  incomingTarget: LanguageCode;
  outgoingTarget: LanguageCode;
  interviewerLanguage: string;
  micConnected: boolean;
  onRefreshDevices: () => void;
  onRequestDevicePermission: () => void;
  onTestVoice: () => void;
  /** Native interpreter output layer (feature-flagged, additive). */
  output: InterpreterOutputController;
};

const STATUS_TEXT: Record<InterpreterStatus, string> = {
  off: "Off",
  listening: "Listening",
  translating: "Translating",
  speaking: "Speaking",
  error: "Error",
};

export function InterpreterPanel({
  settings,
  patch,
  status,
  diagnostics,
  devices,
  routing,
  latest,
  incomingTarget,
  outgoingTarget,
  interviewerLanguage,
  micConnected,
  onRefreshDevices,
  onRequestDevicePermission,
  onTestVoice,
  output,
}: Props) {
  return (
    <section className="panel flex min-h-0 flex-col gap-4 p-5">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AudioLines className="size-4 text-primary" />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Voice interpreter
          </h2>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[11px]",
              status === "speaking"
                ? "border-primary/40 bg-primary/10 text-primary"
                : status === "error"
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-border text-muted-foreground",
            )}
          >
            {INTERPRETER_STATUS_DOT[status]} {STATUS_TEXT[status]}
          </span>
          <Switch
            checked={settings.enabled}
            onCheckedChange={(v) => patch({ enabled: v })}
            aria-label="Voice interpreter mode"
          />
        </div>
      </header>

      {!settings.enabled ? (
        <p className="text-xs text-muted-foreground">
          Speak your own language while the interviewer hears a translated voice. Turn this on to
          configure the incoming and outgoing languages.
        </p>
      ) : (
        <>
          {/* language pair summary */}
          <div className="grid gap-2 sm:grid-cols-2">
            <Summary
              icon={<Headphones className="size-3.5" />}
              title="Incoming"
              value={`${languageLabel(interviewerLanguage || "auto")} → ${languageLabel(incomingTarget)}`}
              detail={settings.playIncomingVoice ? "Translated voice on" : "Text only"}
            />
            <Summary
              icon={<Mic className="size-3.5" />}
              title="Outgoing"
              value={`${languageLabel(settings.iSpeak)} → ${languageLabel(outgoingTarget)}`}
              detail={settings.speakOutgoing ? "Interpreted voice sent" : "Muted"}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Picker
              label="I speak"
              value={settings.iSpeak}
              options={SOURCE_LANGUAGES}
              onChange={(v) => patch({ iSpeak: v })}
            />
            <Picker
              label="Interviewer hears"
              value={settings.interviewerHears}
              options={TARGET_LANGUAGES}
              onChange={(v) => patch({ interviewerHears: v })}
            />
          </div>

          {/* toggles */}
          <div className="space-y-2 rounded-lg border border-border p-3">
            <Toggle
              label="Play translated interviewer audio"
              hint="Original meeting audio is ducked while the translated voice plays."
              checked={settings.playIncomingVoice}
              onChange={(v) => patch({ playIncomingVoice: v })}
            />
            <Toggle
              label="Duck original interviewer audio"
              checked={settings.duckOriginal}
              onChange={(v) => patch({ duckOriginal: v })}
            />
            <Toggle
              label="Translated microphone"
              hint="Sends your interpreted voice into the meeting."
              checked={settings.speakOutgoing}
              onChange={(v) => patch({ speakOutgoing: v })}
            />
            <Toggle
              label="Original microphone"
              hint="Keep off so the interviewer only hears the translation."
              checked={settings.originalMicEnabled}
              onChange={(v) => patch({ originalMicEnabled: v })}
            />
          </div>

          {/* voice */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Voice</Label>
              <Select
                value={settings.voiceGender}
                onValueChange={(v) => {
                  const gender = v as InterpreterSettings["voiceGender"];
                  patch({ voiceGender: gender, voice: voicesFor(gender)[0]!.id });
                }}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="female">Female</SelectItem>
                  <SelectItem value="male">Male</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Voice character</Label>
              <Select value={settings.voice} onValueChange={(v) => patch({ voice: v })}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {voicesFor(settings.voiceGender).map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <RangeRow
              label={`Speaking speed · ${settings.speed.toFixed(2)}x`}
              value={settings.speed}
              min={0.7}
              max={1.2}
              step={0.05}
              onChange={(v) => patch({ speed: v })}
            />
            <RangeRow
              label={`Volume · ${Math.round(settings.volume * 100)}%`}
              value={settings.volume}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => patch({ volume: v })}
            />
          </div>

          {/* routing */}
          <div className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs">Interpreted voice output</Label>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onRefreshDevices}>
                  <RefreshCw className="size-3.5" />
                </Button>
                <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[11px]" onClick={onTestVoice}>
                  <Play className="size-3.5" /> Test
                </Button>
              </div>
            </div>
            <Select
              value={settings.outputDeviceId}
              onValueChange={(v) => patch({ outputDeviceId: v })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="System default" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">System default</SelectItem>
                {devices
                  .filter((d) => d.deviceId && d.deviceId !== "default")
                  .map((d) => (
                    <SelectItem key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {devices.every((d) => !d.label || d.label.startsWith("Output")) ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 w-full text-[11px]"
                onClick={onRequestDevicePermission}
              >
                Allow audio permissions to see device names
              </Button>
            ) : null}
            <p className="text-[11px] text-muted-foreground">
              {routing === "companion_virtual_mic"
                ? "Desktop app detected — route this to the companion virtual microphone, then pick it as your mic inside Zoom / Teams."
                : "Pick a virtual audio device (VB-CABLE, BlackHole, Loopback) and select it as your microphone in the meeting."}
            </p>
          </div>

          {/* live pair */}
          <div className="space-y-2 text-xs">
            <LiveLine
              icon={<Headphones className="size-3.5 text-muted-foreground" />}
              title="Interviewer"
              utterance={latest.incoming}
            />
            <LiveLine
              icon={
                settings.originalMicEnabled ? (
                  <Mic className="size-3.5 text-muted-foreground" />
                ) : (
                  <MicOff className="size-3.5 text-muted-foreground" />
                )
              }
              title="You"
              utterance={latest.outgoing}
            />
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border pt-3 text-[11px] text-muted-foreground">
            <Metric label="Latency" value={diagnostics.totalMs ? `${diagnostics.totalMs} ms` : "—"} />
            <Metric label="Average" value={diagnostics.avgTotalMs ? `${diagnostics.avgTotalMs} ms` : "—"} />
            <Metric label="Microphone" value={micConnected ? "Connected" : "Not connected"} />
            <Metric label="Virtual microphone" value={diagnostics.virtualMic} />
          </dl>

          <InterpreterOutputDiagnostics output={output} />
        </>
      )}
    </section>
  );
}

function Summary({
  icon,
  title,
  value,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {icon} {title}
      </p>
      <p className="mt-1 text-sm font-medium">{value}</p>
      <p className="text-[11px] text-muted-foreground">{detail}</p>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <Label className="text-xs">{label}</Label>
        {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function RangeRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="flex items-center gap-1 text-xs">
        <Volume2 className="size-3.5 text-muted-foreground" /> {label}
      </Label>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onChange(v ?? value)}
      />
    </div>
  );
}

function LiveLine({
  icon,
  title,
  utterance,
}: {
  icon: React.ReactNode;
  title: string;
  utterance: InterpretedUtterance | null;
}) {
  return (
    <div className="rounded-lg border border-border p-2">
      <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {icon} {title}
      </p>
      <p className="mt-1 truncate">{utterance?.original || "—"}</p>
      {utterance?.translated ? (
        <p className="truncate text-primary">{utterance.translated}</p>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className="text-right font-mono text-foreground">{value}</dd>
    </>
  );
}

function Picker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { code: LanguageCode; label: string }[];
  onChange: (value: LanguageCode) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Select value={value} onValueChange={(v) => onChange(v as LanguageCode)}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.code} value={o.code}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
