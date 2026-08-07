import { Apple, Download, Loader2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { formatBytes, useMacRelease } from "@/lib/releases";
import { cn } from "@/lib/utils";

/**
 * Download CTA for the native macOS companion.
 * The button only becomes active once a genuine, activated .dmg release exists —
 * otherwise it states the build is still being prepared.
 */
export function MacDownloadButton({
  size = "lg",
  className,
  showMeta = true,
}: {
  size?: "sm" | "default" | "lg";
  className?: string;
  showMeta?: boolean;
}) {
  const { data: release, isLoading } = useMacRelease();

  if (isLoading) {
    return (
      <Button size={size} disabled className={className}>
        <Loader2 className="size-4 animate-spin" /> Checking for the latest build…
      </Button>
    );
  }

  if (!release) {
    return (
      <div className={cn("space-y-1.5", className)}>
        <Button size={size} disabled>
          <Apple className="size-4" /> macOS build preparing
        </Button>
        {showMeta ? (
          <p className="text-xs text-muted-foreground">
            The signed macOS installer is not published yet. This button activates automatically as soon as a real
            build is uploaded.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn("space-y-1.5", className)}>
      <Button size={size} asChild>
        <a href={release.downloadUrl} download={release.fileName} rel="noopener">
          <Download className="size-4" /> Download for macOS
        </a>
      </Button>
      {showMeta ? (
        <p className="text-xs text-muted-foreground">
          {release.fileName} · v{release.version}
          {formatBytes(release.fileSize) ? ` · ${formatBytes(release.fileSize)}` : ""} · Apple Silicon · macOS{" "}
          {release.minimumOs ?? "13"}+{release.isTestBuild ? " · unsigned test build" : ""}
        </p>
      ) : null}
    </div>
  );
}

/** Compact card used inside session setup surfaces. */
export function CompanionRequiredCard({ onCheckAgain }: { onCheckAgain?: () => void }) {
  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-4">
      <p className="text-sm font-medium">InterviewCopilot Companion required</p>
      <p className="mt-1 text-xs text-muted-foreground">
        To use Zoom Desktop, install the lightweight InterviewCopilot Companion. macOS 13+ · Apple Silicon.
      </p>
      <div className="mt-3 flex flex-wrap items-start gap-3">
        <MacDownloadButton size="sm" showMeta={false} />
        {onCheckAgain ? (
          <Button size="sm" variant="outline" onClick={onCheckAgain}>
            Check again
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" asChild>
          <Link to="/download">Install instructions</Link>
        </Button>
      </div>
    </div>
  );
}
