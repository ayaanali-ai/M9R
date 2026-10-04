"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import styles from "../room-url.module.css";

const MAX_FRAME_BYTES = 30 * 1024;
const MAX_FRAME_AGE_MS = 4_000;
const MAX_STREAM_MS = 5 * 60_000;
const FRAME_INTERVAL_MS = 333;
const MAX_FRAME_WIDTH = 800;
const MAX_FRAME_HEIGHT = 450;

type LiveFrame = {
  streamId: string;
  displayName: string;
  capturedAt: number;
  sequence: number;
  image: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not encode the live frame."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) reject(new Error("Could not encode the live frame."));
      else resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function validFramePayload(value: unknown): LiveFrame | null {
  if (!isRecord(value)) return null;
  const streamId = typeof value.streamId === "string" ? value.streamId : "";
  const displayName = typeof value.displayName === "string" ? value.displayName.slice(0, 80) : "Room member";
  const capturedAt = typeof value.capturedAt === "number" ? value.capturedAt : 0;
  const sequence = typeof value.sequence === "number" ? value.sequence : -1;
  const image = typeof value.image === "string" ? value.image : "";
  if (!/^[0-9a-f-]{36}$/i.test(streamId) || !Number.isSafeInteger(sequence) || sequence < 0) return null;
  if (!Number.isFinite(capturedAt) || Date.now() - capturedAt > MAX_FRAME_AGE_MS || capturedAt > Date.now() + 5_000) return null;
  if (!image || image.length > Math.ceil(MAX_FRAME_BYTES * 4 / 3) + 8) return null;
  return { streamId, displayName, capturedAt, sequence, image };
}

export default function RoomLiveView({ roomId, displayName }: { roomId: string; displayName: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const channelRef = useRef<ReturnType<NonNullable<ReturnType<typeof createClient>>["channel"]> | null>(null);
  const streamIdRef = useRef("");
  const frameSequenceRef = useRef(0);
  const frameBusyRef = useRef(false);
  const relayConnectedRef = useRef(false);
  const componentActiveRef = useRef(false);
  const membershipInvalidRef = useRef(false);
  const stopRef = useRef<() => void>(() => {});
  const [connected, setConnected] = useState(false);
  const [starting, setStarting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frames, setFrames] = useState<Record<string, LiveFrame>>({});

  useEffect(() => {
    let disposed = false;
    componentActiveRef.current = true;
    membershipInvalidRef.current = false;
    const supabase = createClient();
    if (!supabase) {
      setError("Live view is unavailable because Supabase is not configured.");
      return;
    }
    const channel = supabase.channel(`m9r-room-live:${roomId}`, {
      config: { private: true, broadcast: { ack: true, self: false } },
    });
    channelRef.current = channel;
    channel.on("broadcast", { event: "screen-frame" }, (message) => {
      if (disposed) return;
      const frame = validFramePayload(message.payload);
      if (!frame || frame.streamId === streamIdRef.current) return;
      setFrames((current) => {
        const previous = current[frame.streamId];
        if (previous && previous.sequence >= frame.sequence) return current;
        return { ...current, [frame.streamId]: frame };
      });
    });
    channel.on("broadcast", { event: "screen-stop" }, (message) => {
      const payload = isRecord(message.payload) ? message.payload : null;
      if (typeof payload?.streamId !== "string") return;
      setFrames((current) => {
        if (!current[payload.streamId as string]) return current;
        const next = { ...current };
        delete next[payload.streamId as string];
        return next;
      });
    });
    channel.subscribe((status) => {
      if (disposed) return;
      const ready = status === "SUBSCRIBED";
      relayConnectedRef.current = ready;
      setConnected(ready);
      if (!ready && status === "CHANNEL_ERROR") setError("Room live view disconnected. Sharing has stopped.");
      if (!ready) stopRef.current();
      else setError(null);
    });

    const membershipGuard = window.setInterval(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, { cache: "no-store" });
          const data = await response.json().catch(() => ({})) as { membership?: { status?: string } };
          if (response.ok && data.membership?.status === "active") return;
        } catch {
          // A failed membership check fails closed for this live stream.
        }
        if (disposed || membershipInvalidRef.current) return;
        membershipInvalidRef.current = true;
        setError("Room access could not be confirmed. Live view has stopped.");
        setConnected(false);
        setFrames({});
        stopRef.current();
        if (channelRef.current === channel) channelRef.current = null;
        void supabase.removeChannel(channel);
      })();
    }, 2_000);

    const expiry = window.setInterval(() => {
      const cutoff = Date.now() - MAX_FRAME_AGE_MS;
      setFrames((current) => {
        const next = Object.fromEntries(Object.entries(current).filter(([, frame]) => frame.capturedAt >= cutoff));
        return Object.keys(next).length === Object.keys(current).length ? current : next;
      });
    }, 1_000);
    return () => {
      disposed = true;
      componentActiveRef.current = false;
      relayConnectedRef.current = false;
      window.clearInterval(membershipGuard);
      window.clearInterval(expiry);
      stopRef.current();
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [roomId]);

  const stopSharing = useCallback(() => {
    const stream = mediaRef.current;
    const streamId = streamIdRef.current;
    mediaRef.current = null;
    streamIdRef.current = "";
    frameBusyRef.current = false;
    if (videoRef.current) videoRef.current.srcObject = null;
    stream?.getTracks().forEach((track) => track.stop());
    setSharing(false);
    if (streamId && channelRef.current) {
      void channelRef.current.send({ type: "broadcast", event: "screen-stop", payload: { streamId } }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    stopRef.current = stopSharing;
  }, [stopSharing]);

  useEffect(() => {
    if (!sharing) return;
    const handleVisibility = () => { if (document.visibilityState !== "visible") stopSharing(); };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [sharing, stopSharing]);

  async function startSharing() {
    if (starting || sharing) return;
    setError(null);
    if (!connected || !channelRef.current) {
      setError("Wait for the room live connection before starting a share.");
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError("This browser does not support tab sharing. Use current Chrome or Edge.");
      return;
    }

    setStarting(true);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 3, max: 3 }, width: { max: MAX_FRAME_WIDTH }, height: { max: MAX_FRAME_HEIGHT } },
        audio: false,
      });
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === "NotAllowedError")) {
        setError("Could not start tab sharing. Check the browser's screen-capture permission and try again.");
      }
      setStarting(false);
      return;
    }

    if (!componentActiveRef.current || !relayConnectedRef.current || !channelRef.current) {
      stream.getTracks().forEach((item) => item.stop());
      setStarting(false);
      return;
    }

    const track = stream.getVideoTracks()[0];
    const surface = track?.getSettings().displaySurface;
    if (!track || surface !== "browser") {
      stream.getTracks().forEach((item) => item.stop());
      setError("Choose a browser tab in the sharing picker. Window and full-screen sharing are disabled for this room view.");
      setStarting(false);
      return;
    }

    const streamId = crypto.randomUUID();
    mediaRef.current = stream;
    streamIdRef.current = streamId;
    frameSequenceRef.current = 0;
    setSharing(true);
    setStarting(false);
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      void videoRef.current.play().catch(() => {});
    }
    track.addEventListener("ended", stopSharing, { once: true });
    let startResult: string;
    try {
      startResult = await channelRef.current.send({
        type: "broadcast",
        event: "screen-start",
        payload: { streamId, displayName: displayName.slice(0, 80), startedAt: Date.now() },
      });
    } catch {
      startResult = "error";
    }
    if (startResult !== "ok") {
      setError("The room relay did not accept the share. Sharing has stopped.");
      stopSharing();
      return;
    }

    const deadline = Date.now() + MAX_STREAM_MS;
    const timer = window.setInterval(() => {
      if (!mediaRef.current || streamIdRef.current !== streamId || Date.now() >= deadline) {
        window.clearInterval(timer);
        if (streamIdRef.current === streamId) stopSharing();
        return;
      }
      if (frameBusyRef.current) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d", { alpha: false });
      if (!video || !canvas || !context || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return;
      frameBusyRef.current = true;
      const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth, MAX_FRAME_HEIGHT / video.videoHeight);
      canvas.width = Math.max(1, Math.floor(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.floor(video.videoHeight * scale));
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(async (blob) => {
        try {
          if (!blob || blob.size > MAX_FRAME_BYTES || !channelRef.current || streamIdRef.current !== streamId) return;
          const image = await blobToBase64(blob);
          const payload = {
            streamId,
            displayName: displayName.slice(0, 80),
            capturedAt: Date.now(),
            sequence: frameSequenceRef.current++,
            image,
          };
          const sendResult = await channelRef.current.send({ type: "broadcast", event: "screen-frame", payload });
          if (sendResult !== "ok") throw new Error("The room relay rejected a live frame.");
        } catch {
          setError("A live frame could not be sent. Sharing has stopped.");
          stopSharing();
        } finally {
          frameBusyRef.current = false;
        }
      }, "image/jpeg", 0.48);
    }, FRAME_INTERVAL_MS);
  }

  return (
    <section className={styles.panel} aria-label="Live tab view">
      <h2 style={{ marginTop: 0 }}>Live tab view <span aria-live="polite" style={{ fontSize: 13, fontWeight: 400 }}>· {connected ? "Room relay connected" : "Connecting"}</span></h2>
      <p className={styles.muted}>Share a selected browser tab with admitted room members. The stream is view-only, sent at up to 3 frames per second, and stops after five minutes or when this page is hidden. Frames are not saved in room history.</p>
      <p className={styles.muted}>The browser shows its own tab-sharing picker. Choose only a tab that is safe for every admitted member to see. Do not expose passwords, payment details, or other sensitive information.</p>
      {error && <p className={styles.inlineError} role="alert">{error}</p>}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        {sharing
          ? <button type="button" onClick={stopSharing}>Stop sharing this tab</button>
          : <button type="button" onClick={() => void startSharing()} disabled={!connected || starting}>{starting ? "Choose a tab…" : "Share a browser tab"}</button>}
        {sharing && <span role="status">Your selected tab is being shared with admitted room members.</span>}
      </div>
      {sharing && <video ref={videoRef} muted playsInline aria-label="Local preview of the selected shared tab" style={{ display: "block", width: "min(100%, 800px)", marginTop: 12, background: "#090909" }} />}
      <canvas ref={canvasRef} aria-hidden="true" style={{ display: "none" }} />
      {Object.values(frames).length > 0 ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 12, marginTop: 16 }}>
          {Object.values(frames).map((frame) => (
            <figure key={frame.streamId} style={{ margin: 0 }}>
              <figcaption style={{ marginBottom: 6 }}>{frame.displayName} — live tab (view only)</figcaption>
              <img src={`data:image/jpeg;base64,${frame.image}`} alt={`Live shared browser tab from ${frame.displayName}`} style={{ display: "block", width: "100%", background: "#090909" }} />
            </figure>
          ))}
        </div>
      ) : <p className={styles.muted} style={{ marginBottom: 0, marginTop: 12 }}>No one is sharing a tab right now.</p>}
    </section>
  );
}
