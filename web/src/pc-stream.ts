// PC screen streaming to DJI Goggles 3 over USB/ADB.
//
// Browser captures screen (getDisplayMedia), encodes JPEG frames,
// sends over ADB subprocess stdin to fb_receiver on the goggles.
// fb_receiver decodes JPEG → BGRA → fb_shared → hook_overlay.so → DMA-buf → display.
//
// Protocol: [u32le jpeg_size][jpeg_bytes] per frame — same as fb_stream output.

import type { Adb } from "@yume-chan/adb";
import { run } from "./adb";
import { getContract } from "./wasm";
import type { WorkerFrameMsg, WorkerErrorMsg, WorkerEndMsg } from "./pc-stream-worker";

const FB_RECEIVER_VENDOR = "/vendor/natartos/apps/stream/fb_receiver";
const FB_RECEIVER_TMP = "/data/local/tmp/fb_receiver";
const FB_PIPE_PATH = "/data/local/tmp/fb_pipe";

export interface PcStreamHandle {
  stop(): Promise<void>;
  readonly active: boolean;
  readonly fps: number;
}

/**
 * What to send to the goggles:
 *  - "screen": the PC screen / a window / a tab (getDisplayMedia) — goggles as a display.
 *  - "device": a video capture device (getUserMedia). This is how analog video gets in:
 *    an analog FPV receiver with USB (UVC) output, or a composite/AV → USB grabber,
 *    plugged into the computer shows up here like a webcam.
 */
export type PcStreamSource =
  | { kind: "screen" }
  | { kind: "device"; deviceId: string };

export interface CaptureDevice { deviceId: string; label: string }

/**
 * List video capture devices (analog grabbers, UVC receivers, webcams).
 * Browsers hide device labels until camera permission is granted once, so if
 * `askPermission` is set and labels are missing we open (and close) a stream first.
 */
export async function listCaptureDevices(askPermission = false): Promise<CaptureDevice[]> {
  const md = navigator.mediaDevices;
  if (!md?.enumerateDevices) return [];
  let devs = (await md.enumerateDevices()).filter((d) => d.kind === "videoinput");
  if (askPermission && devs.some((d) => !d.label)) {
    const s = await md.getUserMedia({ video: true, audio: false });
    s.getTracks().forEach((t) => t.stop());
    devs = (await md.enumerateDevices()).filter((d) => d.kind === "videoinput");
  }
  return devs.map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Video device ${i + 1}` }));
}

export interface PcStreamOpts {
  adb: Adb;
  source?: PcStreamSource; // default: screen
  quality: number;    // 0.1–0.95
  fpsCap: number;     // 5–60
  height?: number;    // capture height (720 default); width derived 16:9
  preview: HTMLCanvasElement;
  onStatus?: (info: { fps: number; frames: number; kbps: number; encMs: number; avgKb: number; dropped: number; latMs: number }) => void;
  onError?: (err: string) => void;
  onStop?: (reason: string) => void;
}

async function findReceiver(adb: Adb): Promise<string> {
  // prefer the natartos-installed binary (no push needed)
  try {
    const out = await run(adb, `[ -x ${FB_RECEIVER_VENDOR} ] && echo OK || echo MISSING`);
    if (out.includes("OK")) return FB_RECEIVER_VENDOR;
  } catch { /* not present */ }
  // fallback: /data/local/tmp (push from bundled or error)
  try {
    const out = await run(adb, `[ -x ${FB_RECEIVER_TMP} ] && echo OK || echo MISSING`);
    if (out.includes("OK")) return FB_RECEIVER_TMP;
  } catch { /* not present */ }
  throw new Error("fb_receiver not found — install natartos first (toolya natartos install)");
}

export async function startPcStream(opts: PcStreamOpts): Promise<PcStreamHandle> {
  const { adb } = opts;
  // fb_stop / fb_override live next to fb_shared (contract); overlay watches them.
  const c = await getContract();
  const fbStop = c.files.fb_shared.replace(/\/[^/]*$/, "/fb_stop");
  let running = true;
  let fps = 0;

  // Stats
  let frames = 0, sentBytes = 0, dropped = 0;
  let lastT = performance.now(), lastF = 0, lastB = 0;
  let encMs = 0, avgSize = 0, latMs = 0;

  function tick() {
    const now = performance.now();
    const dt = (now - lastT) / 1000;
    if (dt >= 1) {
      fps = (frames - lastF) / dt;
      opts.onStatus?.({
        fps: Math.round(fps),
        frames,
        kbps: Math.round((sentBytes - lastB) / dt / 1024),
        encMs: +encMs.toFixed(1),
        avgKb: +(avgSize / 1024).toFixed(1),
        dropped,
        latMs: Math.round(latMs),
      });
      lastT = now;
      lastF = frames;
      lastB = sentBytes;
    }
  }

  const receiverPath = await findReceiver(adb);

  // Clear a stop flag left over from a previous run, else the overlay inject
  // thread would see fb_stop and tear down immediately on this start.
  await run(adb, `rm -f ${fbStop}`).catch(() => { /* ignore */ });

  // Capture: the PC screen, or a video capture device (analog grabber / UVC receiver).
  const source = opts.source ?? { kind: "screen" };
  let mediaStream: MediaStream;
  // Lower capture resolution → cheaper JPEG-encode + ADB transfer; fb_receiver
  // letterboxes non-1080p input, so the goggles still fill the screen.
  const capH = opts.height ?? 720;
  const capW = Math.round((capH * 16) / 9);
  if (source.kind === "device") {
    try {
      // Only ask for a height: analog grabbers deliver 4:3 (720×480 NTSC, 720×576
      // PAL) and forcing 16:9 makes some drivers crop or reject the request.
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: source.deviceId },
          height: { ideal: capH },
          frameRate: { ideal: opts.fpsCap },
        },
        audio: false,
      });
    } catch (e) {
      throw new Error("Video device unavailable: " + (e as Error).message);
    }
  } else {
    try {
      mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: capW }, height: { ideal: capH }, frameRate: { ideal: opts.fpsCap } },
        audio: false,
      });
    } catch (e) {
      throw new Error("Screen capture denied: " + (e as Error).message);
    }
  }
  // Device sources are pillarboxed to 16:9 here so 4:3 analog video keeps its
  // shape on the goggles' 16:9 panel instead of being stretched.
  const pillarbox = source.kind === "device";

  // If menu already launched fb_receiver (FIFO exists), connect via pipe;
  // otherwise spawn fb_receiver directly reading from stdin.
  let pipeMode = false;
  try {
    const chk = await run(adb, `[ -p ${FB_PIPE_PATH} ] && echo PIPE || echo NONE`);
    pipeMode = chk.includes("PIPE");
  } catch { /* direct mode */ }

  const proc = pipeMode
    ? await adb.subprocess.noneProtocol.spawn(`cat > ${FB_PIPE_PATH}`)
    : await adb.subprocess.noneProtocol.spawn(receiverPath);
  const writer = proc.stdin.getWriter();

  const video = document.createElement("video");
  video.srcObject = mediaStream;
  video.muted = true;
  video.play();

  mediaStream.getVideoTracks()[0].addEventListener("ended", () =>
    stop(source.kind === "device" ? "video device disconnected" : "share stopped"));

  const offscreen = document.createElement("canvas");
  let sending = false;
  let lastFrame = 0;
  let animFrame = 0;
  let worker: Worker | null = null;
  let previewTimer = 0;

  // Preferred path (Chrome/Edge): capture + encode in a worker. Unlike the
  // requestAnimationFrame loop below, it keeps streaming while the toolya tab
  // is hidden or covered — e.g. a full-screen sim has focus.
  const useWorker = typeof MediaStreamTrackProcessor !== "undefined" && typeof OffscreenCanvas !== "undefined";

  /** Main-thread preview at ~10 fps (fit, black bars). Throttled when hidden — fine. */
  function drawPreview() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    const pw = opts.preview.width, ph = opts.preview.height;
    const k = Math.min(pw / vw, ph / vh);
    const dw = Math.round(vw * k), dh = Math.round(vh * k);
    const pctx = opts.preview.getContext("2d")!;
    pctx.fillStyle = "#000";
    pctx.fillRect(0, 0, pw, ph);
    pctx.drawImage(video, Math.round((pw - dw) / 2), Math.round((ph - dh) / 2), dw, dh);
  }

  if (useWorker) {
    const processor = new MediaStreamTrackProcessor({ track: mediaStream.getVideoTracks()[0] });
    worker = new Worker(new URL("./pc-stream-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = async (e: MessageEvent<WorkerFrameMsg | WorkerErrorMsg | WorkerEndMsg>) => {
      const m = e.data;
      if (!running) return;
      if (m.type === "error") { opts.onError?.("encode failed: " + m.message); return; }
      if (m.type === "end") { void stop(source.kind === "device" ? "video device disconnected" : "share stopped"); return; }
      dropped += m.dropped;
      encMs = m.encMs;
      const buf = new Uint8Array(m.jpeg);
      avgSize = avgSize > 0 ? avgSize * 0.9 + buf.length * 0.1 : buf.length;
      try {
        await writer.write(buf);
      } catch (err) {
        if (running) {
          opts.onError?.("write failed: " + (err as Error).message);
          void stop("write error");
        }
        return;
      }
      frames++;
      sentBytes += buf.length;
      // capture → written to USB (both clocks absolute, so worker/main align)
      const lat = performance.timeOrigin + performance.now() - m.tCapture;
      latMs = latMs > 0 ? latMs * 0.9 + lat * 0.1 : lat;
      tick();
      worker?.postMessage({ type: "credit" }); // ready for the next (newest) frame
    };
    worker.onerror = (e) => { if (running) { opts.onError?.("worker: " + e.message); void stop("worker error"); } };
    worker.postMessage(
      { type: "start", readable: processor.readable, maxH: capH, quality: opts.quality, fpsCap: opts.fpsCap, pillarbox },
      [processor.readable as unknown as Transferable],
    );
    previewTimer = window.setInterval(drawPreview, 100);
  }

  function loop() {
    if (!running) return;
    animFrame = requestAnimationFrame(loop);

    const now = performance.now();
    if (now - lastFrame < 1000 / opts.fpsCap) return;
    if (sending) { dropped++; return; }
    if (!video.videoWidth) return;

    const vw = video.videoWidth, vh = video.videoHeight;
    const octx = offscreen.getContext("2d")!;
    if (pillarbox && Math.abs(vw / vh - 16 / 9) > 0.01) {
      // Fit the frame into a 16:9 canvas of the same height (black bars).
      const ow = Math.max(vw, Math.round((vh * 16) / 9));
      const oh = Math.round((ow * 9) / 16);
      if (offscreen.width !== ow || offscreen.height !== oh) {
        offscreen.width = ow;
        offscreen.height = oh;
      }
      octx.fillStyle = "#000";
      octx.fillRect(0, 0, ow, oh);
      octx.drawImage(video, Math.round((ow - vw) / 2), Math.round((oh - vh) / 2), vw, vh);
    } else {
      if (offscreen.width !== vw || offscreen.height !== vh) {
        offscreen.width = vw;
        offscreen.height = vh;
      }
      octx.drawImage(video, 0, 0);
    }

    // Preview: show exactly what is sent.
    const pctx = opts.preview.getContext("2d")!;
    pctx.drawImage(offscreen, 0, 0, opts.preview.width, opts.preview.height);

    sending = true;
    const t0 = performance.now();

    offscreen.toBlob(async (blob) => {
      encMs = performance.now() - t0;
      if (!blob || !running) { sending = false; return; }
      avgSize = avgSize > 0 ? avgSize * 0.9 + blob.size * 0.1 : blob.size;

      try {
        const jpegBuf = new Uint8Array(await blob.arrayBuffer());
        // Frame header: u32le jpeg size
        const header = new Uint8Array(4);
        const dv = new DataView(header.buffer);
        dv.setUint32(0, jpegBuf.length, true);

        await writer.write(header);
        await writer.write(jpegBuf);

        frames++;
        sentBytes += 4 + jpegBuf.length;
        lastFrame = performance.now();
        tick();
      } catch (e) {
        if (running) {
          opts.onError?.("write failed: " + (e as Error).message);
          stop("write error");
        }
      }
      sending = false;
    }, "image/jpeg", opts.quality);
  }

  if (!useWorker) animFrame = requestAnimationFrame(loop);

  async function stop(reason = "stopped") {
    if (!running) return;
    running = false;
    if (animFrame) cancelAnimationFrame(animFrame);
    if (previewTimer) clearInterval(previewTimer);
    if (worker) { worker.postMessage({ type: "stop" }); worker.terminate(); worker = null; }
    // Signal the overlay to stop injecting (<100ms) and kill fb_receiver.
    // Must run while adb is still alive — disconnect() stops us before closing.
    try { await run(adb, `touch ${fbStop}`); } catch { /* ignore */ }
    try { writer.close(); } catch { /* ignore */ }
    try { proc.kill(); } catch { /* ignore */ }
    mediaStream.getTracks().forEach(t => t.stop());
    opts.onStop?.(reason);
  }

  // Monitor fb_receiver exit
  (async () => {
    try {
      const reader = proc.output.getReader();
      while (running) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch { /* ignore */ }
    if (running) stop("receiver exited");
  })();

  return {
    stop: () => stop(),
    get active() { return running; },
    get fps() { return fps; },
  };
}
