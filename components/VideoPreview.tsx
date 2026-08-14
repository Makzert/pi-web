"use client";

import { useEffect, useRef, useState } from "react";

interface VideoPreviewProps {
  src: string;
  candidates?: string[];
  label?: string;
  bytes?: number;
  refresh?: { node: string; path: string };
}

function formatBytes(bytes?: number): string {
  if (!Number.isFinite(bytes) || !bytes || bytes < 0) return "";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function uniqueSources(src: string, candidates?: string[]): string[] {
  return [...new Set([...(candidates ?? []), src].filter((value): value is string => typeof value === "string" && value.length > 0))];
}

async function probeSource(url: string): Promise<number> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 1800);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (response.status !== 200 && response.status !== 206) {
      throw new Error(`media probe HTTP ${response.status}`);
    }
    await response.body?.cancel();
    return performance.now() - started;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function selectFastestSource(sources: string[]): Promise<string | null> {
  const attempts = await Promise.allSettled(sources.map(async (url) => ({
    url,
    elapsed: await probeSource(url),
  })));
  const successful = attempts
    .filter((attempt): attempt is PromiseFulfilledResult<{ url: string; elapsed: number }> => attempt.status === "fulfilled")
    .map((attempt) => attempt.value)
    .sort((a, b) => a.elapsed - b.elapsed);
  return successful[0]?.url ?? null;
}

/**
 * Remote videos start blurred and never autoplay before an explicit click.
 * When several media URLs are supplied, a one-byte Range probe chooses the
 * fastest reachable node address; the same-origin pi-web proxy remains the
 * final fallback.
 */
export function VideoPreview({ src, candidates, label = "Video preview", bytes, refresh }: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const initialSources = uniqueSources(src, candidates);
  const sourceKey = initialSources.join("\n");
  const [sourceList, setSourceList] = useState(initialSources);
  const [activeSrc, setActiveSrc] = useState(initialSources[0] ?? src);
  const [activeIndex, setActiveIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const nextSources = sourceKey.split("\n").filter(Boolean);
    setSourceList(nextSources);
    setActiveSrc(nextSources[0] ?? src);
    setActiveIndex(0);
    setRevealed(false);
    setLoading(false);
    setError(false);
  }, [sourceKey, src]);

  const refreshSources = async (): Promise<string[]> => {
    if (!refresh) return sourceList;
    const response = await fetch("/api/node-media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(refresh),
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`ticket refresh HTTP ${response.status}`);
    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("invalid ticket response");
    const record = data as Record<string, unknown>;
    const nextSources = uniqueSources(
      typeof record.mediaUrl === "string" ? record.mediaUrl : "",
      Array.isArray(record.mediaCandidates) ? record.mediaCandidates.filter((value): value is string => typeof value === "string") : undefined,
    );
    if (nextSources.length === 0) throw new Error("ticket response has no media URL");
    return nextSources;
  };

  const revealAndPlay = async () => {
    if (revealed || loading) return;
    setError(false);
    setLoading(true);
    try {
      const nextSources = await refreshSources();
      const selected = await selectFastestSource(nextSources);
      const chosen = selected ?? nextSources[0];
      const index = nextSources.indexOf(chosen);
      setSourceList(nextSources);
      setActiveIndex(index >= 0 ? index : 0);
      setActiveSrc(chosen);
      setRevealed(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  const handleError = () => {
    if (!revealed) return;
    const nextIndex = activeIndex + 1;
    if (nextIndex < sourceList.length) {
      setActiveIndex(nextIndex);
      setActiveSrc(sourceList[nextIndex]);
      return;
    }
    setError(true);
  };

  const handleLoadedData = () => {
    if (!revealed || !videoRef.current) return;
    videoRef.current.controls = true;
    void videoRef.current.play().catch(() => undefined);
  };

  return (
    <div
      style={{
        position: "relative",
        width: "min(100%, 560px)",
        aspectRatio: "16 / 9",
        overflow: "hidden",
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "#080b12",
      }}
    >
      <video
        ref={videoRef}
        src={activeSrc}
        preload={revealed ? "auto" : "none"}
        playsInline
        controls={revealed}
        onLoadedData={handleLoadedData}
        onError={handleError}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          objectFit: "contain",
          filter: revealed ? "none" : "blur(24px)",
          transform: revealed ? "none" : "scale(1.08)",
          transition: "filter 180ms ease, transform 180ms ease",
        }}
      />
      {!revealed && !error && (
        <button
          type="button"
          onClick={revealAndPlay}
          aria-label={`Reveal and play ${label}`}
          disabled={loading}
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            border: 0,
            background: "rgba(4, 8, 16, 0.22)",
            color: "#fff",
            cursor: "pointer",
            textShadow: "0 1px 4px rgba(0,0,0,.8)",
          }}
        >
          <span style={{ fontSize: 30, lineHeight: 1 }} aria-hidden="true">▶</span>
          <span style={{ fontSize: 12, fontWeight: 650 }}>{loading ? "正在连接视频…" : "点击清晰播放"}</span>
          {formatBytes(bytes) && <span style={{ fontSize: 10, opacity: 0.8 }}>{formatBytes(bytes)}</span>}
        </button>
      )}
      {error && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 16, color: "#fca5a5", fontSize: 12, textAlign: "center" }}>
          视频无法加载
        </div>
      )}
    </div>
  );
}
