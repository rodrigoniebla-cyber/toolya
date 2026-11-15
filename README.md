# toolya

It's a tool — specifically, root on your **DJI Goggles 3**.

**toolya** enables ADB — and therefore root, since `adbd` on the goggles already runs
as uid 0 — on the Goggles 3 (`E3T zv902`). From there it gives you a shell, the
screen, the usage counters, and a handful of desk-development tweaks.

> Status: **open, live at [toolya.dev](https://toolya.dev)**. Open the page, plug in your
> goggles, and you're root. Read the scope notes below.

## tl;dr

- **Web (most people):** open [toolya.dev](https://toolya.dev), plug the goggles into the
  *same* machine, then **Enable ADB → Connect**. It's WebUSB, so use Chrome/Edge
  (Windows needs the WinUSB driver via Zadig).
- **CLI (power users):** `toolya adb` sends the enable packet over USB; then
  `toolya info`, `toolya usb adb|rndis`, `toolya reboot`, and friends.

## What can I do with this?

- A **root shell** on the goggles — a one-shot command REPL with a sticky `cd` (the G3's
  *interactive* shell is broken on-device, so we run commands cleanly instead).
- **Use the goggles as an external display** on macOS — a real extra monitor over the USB cable
  (`mac/display`, see its README). Works as a sim display too.
- **Mirror the screen** — 60 fps MJPEG streaming when the natartos display hook is active, with raw framebuffer grab as fallback.
- **Install and manage natartos** — the on-device mod framework, one-click from the web UI with version management and rollback.
- **Play Doom.** *itrunsdoom, finally.*
- **Drive the UI** — send BACK / OK / joystick keys as evdev events, from the web D-pad or
  `toolya input`, for manual control and scripted UI tests.
- Read the **usage counters** — goggle power-ons and motor starts.
- **Change the desk background** — drop in any photo, toolya converts it to the exact format.
- Switch **USB mode** adb ↔ rndis; and (WIP) silence the fan, mute the boot sound,
  disable the transmitter for desk use.

## How it works

The goggles run Android (aarch64) with `adbd` as root — but ADB is off by default.
toolya turns it on over USB using an internal protocol:

1. **DUML handshake** — the host opens the USB bulk endpoint and sends a sequence of
   DUML init packets. The goggles reply, confirming the link.
2. **cmd_id scan** — the exact command that enables ADB shifts between boots.
   toolya computes the candidates and sends them until the goggles drop off USB — that's the enable.
3. **ADB appears** — after ~5 seconds the goggles re-enumerate with an ADB interface.
   Connect normally (`adb shell`); you're root.

Everything runs client-side: the enable plan is computed by **Rust compiled to WASM** —
no server, no key, no account. In the browser,
[ya-webadb](https://github.com/yume-chan/ya-webadb) speaks ADB over WebUSB.

For screen streaming, the [natartos](https://github.com/grom-labs/natartos) display hook
writes the live framebuffer to a shared file; `fb_stream` (a small aarch64 binary pushed
over ADB) JPEG-encodes it at up to 60 fps and streams frames back over the ADB pipe.

## Tested firmware

| Firmware | ADB root | Notes |
|----------|----------|-------|
| v01.00.0900 | ✅ | earliest known working version |
| v01.00.1500 | ✅ | |
| v01.00.1600 | ✅ | latest as of 2026-11 |

ADB does not survive a reboot — run the enable step again after each power cycle.
Mods installed via [natartos](https://github.com/grom-labs/natartos) persist on `/vendor` across reboots.

## Build

Toolchains aren't installed on the build host — everything runs in the `toolya-build`
container (`bin/toolya-build`):

```
toolya-build test                               # Rust unit tests
toolya-build run -- duml-show adb-enable        # print the raw enable packet
toolya-build run -- info --from <getprop-dump>  # parse model/fw, mask serial (offline)
toolya-build --wasm                             # build the core to WASM
toolya-check                                     # one-shot CI: build + tests + web

# device-side tools (aarch64, in gcc:13 container)
make -C tools/fb_stream
```

Layout: `core/` (Rust DUML, native + WASM) · `cli/` (Rust) · `web/` (WebUSB enable + shell) ·
`worker/` (edge worker: serves the web app + anonymous telemetry + download proxy) ·
`tools/` (device-side native binaries, cross-compiled for aarch64).

## Risks — read before using

Enabling ADB/root with toolya is an **unauthorized modification of your own device**.

- It **likely violates DJI's Terms of Service** and software license. Under those terms DJI
  may **suspend or ban your DJI account** and/or **void your warranty**.
- We are not aware of enforcement, but cannot guarantee it won't happen. The change is
  local and removing toolya returns the goggles to stock.
- Use **only on hardware you own**. You accept all responsibility; toolya is provided
  **as-is, with no warranty**.

## Setup & requirements

**Browser:** Chrome or Edge, over **https** or **http://localhost** (WebUSB needs a secure
context). Firefox/Safari don't support WebUSB.

**Windows — install the WinUSB driver (one-time):** WebUSB on Windows can't talk to a device
until it has a WinUSB/libusb driver on the right interface.

1. Download **[Zadig](https://zadig.akeo.ie)** (a small driver-install tool).
2. Plug in the goggles. In Zadig: **Options → List All Devices**.
3. Find the DJI Goggles interface (vendor id `2CA3`). Pick **WinUSB** as the driver and
   click **Install/Replace Driver**.
4. Reload toolya and click **Enable ADB**. (If Connect later can't claim the interface,
   repeat Zadig for the interface that appears after enable.)

macOS and Linux need no driver. On Linux you may need a udev rule, or to run the browser with
USB access.

## Scope

- **Your own goggles.** Interoperability and local development only.
- **No vendor code redistributed** — no firmware, binaries, or unpacked `.sh`. Scrub
  serials and keys from any dump before sharing.
- **No bricking automation.** We don't wrap the factory `burn_otp` / `create_partition`
  / `clr_factory` scripts.
- **Not affiliated with DJI.** Product names are trademarks of their owner.

## Questions / help

Join the **[Discord](https://discord.gg/dDPb7CnmBb)** — questions, ideas, show what you built.

Bugs and feature requests also go to this repo's **[Issues](https://github.com/grom-labs/toolya/issues)** on GitHub.

## Built something on toolya?

Please link back to [toolya.dev](https://toolya.dev) — it's how people find the project.
A badge does it in one line:

[![Built on toolya](https://img.shields.io/badge/built%20on-toolya-2ea44f)](https://toolya.dev)

```markdown
[![Built on toolya](https://img.shields.io/badge/built%20on-toolya-2ea44f)](https://toolya.dev)
```

## Support

[![Support grom-labs on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/grom_labs)

If toolya is useful to you, you can support the work on Ko-fi, or crypto (EVM, any chain): `0x5182b19b01714C64811AeC6C59A0880C6F24528d`. Thanks!

## Credits

Inspired by the open-source community that has been rooting and modding these goggles for
years — the Goggles 3 exploit and all the code here are our own reverse-engineering, but
the path was theirs first, and we're grateful for it.

Built on [ya-webadb](https://github.com/yume-chan/ya-webadb) by `yume-chan` for in-browser
adb; DUML understanding informed by
[dji-firmware-tools](https://github.com/o-gs/dji-firmware-tools).

## License

AGPL-3.0 © 2026 grom-labs, with an additional attribution term under section 7(b) —
see [LICENSE](LICENSE) and [NOTICE](NOTICE). In short: forks and modified versions must stay
open, keep the "toolya — https://toolya.dev" attribution, and, if you host a modified
version, offer its source to your users.

Apps that merely run on a toolya-rooted device don't copy toolya and aren't bound by this.

Bundled third-party packages and their licenses: [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).
