import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [
      { title: "Settings — InterviewCopilot" },
      { name: "description", content: "Control answer style, length, language and detection sensitivity for your copilot." },
      { property: "og:title", content: "Settings — InterviewCopilot" },
      { property: "og:description", content: "Tune how your interview copilot answers." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Settings,
});

function Settings() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    full_name: "",
    default_answer_style: "natural",
    default_answer_length: "medium",
    answer_language: "en",
    auto_generate_answers: true,
  });
  const [busy, setBusy] = useState(false);

  const { data: profile } = useQuery({
    queryKey: ["profile"],
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("*").maybeSingle();
      return data;
    },
  });

  useEffect(() => {
    if (profile) {
      setForm({
        full_name: profile.full_name ?? "",
        default_answer_style: profile.default_answer_style,
        default_answer_length: profile.default_answer_length,
        answer_language: profile.answer_language,
        auto_generate_answers: profile.auto_generate_answers,
      });
    }
  }, [profile]);

  const save = async () => {
    setBusy(true);
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return;
    const { error } = await supabase.from("profiles").update(form).eq("user_id", auth.user.id);
    setBusy(false);
    if (error) toast.error(error.message);
    else {
      toast.success("Settings saved");
      void queryClient.invalidateQueries({ queryKey: ["profile"] });
    }
  };

  return (
    <AppShell title="Settings">
      <div className="grid max-w-2xl gap-6">
        <section className="panel grid gap-4 p-6">
          <div className="space-y-1.5">
            <Label htmlFor="name">Full name</Label>
            <Input
              id="name"
              value={form.full_name}
              onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Answer style">
              <Select
                value={form.default_answer_style}
                onValueChange={(v) => setForm((f) => ({ ...f, default_answer_style: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="natural">Natural</SelectItem>
                  <SelectItem value="star">STAR method</SelectItem>
                  <SelectItem value="bullets">Bullet points</SelectItem>
                  <SelectItem value="technical">Technical depth</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Answer length">
              <Select
                value={form.default_answer_length}
                onValueChange={(v) => setForm((f) => ({ ...f, default_answer_length: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="short">Short</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="detailed">Detailed</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Language">
              <Select
                value={form.answer_language}
                onValueChange={(v) => setForm((f) => ({ ...f, answer_language: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="es">Spanish</SelectItem>
                  <SelectItem value="de">German</SelectItem>
                  <SelectItem value="fr">French</SelectItem>
                  <SelectItem value="pt">Portuguese</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border p-4">
            <div>
              <p className="text-sm font-medium">Auto-generate answers</p>
              <p className="text-xs text-muted-foreground">
                Start streaming as soon as a question is detected.
              </p>
            </div>
            <Switch
              checked={form.auto_generate_answers}
              onCheckedChange={(v) => setForm((f) => ({ ...f, auto_generate_answers: v }))}
            />
          </div>

          <div className="flex justify-end">
            <Button onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save settings"}
            </Button>
          </div>
        </section>

        <section className="panel p-6 text-sm text-muted-foreground">
          <h2 className="mb-2 text-sm font-semibold text-foreground">Honesty guardrails</h2>
          <p>
            Answers are built only from your uploaded resume and the job description. The model is instructed never
            to invent employers, metrics or years of experience — if something isn't in your documents, it will say
            so rather than fabricate it.
          </p>
        </section>
      </div>
    </AppShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
