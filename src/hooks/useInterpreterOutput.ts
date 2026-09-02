/**
 * Native interpreter output — isolated, additive, feature-flagged.
 *
 * Owns pairing + connection to the desktop companion for the OUTGOING
 * interpreter voice only. It never touches capture, STT, diarization, turn
 * assembly, answers or the overlay. When the flag is off, or the companion is
 * missing, `speak()` returns false and the caller keeps using the existing
 * browser `<audio>` playback path unchanged.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { detectCompanion } from "@/lib/companion/companion-client";
import { createCompanionPairing, getCompanionPairing } from "@/lib/companion.functions";
import {
  nativeInterpreterOutputEnabled,
  setNativeInterpreterOutputEnabled,
} from "@/lib/audio/interpreter-output/feature-flag";
import { decodeSpeechToPcm16 } from "@/lib/audio/interpreter-output/pcm";
import {
  EMPTY_NATIVE_STATS,
  EMPTY_VIRTUAL_MIC,
  VIRTUAL_MIC_DEVICE_ID,
  NativeInterpreterOutput,
  type VirtualMicStatus,
  type NativeOutputState,
  type NativeOutputStats,
} from "@/lib/audio/interpreter-output/native-output-client";

type Input = {
  sessionId?: string;
  /** Native output device id/name to render to (empty = system default). */
  deviceId?: string;
};

export type InterpreterOutputController = {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  state: NativeOutputState;
  detail: string;
  stats: NativeOutputStats;
  pairingCode: string | null;
  busy: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  /** Returns true when the utterance was rendered natively. */
  speak: (base64: string) => Promise<boolean>;
  /** Branded InterviewCopilot Virtual Microphone health (Phase 2). */
  virtualMic: VirtualMicStatus;
  lastEncodeMs: number | null;
};

export function useInterpreterOutput(input: Input): InterpreterOutputController {
  const [enabled, setEnabledState] = useState(false);
  const [state, setState] = useState<NativeOutputState>("disabled");
  const [detail, setDetail] = useState("");
  const [stats, setStats] = useState<NativeOutputStats>(EMPTY_NATIVE_STATS);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastEncodeMs, setLastEncodeMs] = useState<number | null>(null);
  const [virtualMic, setVirtualMic] = useState<VirtualMicStatus>(EMPTY_VIRTUAL_MIC);

  const client = useRef<NativeInterpreterOutput | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setEnabledState(nativeInterpreterOutputEnabled());
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setNativeInterpreterOutputEnabled(next);
    setEnabledState(next);
    if (!next) {
      client.current?.disconnect();
      client.current = null;
      setState("disabled");
    }
  }, []);

  const attach = useCallback((port: number, token: string, deviceId: string) => {
    client.current?.disconnect();
    const c = new NativeInterpreterOutput(port, token, {
      onState: (s, d) => {
        setState(s);
        if (d) setDetail(d);
      },
      onStats: setStats,
      onVirtualMic: setVirtualMic,
    });
    client.current = c;
    c.connect(deviceId);
  }, []);

  const connect = useCallback(async () => {
    if (!enabled || !input.sessionId) return;
    setBusy(true);
    setDetail("");
    try {
      const health = await detectCompanion();
      if (!health) {
        setState("unavailable");
        setDetail("Desktop Companion is not running — using browser playback.");
        return;
      }
      const pairing = await createCompanionPairing({ data: { sessionId: input.sessionId } });
      setPairingCode(pairing.code);
      if (poll.current) clearInterval(poll.current);
      poll.current = setInterval(async () => {
        try {
          const st = await getCompanionPairing({ data: { pairingId: pairing.pairingId } });
          if (st.approved && st.bridgeToken) {
            if (poll.current) clearInterval(poll.current);
            poll.current = null;
            setPairingCode(null);
            attach(health.port, st.bridgeToken, input.deviceId ?? VIRTUAL_MIC_DEVICE_ID);
          } else if (st.status === "expired" || st.status === "revoked") {
            if (poll.current) clearInterval(poll.current);
            poll.current = null;
            setPairingCode(null);
            setState("unavailable");
            setDetail("Pairing code expired.");
          }
        } catch {
          /* keep polling */
        }
      }, 2000);
    } catch (error) {
      setState("error");
      setDetail(error instanceof Error ? error.message : "Could not reach the companion.");
    } finally {
      setBusy(false);
    }
  }, [attach, enabled, input.deviceId, input.sessionId]);

  const disconnect = useCallback(() => {
    if (poll.current) clearInterval(poll.current);
    poll.current = null;
    setPairingCode(null);
    client.current?.disconnect();
    client.current = null;
    setState("disabled");
    setStats(EMPTY_NATIVE_STATS);
    setVirtualMic(EMPTY_VIRTUAL_MIC);
  }, []);

  /** Re-bind when the user picks a different native output device. */
  useEffect(() => {
    if (client.current?.connected) client.current.open(input.deviceId ?? VIRTUAL_MIC_DEVICE_ID);
  }, [input.deviceId]);

  useEffect(
    () => () => {
      if (poll.current) clearInterval(poll.current);
      client.current?.disconnect();
      client.current = null;
    },
    [],
  );

  const speak = useCallback(
    async (base64: string) => {
      if (!enabled) return false;
      const c = client.current;
      if (!c?.connected) return false;
      try {
        const t0 = performance.now();
        const decoded = await decodeSpeechToPcm16(base64);
        setLastEncodeMs(Math.round(performance.now() - t0));
        return c.sendPcm(decoded.pcm);
      } catch (error) {
        // Any failure degrades to the existing browser playback path.
        setDetail(error instanceof Error ? error.message : "Native output failed.");
        setState("error");
        return false;
      }
    },
    [enabled],
  );

  return {
    enabled,
    setEnabled,
    state,
    detail,
    stats,
    pairingCode,
    busy,
    connect,
    disconnect,
    speak,
    virtualMic,
    lastEncodeMs,
  };
}
