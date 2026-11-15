# toolya-display (macOS)

Use the DJI Goggles 3 as an **external display** for your Mac over the USB cable.
macOS sees a real extra monitor: arrange it, extend onto it, or mirror to it in
**System Settings → Displays**. Handy as a sim display (Liftoff, Velocidrone…):
put the sim on the goggles display, with your radio plugged into the Mac.

```
virtual display (CGVirtualDisplay) → ScreenCaptureKit → JPEG → adb exec-in → USB
  → fb_receiver on the goggles (natartos PC Stream) → display hook → panel
```

No goggle-side changes: it speaks the same `[u32le size][jpeg]` stream as the
web PC Stream.

## Requirements

- macOS 13+, Xcode command line tools (`xcode-select --install`)
- adb: `brew install android-platform-tools`
- Goggles with ADB enabled (toolya) and natartos installed **with PC Stream**, mods started

## Build & run

```bash
cd mac/display
swift build -c release
.build/release/toolya-display
```

1. Enable ADB with toolya and start natartos mods (`toolya natartos start`, or the web UI).
2. **Close the toolya web tab** first. WebUSB holds the USB connection while it's open.
   To go back to the web UI later, run `adb kill-server`.
3. On first run, macOS asks for **Screen Recording** permission for your terminal.
   Allow it, then run again.
4. A display called **Goggles (toolya)** appears. Ctrl-C stops streaming and removes it.

Options: `--stream 480|720|1080` (what's sent; default 720), `--fps 5-60` (default 60),
`--quality 0.1-0.95` (default 0.5), `--adb PATH`.

The virtual display offers 1920×1080, 1600×900 and 1280×720. Lower modes give a
bigger UI; pick one in System Settings.

## Notes

- **Private API.** Virtual displays use CoreGraphics' private `CGVirtualDisplay`
  (BetterDisplay and DeskPad use it too). It works on current macOS, but Apple could
  change it.
- **Latency.** The status line shows `lat`: capture → written to USB. Goggle-side
  decode and display add more on top. If it feels laggy, try `--stream 480`.
- **Mods are per-session.** After a goggle reboot, re-enable ADB and restart mods.
