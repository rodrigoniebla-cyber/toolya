// toolya-display — the DJI Goggles 3 as an external display on macOS.
//
//   virtual display (CGVirtualDisplay — a real monitor to macOS)
//     → ScreenCaptureKit (captures only that display)
//     → JPEG (ImageIO)
//     → `adb exec-in` stdin → USB →
//   fb_receiver on the goggles (natartos PC Stream) → display hook → panel
//
// Wire format is the PC Stream protocol: [u32le jpeg_size][jpeg_bytes] per frame,
// the same thing the toolya web page sends. No goggle-side changes needed.
//
// Latency policy: only the newest captured frame is encoded; anything that
// arrives while a frame is being encoded/written replaces the waiting one.

import CGVirtualDisplayPrivate
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import ScreenCaptureKit
import VideoToolbox

// MARK: - Goggle-side paths (natartos PC Stream)

let fbReceiverVendor = "/vendor/natartos/apps/stream/fb_receiver"
let fbReceiverTmp = "/data/local/tmp/fb_receiver"
let fbPipe = "/data/local/tmp/fb_pipe"     // FIFO when PC Stream was launched from the goggle menu
let fbStop = "/data/local/tmp/fb_stop"     // overlay stops injecting when this exists

// MARK: - Options

struct Options {
    var streamHeight = 720      // what is sent; the virtual display itself is 1920×1080
    var fps = 60
    var quality = 0.5
    var adb: String?

    static let usage = """
    toolya-display — use the DJI Goggles 3 as an external display (macOS)

    usage: toolya-display [--stream 480|720|1080] [--fps N] [--quality 0.1-0.95] [--adb PATH]

      --stream   height sent to the goggles (default 720; lower = less latency)
      --fps      frame cap, 5-60 (default 60)
      --quality  JPEG quality (default 0.5)
      --adb      path to adb (default: $ADB, PATH, Homebrew, Android SDK)

    Before running:
      1. Enable ADB on the goggles with toolya (web or CLI) and start natartos mods.
      2. Close/disconnect the toolya web tab — it holds the USB connection.
      3. Grant Screen Recording to your terminal when macOS asks.
    The display shows up in System Settings → Displays (arrange / extend / mirror).
    Ctrl-C to stop.
    """

    static func parse(_ args: [String]) -> Options {
        var o = Options()
        var i = 0
        func value() -> String {
            i += 1
            guard i < args.count else { die("missing value for \(args[i - 1])\n\n\(usage)") }
            return args[i]
        }
        while i < args.count {
            switch args[i] {
            case "--stream":
                guard let h = Int(value()), [480, 720, 1080].contains(h) else { die("--stream must be 480, 720 or 1080") }
                o.streamHeight = h
            case "--fps":
                guard let f = Int(value()), (5...60).contains(f) else { die("--fps must be 5-60") }
                o.fps = f
            case "--quality":
                guard let q = Double(value()), (0.1...0.95).contains(q) else { die("--quality must be 0.1-0.95") }
                o.quality = q
            case "--adb":
                o.adb = value()
            case "-h", "--help":
                print(usage); exit(0)
            default:
                die("unknown option \(args[i])\n\n\(usage)")
            }
            i += 1
        }
        return o
    }
}

func die(_ msg: String) -> Never {
    FileHandle.standardError.write(("toolya-display: " + msg + "\n").data(using: .utf8)!)
    exit(1)
}

func say(_ msg: String) { print("toolya-display: " + msg) }

// MARK: - adb

func findADB(_ explicit: String?) -> String? {
    var candidates: [String] = []
    if let e = explicit { candidates.append(e) }
    if let e = ProcessInfo.processInfo.environment["ADB"] { candidates.append(e) }
    let path = ProcessInfo.processInfo.environment["PATH"] ?? ""
    candidates += path.split(separator: ":").map { "\($0)/adb" }
    candidates += [
        "/opt/homebrew/bin/adb",
        "/usr/local/bin/adb",
        NSHomeDirectory() + "/Library/Android/sdk/platform-tools/adb",
    ]
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
}

@discardableResult
func adbRun(_ adb: String, _ args: [String]) -> (status: Int32, out: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: adb)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    do { try p.run() } catch { return (-1, "\(error)") }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
}

func adbShell(_ adb: String, _ cmd: String) -> String { adbRun(adb, ["shell", cmd]).out }

// MARK: - Virtual display

func makeVirtualDisplay() -> CGVirtualDisplay {
    let desc = CGVirtualDisplayDescriptor()
    desc.queue = DispatchQueue.main
    desc.name = "Goggles (toolya)"
    desc.maxPixelsWide = 1920
    desc.maxPixelsHigh = 1080
    desc.sizeInMillimeters = CGSize(width: 600, height: 338) // ~27" at 1080p: sane UI scale
    desc.vendorID = 0x7479   // "ty"
    desc.productID = 0x6433  // "d3"
    desc.serialNum = 1
    desc.terminationHandler = { _, _ in say("virtual display terminated by the system") }

    guard let display = CGVirtualDisplay(descriptor: desc) else {
        die("could not create the virtual display (CGVirtualDisplay unavailable on this macOS?)")
    }
    let settings = CGVirtualDisplaySettings()
    settings.hiDPI = 0
    // All 16:9 (the goggle panel is 1920×1080). Lower modes = bigger UI; pick in System Settings.
    settings.modes = [
        CGVirtualDisplayMode(width: 1920, height: 1080, refreshRate: 60),
        CGVirtualDisplayMode(width: 1600, height: 900, refreshRate: 60),
        CGVirtualDisplayMode(width: 1280, height: 720, refreshRate: 60),
    ]
    guard display.apply(settings) else { die("could not apply virtual display modes") }
    return display
}

// MARK: - Streamer

final class Streamer: NSObject, SCStreamOutput, SCStreamDelegate {
    let opts: Options
    let adb: String
    var display: CGVirtualDisplay?
    var stream: SCStream?
    var sender: Process?
    var stdin: FileHandle?

    let captureQueue = DispatchQueue(label: "toolya.capture")
    let encodeQueue = DispatchQueue(label: "toolya.encode")
    let lock = NSLock()
    var latest: (CVPixelBuffer, CMTime)?   // newest frame waiting to be encoded
    var busy = false
    var stopping = false
    var lastEncode = CFAbsoluteTimeGetCurrent() - 1

    // stats
    var frames = 0, bytes = 0, dropped = 0
    var encMs = 0.0, latMs = 0.0

    init(opts: Options, adb: String) {
        self.opts = opts
        self.adb = adb
    }

    func start() async {
        // 1. goggles reachable?
        let state = adbRun(adb, ["get-state"]).out
        guard state == "device" else {
            die("""
            no goggles over ADB (adb get-state: \(state.isEmpty ? "nothing" : state)).
            Enable ADB with toolya, start natartos mods, and close the toolya web tab
            (WebUSB holds the connection while it's open).
            """)
        }

        // 2. receiver + mode (same logic as the web PC Stream)
        let receiver: String
        if adbShell(adb, "[ -x \(fbReceiverVendor) ] && echo OK").contains("OK") {
            receiver = fbReceiverVendor
        } else if adbShell(adb, "[ -x \(fbReceiverTmp) ] && echo OK").contains("OK") {
            receiver = fbReceiverTmp
        } else {
            die("fb_receiver not found on the goggles — install natartos (with PC Stream) first")
        }
        let pipeMode = adbShell(adb, "[ -p \(fbPipe) ] && echo PIPE").contains("PIPE")
        _ = adbShell(adb, "rm -f \(fbStop)")

        // 3. the monitor
        let vd = makeVirtualDisplay()
        display = vd
        say("virtual display \(vd.displayID) created — see System Settings → Displays")

        // 4. sender: adb exec-in pipes our stdin straight to the command (raw, no pty)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: adb)
        p.arguments = ["exec-in", pipeMode ? "cat > \(fbPipe)" : receiver]
        let inPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = FileHandle.nullDevice
        p.terminationHandler = { [weak self] _ in
            guard let self, !self.stopping else { return }
            DispatchQueue.main.async { self.shutdown("receiver exited (goggles unplugged, or Back pressed in PC Stream)", code: 1) }
        }
        do { try p.run() } catch { die("could not start adb exec-in: \(error)") }
        sender = p
        stdin = inPipe.fileHandleForWriting
        say(pipeMode ? "sending into the PC Stream pipe" : "started \(receiver)")

        // 5. capture the virtual display (it can take a moment to appear)
        var scDisplay: SCDisplay?
        for _ in 0..<30 {
            if let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false),
               let d = content.displays.first(where: { $0.displayID == vd.displayID }) {
                scDisplay = d
                break
            }
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        guard let scDisplay else {
            shutdown("""
            can't capture the virtual display. Grant Screen Recording to this terminal
            (System Settings → Privacy & Security → Screen Recording), then run again.
            """, code: 1)
            return
        }

        let cfg = SCStreamConfiguration()
        cfg.height = opts.streamHeight
        cfg.width = opts.streamHeight * 16 / 9
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(opts.fps))
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.queueDepth = 3
        cfg.showsCursor = true
        cfg.colorSpaceName = CGColorSpace.sRGB

        let s = SCStream(filter: SCContentFilter(display: scDisplay, excludingWindows: []), configuration: cfg, delegate: self)
        do {
            try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: captureQueue)
            try await s.startCapture()
        } catch {
            shutdown("capture failed: \(error.localizedDescription) — check Screen Recording permission", code: 1)
            return
        }
        stream = s
        say("streaming \(cfg.width)×\(cfg.height) @ ≤\(opts.fps) fps, q\(Int(opts.quality * 100)). Ctrl-C to stop.")
        startStats()
    }

    // SCStreamOutput — capture queue
    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sb.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: raw) == .complete,   // .idle = nothing changed: keep last image
              let pb = sb.imageBuffer
        else { return }

        lock.lock()
        if latest != nil { dropped += 1 }
        latest = (pb, sb.presentationTimeStamp)
        let kick = !busy
        if kick { busy = true }
        lock.unlock()
        if kick { encodeQueue.async { self.drain() } }
    }

    // SCStreamDelegate
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async { self.shutdown("capture stopped: \(error.localizedDescription)", code: 1) }
    }

    /// Encode + send the newest frame until none is waiting (encode queue).
    func drain() {
        while true {
            // fps cap
            let gap = 1.0 / Double(opts.fps) - (CFAbsoluteTimeGetCurrent() - lastEncode)
            if gap > 0 { Thread.sleep(forTimeInterval: gap) }

            lock.lock()
            guard let next = latest, !stopping else { busy = false; lock.unlock(); return }
            latest = nil
            let (pb, pts) = next
            lock.unlock()

            lastEncode = CFAbsoluteTimeGetCurrent()
            guard let jpeg = encodeJPEG(pb) else { continue }
            let t1 = CFAbsoluteTimeGetCurrent()

            var header = UInt32(jpeg.count).littleEndian
            var frame = Data(bytes: &header, count: 4)
            frame.append(jpeg)
            do {
                try stdin?.write(contentsOf: frame)
            } catch {
                lock.lock(); busy = false; lock.unlock()
                DispatchQueue.main.async { self.shutdown("write failed: \(error.localizedDescription)", code: 1) }
                return
            }

            // capture → written to USB (both on the host clock)
            let now = CMClockGetTime(CMClockGetHostTimeClock())
            let lat = CMTimeGetSeconds(CMTimeSubtract(now, pts)) * 1000
            let enc = (t1 - lastEncode) * 1000
            lock.lock()
            frames += 1
            bytes += frame.count
            encMs = encMs == 0 ? enc : encMs * 0.9 + enc * 0.1
            latMs = latMs == 0 ? lat : latMs * 0.9 + lat * 0.1
            lock.unlock()
        }
    }

    func encodeJPEG(_ pb: CVPixelBuffer) -> Data? {
        var image: CGImage?
        guard VTCreateCGImageFromCVPixelBuffer(pb, options: nil, imageOut: &image) == noErr, let image else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: opts.quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }

    func startStats() {
        let t = DispatchSource.makeTimerSource(queue: .main)
        var lastF = 0, lastB = 0
        t.schedule(deadline: .now() + 1, repeating: 1)
        t.setEventHandler { [weak self] in
            guard let self, !self.stopping else { return }
            self.lock.lock()
            let f = self.frames, b = self.bytes, d = self.dropped, e = self.encMs, l = self.latMs
            self.lock.unlock()
            let line = String(format: "%3d fps · %4.0f ms lat · %5d KB/s · %4.1f ms enc · %d dropped",
                              f - lastF, l, (b - lastB) / 1024, e, d)
            FileHandle.standardOutput.write(("\r" + line + "   ").data(using: .utf8)!)
            lastF = f; lastB = b
        }
        t.resume()
        statsTimer = t
    }
    var statsTimer: DispatchSourceTimer?

    /// Stop everything; main queue. The virtual display disappears when we exit.
    func shutdown(_ reason: String, code: Int32) {
        if stopping { return }
        stopping = true
        print("")
        say(reason)
        statsTimer?.cancel()
        let s = stream
        Task {
            try? await s?.stopCapture()
            _ = adbShell(self.adb, "touch \(fbStop)")   // overlay stops injecting
            try? self.stdin?.close()
            self.sender?.terminate()
            exit(code)
        }
    }
}

// MARK: - main

signal(SIGPIPE, SIG_IGN) // a dead adb pipe should be a write error, not a crash

let opts = Options.parse(Array(CommandLine.arguments.dropFirst()))
guard let adb = findADB(opts.adb) else {
    die("adb not found. Install it with `brew install android-platform-tools`, or pass --adb PATH.")
}
let streamer = Streamer(opts: opts, adb: adb)

var signalSources: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { streamer.shutdown("stopped", code: 0) }
    src.resume()
    signalSources.append(src)
}

Task { await streamer.start() }
dispatchMain()
