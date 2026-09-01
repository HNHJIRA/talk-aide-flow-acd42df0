/**
 * Live-session translation strip: status, language pair and quick controls.
 * Presentation only — it reads the translation layer and never touches audio.
 */
import { Languages, ArrowLeftRight, Pause, Play, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  SOURCE_LANGUAGES,
  TARGET_LANGUAGES,
  languageLabel,
  type LanguageCode,
  type TranslationSettings,
} from "@/lib/translation/translation-protocol";

type Props = {
  settings: TranslationSettings;
  patch: (next: Partial<TranslationSettings>) => void;
  active: boolean;
  detectedLanguage: string;
  answerLanguage: string;
  onSwap: () => void;
};

export function TranslationBar({
  settings,
  patch,
  active,
  detectedLanguage,
  answerLanguage,
  onSwap,
}: Props) {
  const from = languageLabel(
    settings.sourceLanguage === "auto" ? detectedLanguage || "auto" : settings.sourceLanguage,
  );
  const to = languageLabel(settings.targetLanguage);

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card/40 px-4 py-1.5 text-xs">
      <span className="flex items-center gap-2">
        <span
          className={cn(
            "size-2 rounded-full",
            active ? "bg-success" : settings.enabled ? "bg-warning" : "bg-muted-foreground/40",
          )}
        />
        <Languages className="size-3.5 text-muted-foreground" />
        <span className="font-medium">
          {active
            ? "Translation active"
            : settings.enabled
              ? "Translation paused"
              : "Translation off"}
        </span>
      </span>

      {settings.enabled ? (
        <span className="text-muted-foreground">
          {from} → {to}
        </span>
      ) : null}

      <span className="ml-auto flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-[11px]"
          onClick={onSwap}
          disabled={!settings.enabled}
        >
          <ArrowLeftRight className="size-3.5" /> Swap
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-[11px]"
          onClick={() => patch({ paused: !settings.paused })}
          disabled={!settings.enabled}
        >
          {settings.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          {settings.paused ? "Resume" : "Pause"}
        </Button>

        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-[11px]">
              <Settings2 className="size-3.5" /> Languages
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Enable translation</Label>
              <Switch
                checked={settings.enabled}
                onCheckedChange={(v) => patch({ enabled: v, paused: false })}
              />
            </div>
            <Picker
              label="Interviewer speaks"
              value={settings.sourceLanguage}
              options={SOURCE_LANGUAGES}
              onChange={(v) => patch({ sourceLanguage: v })}
            />
            <Picker
              label="I want to understand"
              value={settings.targetLanguage}
              options={TARGET_LANGUAGES}
              onChange={(v) => patch({ targetLanguage: v })}
            />
            <Picker
              label="My response language"
              value={settings.responseLanguage}
              options={TARGET_LANGUAGES}
              onChange={(v) => patch({ responseLanguage: v })}
            />
            <div className="flex items-center justify-between">
              <Label className="text-xs">Translate my microphone too</Label>
              <Switch
                checked={settings.translateMySpeech}
                onCheckedChange={(v) => patch({ translateMySpeech: v })}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              AI answers are written in {languageLabel(answerLanguage)}.
            </p>
          </PopoverContent>
        </Popover>
      </span>
    </div>
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
