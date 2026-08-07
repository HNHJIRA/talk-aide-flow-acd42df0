import { useQuery } from "@tanstack/react-query";
import { getActiveDesktopRelease, type PublicRelease } from "@/lib/releases.functions";

export type VisitorOs = "macos" | "windows" | "other";

/** Best-effort OS detection. Never used to hide other platforms from the user. */
export function detectVisitorOs(): VisitorOs {
  if (typeof navigator === "undefined") return "other";
  const ua = `${navigator.userAgent} ${navigator.platform ?? ""}`.toLowerCase();
  if (ua.includes("mac")) return "macos";
  if (ua.includes("win")) return "windows";
  return "other";
}

export function formatBytes(bytes: number | null | undefined) {
  if (!bytes) return null;
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

/** Active macOS companion release, or null when no genuine build is published. */
export function useMacRelease() {
  return useQuery<PublicRelease | null>({
    queryKey: ["desktop-release", "macos"],
    queryFn: () => getActiveDesktopRelease({ data: { platform: "macos" } }),
    staleTime: 5 * 60 * 1000,
  });
}
