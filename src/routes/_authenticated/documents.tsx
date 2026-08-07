import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Star, Trash2, UploadCloud } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { chunkDocument, cleanText, extractText } from "@/lib/documents";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/documents")({
  head: () => ({
    meta: [
      { title: "Documents — InterviewCopilot" },
      { name: "description", content: "Upload and manage the resume and supporting documents that ground your AI answers." },
      { property: "og:title", content: "Documents — InterviewCopilot" },
      { property: "og:description", content: "Manage your primary resume and supporting documents." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Documents,
});

const ACCEPTED = [".pdf", ".docx", ".txt", ".md"];
const MAX_BYTES = 10 * 1024 * 1024;

function Documents() {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);

  const { data: documents } = useQuery({
    queryKey: ["documents"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("documents")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > MAX_BYTES) throw new Error("Files must be 10 MB or smaller.");
      const ext = `.${file.name.split(".").pop()?.toLowerCase()}`;
      if (!ACCEPTED.includes(ext)) throw new Error("Supported formats: PDF, DOCX, TXT, MD.");

      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) throw new Error("Not signed in.");
      setBusyName(file.name);

      const path = `${auth.user.id}/resumes/${crypto.randomUUID()}-${file.name}`;
      const { error: uploadError } = await supabase.storage.from("user-documents").upload(path, file);
      if (uploadError) throw uploadError;

      const { data: row, error: insertError } = await supabase
        .from("documents")
        .insert({
          user_id: auth.user.id,
          type: "resume",
          file_name: file.name,
          mime_type: file.type,
          file_size: file.size,
          storage_path: path,
          processing_status: "processing",
        })
        .select("id")
        .single();
      if (insertError) throw insertError;

      try {
        const text = cleanText(await extractText(file));
        if (!text || text.length < 40) throw new Error("No readable text found in this file.");
        const chunks = chunkDocument(text);
        await supabase.from("document_chunks").insert(
          chunks.map((chunk) => ({ ...chunk, document_id: row.id, user_id: auth.user!.id })),
        );
        const existingPrimary = documents?.some((doc) => doc.is_primary);
        await supabase
          .from("documents")
          .update({
            extracted_text: text.slice(0, 200_000),
            processing_status: "ready",
            is_primary: !existingPrimary,
            metadata: { chunks: chunks.length, characters: text.length },
          })
          .eq("id", row.id);
      } catch (error) {
        await supabase
          .from("documents")
          .update({
            processing_status: "error",
            error_message: error instanceof Error ? error.message : "Processing failed",
          })
          .eq("id", row.id);
        throw error;
      }
    },
    onSuccess: () => {
      toast.success("Resume processed and ready");
      void queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Upload failed"),
    onSettled: () => setBusyName(null),
  });

  const setPrimary = useMutation({
    mutationFn: async (id: string) => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) throw new Error("Not signed in.");
      await supabase.from("documents").update({ is_primary: false }).eq("user_id", auth.user.id);
      const { error } = await supabase.from("documents").update({ is_primary: true }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["documents"] }),
  });

  const remove = useMutation({
    mutationFn: async (doc: { id: string; storage_path: string | null }) => {
      if (doc.storage_path) await supabase.storage.from("user-documents").remove([doc.storage_path]);
      const { error } = await supabase.from("documents").delete().eq("id", doc.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Document deleted");
      void queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
  });

  const handleFiles = (files: FileList | null) => {
    if (!files?.length) return;
    Array.from(files).forEach((file) => upload.mutate(file));
  };

  return (
    <AppShell title="Documents">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={cn(
          "panel mb-6 flex flex-col items-center justify-center gap-3 border-dashed p-12 text-center transition-colors",
          dragging && "border-primary bg-surface",
        )}
      >
        <UploadCloud className="size-6 text-primary" />
        <p className="text-sm font-medium">Drop your resume here</p>
        <p className="text-xs text-muted-foreground">PDF, DOCX, TXT or MD · up to 10 MB · processed in your browser</p>
        <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={upload.isPending}>
          {upload.isPending ? `Processing ${busyName}…` : "Choose file"}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED.join(",")}
          className="hidden"
          multiple
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      <div className="grid gap-3">
        {documents?.map((doc) => (
          <article key={doc.id} className="panel flex flex-wrap items-center justify-between gap-4 p-5">
            <div className="min-w-0">
              <p className="flex items-center gap-2 truncate text-sm font-medium">
                {doc.file_name}
                {doc.is_primary ? (
                  <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-primary">
                    Primary
                  </span>
                ) : null}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatBytes(doc.file_size)} · {doc.processing_status}
                {doc.error_message ? ` · ${doc.error_message}` : ""} ·{" "}
                {new Date(doc.created_at).toLocaleDateString()}
              </p>
            </div>
            <div className="flex gap-2">
              {!doc.is_primary && doc.processing_status === "ready" ? (
                <Button variant="outline" size="sm" onClick={() => setPrimary.mutate(doc.id)}>
                  <Star className="size-4" /> Set primary
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove.mutate({ id: doc.id, storage_path: doc.storage_path })}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </article>
        ))}
        {documents && documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No documents yet.</p>
        ) : null}
      </div>
    </AppShell>
  );
}
