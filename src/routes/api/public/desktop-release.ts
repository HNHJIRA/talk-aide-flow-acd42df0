import { createFileRoute } from "@tanstack/react-router";
import { getActiveDesktopRelease } from "@/lib/releases.functions";

/**
 * Public, read-only release metadata for the desktop companion.
 * Only safe fields are returned — no storage credentials.
 */
export const Route = createFileRoute("/api/public/desktop-release")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const platform = url.searchParams.get("platform") === "windows" ? "windows" : "macos";
        const release = await getActiveDesktopRelease({ data: { platform } });
        if (!release) {
          return Response.json({ platform, available: false }, { headers: { "cache-control": "no-store" } });
        }
        return Response.json(
          {
            platform: release.platform,
            architecture: release.architecture,
            version: release.version,
            downloadUrl: release.downloadUrl,
            fileName: release.fileName,
            fileSize: release.fileSize,
            minimumOs: release.minimumOs,
            isTestBuild: release.isTestBuild,
            available: true,
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
