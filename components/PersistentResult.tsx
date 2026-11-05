"use client";

import { useState } from "react";

export interface PersistentResultRef { node: string; id: string }
export function findResultReference(details: unknown, text?: string | null): PersistentResultRef | null {
  const read = (value: unknown): PersistentResultRef | null => {
    if (!value || typeof value !== "object") return null;
    const source = value as { resultRef?: { id?: unknown; node?: unknown }; node?: unknown };
    const node = source.resultRef?.node ?? source.node;
    return typeof source.resultRef?.id === "string" && typeof node === "string" ? { id: source.resultRef.id, node } : null;
  };
  const direct = read(details); if (direct) return direct;
  if (text) try { return read(JSON.parse(text)); } catch { /* ordinary textual result */ }
  return null;
}
interface ResultPage { data: string; encoding: string; nextOffset: number; offset: number; eof: boolean; state?: string; captureComplete?: boolean; totalBytes?: number }

export function PersistentResult({ sessionId, reference }: { sessionId: string; reference: PersistentResultRef }) {
  const [page, setPage] = useState<ResultPage | null>(null);
  const [offsets, setOffsets] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState("payload");
  const load = async (offset: number, previous: number[]) => {
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/result`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ node: reference.node, resultId: reference.id, section, offset, limit: 1024 }) });
      const body = await response.json();
      if (!response.ok) throw new Error(response.status === 410 ? "详情已回收；命令执行记录仍然保留。" : String(body.error ?? `HTTP ${response.status}`));
      if (typeof body.data !== "string" || !Number.isSafeInteger(body.nextOffset) || typeof body.eof !== "boolean") throw new Error("Invalid result page");
      setPage(body as ResultPage); setOffsets(previous);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setLoading(false); }
  };
  return <div style={{ padding: "8px 10px", borderTop: "1px solid var(--border)", background: "var(--bg)" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <select aria-label="Result section" value={section} disabled={loading} onChange={event => { setSection(event.target.value); setPage(null); setOffsets([]); setError(null); }}>
        { ["payload", "stdout", "stderr"].map(value => <option key={value} value={value}>{value}</option>) }
      </select>
      <button disabled={loading} onClick={() => void load(0, [])}>{loading ? "读取中…" : "查看持久详情"}</button>
      {page && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{page.offset}–{page.nextOffset}{page.totalBytes !== undefined ? ` / ${page.totalBytes} B` : ""}</span>}
    </div>
    {error && <div role="alert" style={{ color: "#f87171", marginTop: 8 }}>{error}</div>}
    {page && <>
      {page.captureComplete === false && <div style={{ color: "var(--text-muted)", marginTop: 8 }}>采集尚未完整完成，当前页保留已取得的内容。</div>}
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 400, overflow: "auto", margin: "8px 0" }}>{page.encoding === "base64" ? `[base64]\n${page.data}` : page.data}</pre>
      <div style={{ display: "flex", gap: 8 }}>
        <button disabled={loading || offsets.length === 0} onClick={() => void load(offsets.at(-1) ?? 0, offsets.slice(0, -1))}>上一页</button>
        <button disabled={loading || page.eof || page.nextOffset <= page.offset} onClick={() => void load(page.nextOffset, [...offsets, page.offset])}>下一页</button>
      </div>
    </>}
  </div>;
}
