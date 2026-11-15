// PC Stream encode worker: VideoFrames in → JPEG frames out.
//
// Why a worker: the main-thread loop is driven by requestAnimationFrame, which
// Chrome throttles or pauses when the toolya tab is hidden or its window is
// covered — exactly what happens when a full-screen sim has focus. A worker
// reading a MediaStreamTrackProcessor stream keeps running regardless.
//
// Latency policy: never queue. Only the newest captured frame is kept; it is
// encoded as soon as the main thread hands back a credit (= previous frame
// written to ADB). Older frames are closed and counted as dropped.
//
// Standalone on purpose (no imports) so it can be tested in isolation.

interface StartMsg {
  type: "start";
  readable: ReadableStream<VideoFrame>;
  maxH: number;       // downscale anything taller than this before encoding
  quality: number;    // JPEG quality 0.1–0.95
  fpsCap: number;     // encode at most this many frames/sec
  pillarbox: boolean; // fit non-16:9 frames into a 16:9 canvas (black bars)
}
interface CreditMsg { type: "credit" }
interface StopMsg { type: "stop" }
type InMsg = StartMsg | CreditMsg | StopMsg;

export interface WorkerFrameMsg {
  type: "frame";
  jpeg: ArrayBuffer; // already prefixed with the u32le size header
  encMs: number;
  tCapture: number;  // absolute ms (timeOrigin + now) when the frame reached the worker
  dropped: number;   // frames dropped since the previous message
}
export interface WorkerErrorMsg { type: "error"; message: string }
export interface WorkerEndMsg { type: "end" }

const ctx = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<InMsg>) => void) | null;
};

let cfg: StartMsg | null = null;
let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
let pending: { frame: VideoFrame; t: number } | null = null;
let credits = 1;
let encoding = false;
let dropped = 0;
let lastEncodeStart = 0;
let canvas: OffscreenCanvas | null = null;
let stopped = false;

const absNow = () => performance.timeOrigin + performance.now();

/** Output size for a source frame: capped at maxH, optionally padded to 16:9. */
export function outSize(vw: number, vh: number, maxH: number, pillarbox: boolean) {
  const scale = vh > maxH ? maxH / vh : 1;
  const dw = Math.round(vw * scale), dh = Math.round(vh * scale);
  if (pillarbox && Math.abs(dw / dh - 16 / 9) > 0.01) {
    const ow = Math.max(dw, Math.round((dh * 16) / 9));
    const oh = Math.round((ow * 9) / 16);
    return { ow, oh, dw, dh, dx: Math.round((ow - dw) / 2), dy: Math.round((oh - dh) / 2) };
  }
  return { ow: dw, oh: dh, dw, dh, dx: 0, dy: 0 };
}

async function pump() {
  if (!cfg || encoding || credits <= 0 || !pending) return;
  const now = performance.now();
  const minGap = 1000 / cfg.fpsCap;
  if (now - lastEncodeStart < minGap) {
    // Too soon for the fps cap: retry when the slot opens (a newer frame may replace this one).
    setTimeout(() => void pump(), minGap - (now - lastEncodeStart));
    return;
  }
  const { frame, t } = pending;
  pending = null;
  encoding = true;
  credits--;
  lastEncodeStart = now;
  try {
    const s = outSize(frame.displayWidth, frame.displayHeight, cfg.maxH, cfg.pillarbox);
    if (!canvas) canvas = new OffscreenCanvas(s.ow, s.oh);
    if (canvas.width !== s.ow || canvas.height !== s.oh) { canvas.width = s.ow; canvas.height = s.oh; }
    const g = canvas.getContext("2d")!;
    if (s.dx || s.dy) { g.fillStyle = "#000"; g.fillRect(0, 0, s.ow, s.oh); }
    g.drawImage(frame, s.dx, s.dy, s.dw, s.dh);
    frame.close();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: cfg.quality });
    const body = new Uint8Array(await blob.arrayBuffer());
    // One buffer = one ADB write: [u32le size][jpeg].
    const out = new Uint8Array(4 + body.length);
    new DataView(out.buffer).setUint32(0, body.length, true);
    out.set(body, 4);
    const msg: WorkerFrameMsg = { type: "frame", jpeg: out.buffer, encMs: performance.now() - now, tCapture: t, dropped };
    dropped = 0;
    if (!stopped) ctx.postMessage(msg, [out.buffer]);
  } catch (e) {
    try { frame.close(); } catch { /* already closed */ }
    credits++; // nothing was sent, so no credit will come back
    ctx.postMessage({ type: "error", message: (e as Error).message } satisfies WorkerErrorMsg);
  } finally {
    encoding = false;
  }
  void pump();
}

async function readLoop() {
  while (!stopped && reader) {
    let r: ReadableStreamReadResult<VideoFrame>;
    try { r = await reader.read(); } catch { break; }
    if (r.done) break;
    if (stopped) { r.value.close(); break; }
    if (pending) { pending.frame.close(); dropped++; }
    pending = { frame: r.value, t: absNow() };
    void pump();
  }
  if (!stopped) ctx.postMessage({ type: "end" } satisfies WorkerEndMsg);
}

ctx.onmessage = (e) => {
  const m = e.data;
  if (m.type === "start") {
    cfg = m;
    reader = m.readable.getReader();
    void readLoop();
  } else if (m.type === "credit") {
    credits++;
    void pump();
  } else if (m.type === "stop") {
    stopped = true;
    if (pending) { pending.frame.close(); pending = null; }
    reader?.cancel().catch(() => { /* ignore */ });
  }
};
