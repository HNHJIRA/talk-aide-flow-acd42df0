export type Capabilities = {
  secureContext: boolean;
  hasMediaDevices: boolean;
  hasGetUserMedia: boolean;
  hasGetDisplayMedia: boolean;
  browser: string;
  os: string;
  chromium: boolean;
  meetingAudioLikely: boolean;
};

export function detectCapabilities(): Capabilities {
  if (typeof window === "undefined") {
    return {
      secureContext: false,
      hasMediaDevices: false,
      hasGetUserMedia: false,
      hasGetDisplayMedia: false,
      browser: "unknown",
      os: "unknown",
      chromium: false,
      meetingAudioLikely: false,
    };
  }
  const ua = navigator.userAgent;
  const chromium = /Chrome|Chromium|Edg\//.test(ua) && !/OPR\//.test(ua);
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome|Chromium/.test(ua)
      ? "Chrome"
      : /Firefox/.test(ua)
        ? "Firefox"
        : /Safari/.test(ua)
          ? "Safari"
          : "Unknown";
  const os = /Mac OS X/.test(ua)
    ? "macOS"
    : /Windows/.test(ua)
      ? "Windows"
      : /Linux/.test(ua)
        ? "Linux"
        : /Android/.test(ua)
          ? "Android"
          : /iPhone|iPad/.test(ua)
            ? "iOS"
            : "Unknown";

  const md = navigator.mediaDevices as MediaDevices | undefined;
  const hasGetDisplayMedia = typeof md?.getDisplayMedia === "function";

  return {
    secureContext: window.isSecureContext,
    hasMediaDevices: !!md,
    hasGetUserMedia: typeof md?.getUserMedia === "function",
    hasGetDisplayMedia,
    browser,
    os,
    chromium,
    meetingAudioLikely: chromium && hasGetDisplayMedia && (os === "macOS" || os === "Windows" || os === "Linux"),
  };
}
