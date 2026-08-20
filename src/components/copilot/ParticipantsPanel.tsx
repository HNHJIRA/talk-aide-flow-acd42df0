/**
 * REMOTE PARTICIPANTS
 *
 * One Zoom/Meet audio stream can carry several people. Deepgram diarization only
 * gives us anonymous indices, so the user — never a heuristic — decides who the
 * interviewer is. Nothing is answered until at least one voice holds an
 * interviewer role.
 */
import { Crown, EarOff, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  SPEAKER_ROLE_LABELS,
  SPEAKER_ROLE_ORDER,
  roleDrivesAnswers,
  type RemoteSpeaker,
  type SpeakerRole,
} from "@/lib/speakers";
import { cn } from "@/lib/utils";

type Props = {
  speakers: RemoteSpeaker[];
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
  autoAssignFirst: boolean;
  onAutoAssignChange: (value: boolean) => void;
  onSetRole: (id: string, role: SpeakerRole) => void;
  onSetPrimary: (id: string) => void;
  onRename: (id: string, label: string) => void;
  note: string;
  /** Honest statement of what the audio source itself can deliver. */
  sourceLabel: string;
  capabilityLabel: string;
  separationStatus: string;
  speakerAwareAvailable: boolean;
  autoFallbackEnabled: boolean;
  onAutoFallbackChange: (value: boolean) => void;
  autoFallbackActive: boolean;
};

const ROLE_TONE: Record<SpeakerRole, string> = {
  primary_interviewer: "border-primary/60 bg-primary/10 text-primary",
  interviewer: "border-primary/30 bg-primary/[0.06] text-foreground",
  other: "border-border bg-muted/40 text-muted-foreground",
  ignore: "border-border bg-muted/20 text-muted-foreground line-through",
  unassigned: "border-warning/40 bg-warning/[0.08] text-warning",
};

export function ParticipantsPanel({
  speakers,
  enabled,
  onEnabledChange,
  autoAssignFirst,
  onAutoAssignChange,
  onSetRole,
  onSetPrimary,
  onRename,
  note,
}: Props) {
  const answering = speakers.filter((s) => roleDrivesAnswers(s.role)).length;
  const waiting = enabled && speakers.length > 0 && answering === 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-[11px] font-medium transition-colors duration-200",
            waiting
              ? "border-warning/40 bg-warning/[0.08] text-warning hover:bg-warning/[0.14]"
              : "border-border/70 bg-card/50 text-muted-foreground hover:text-foreground",
          )}
          title="Assign who counts as the interviewer when several people are on the call"
        >
          <Users className="size-3.5" />
          Participants
          <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
            {speakers.length}
          </span>
        </button>
      </PopoverTrigger>

      <PopoverContent side="top" align="start" className="w-[340px] space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Multi-participant routing</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Separates every remote voice so only the interviewer triggers answers.
            </p>
          </div>
          <Switch checked={enabled} onCheckedChange={onEnabledChange} />
        </div>

        <label className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/30 px-2.5 py-2">
          <span className="text-[11px] text-muted-foreground">
            Assume the first voice heard is the interviewer
          </span>
          <Switch
            checked={autoAssignFirst}
            onCheckedChange={onAutoAssignChange}
            disabled={!enabled}
          />
        </label>

        {waiting ? (
          <p className="rounded-lg border border-warning/40 bg-warning/[0.08] px-2.5 py-2 text-[11px] text-warning">
            No interviewer assigned yet — answers are paused until you pick one.
          </p>
        ) : null}

        <div className="max-h-[46vh] space-y-2 overflow-y-auto">
          {speakers.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {enabled
                ? "Nobody heard yet. Voices appear here as soon as they speak."
                : "Routing is off — all remote audio is treated as one interviewer."}
            </p>
          ) : null}

          {speakers.map((speaker) => (
            <div
              key={speaker.id}
              className={cn("rounded-xl border p-2.5", ROLE_TONE[speaker.role])}
            >
              <div className="flex items-center gap-2">
                <Input
                  value={speaker.label}
                  onChange={(event) => onRename(speaker.id, event.target.value)}
                  className="h-7 flex-1 bg-background/60 text-xs"
                  aria-label={`Name for ${speaker.label}`}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  title="Make primary interviewer"
                  onClick={() => onSetPrimary(speaker.id)}
                >
                  <Crown
                    className={cn(
                      "size-3.5",
                      speaker.role === "primary_interviewer" && "fill-primary text-primary",
                    )}
                  />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  title="Ignore this participant"
                  onClick={() => onSetRole(speaker.id, "ignore")}
                >
                  <EarOff className="size-3.5" />
                </Button>
              </div>

              <p className="mt-1.5 truncate text-[10px] text-muted-foreground" title={speaker.lastText}>
                {speaker.lastText || "…"}
              </p>

              <div className="mt-2 flex flex-wrap gap-1">
                {SPEAKER_ROLE_ORDER.map((role) => (
                  <button
                    key={role}
                    type="button"
                    onClick={() => (role === "primary_interviewer" ? onSetPrimary(speaker.id) : onSetRole(speaker.id, role))}
                    className={cn(
                      "rounded-md border px-1.5 py-0.5 text-[10px] transition-colors duration-200",
                      speaker.role === role
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {SPEAKER_ROLE_LABELS[role]}
                  </button>
                ))}
              </div>

              <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                {speaker.segments} segment{speaker.segments === 1 ? "" : "s"} · id {speaker.id}
              </p>
            </div>
          ))}
        </div>

        <p className="font-mono text-[10px] text-muted-foreground">{note}</p>
      </PopoverContent>
    </Popover>
  );
}
