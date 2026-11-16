// ADB-over-WebUSB via ya-webadb: connect (post-enable), open a root PTY, and
// read usage counters. adbd on the goggles runs as uid 0, so the shell is root.
import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import {
  AdbDaemonWebUsbDeviceManager,
} from "@yume-chan/adb-daemon-webusb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { ReadableStream } from "@yume-chan/stream-extra";

import { getContract } from "./wasm";

// Stock desk background on the goggles.
export const BG_PATH = "/data/screendesk_1920.bmp";

// Pull a file from the device into memory (e.g. a raw LiveView BGRA frame).
export async function pullFile(adb: Adb, path: string): Promise<Uint8Array> {
  const sync = await adb.sync();
  try {
    const reader = sync.read(path).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  } finally {
    await sync.dispose();
  }
}

// Push raw bytes to a file on the device (root — adbd runs as uid 0).
export async function pushFile(adb: Adb, path: string, bytes: Uint8Array): Promise<void> {
  const sync = await adb.sync();
  try {
    await sync.write({
      filename: path,
      file: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      permission: 0o644,
    });
  } finally {
    await sync.dispose();
  }
}

export async function connectAdb(): Promise<Adb> {
  const mgr = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!mgr) throw new Error("WebUSB not available in this browser");
  // Prefer an already-granted device (no user gesture) so auto-connect right
  // after "ADB already enabled" works — the device was granted during enable.
  // Fall back to the picker (needs a click) when none is granted yet.
  let device = (await mgr.getDevices())[0];
  if (!device) device = await mgr.requestDevice();
  if (!device) throw new Error("no device selected");
  const connection = await device.connect();
  const credentialStore = new AdbWebCredentialStore("toolya");
  const transport = await AdbDaemonTransport.authenticate({
    serial: device.serial,
    connection,
    credentialStore,
  });
  return new Adb(transport);
}

export interface Pty {
  output: ReadableStream<Uint8Array>;
  write(data: Uint8Array): Promise<void>;
  resize(rows: number, cols: number): Promise<void>;
}

// Open an interactive root PTY (shell v2). This may succeed where the container's
// `adb shell` failed for lack of a PTY.
export async function openPty(adb: Adb): Promise<Pty> {
  const sp = adb.subprocess.shellProtocol;
  if (!sp) throw new Error("device has no shell-protocol (v2) support");
  const pty = await sp.pty({ terminalType: "xterm-256color" });
  const writer = pty.input.getWriter();
  return {
    output: pty.output,
    write: (data) => writer.write(data),
    resize: (rows, cols) => pty.resize(rows, cols),
  };
}

// Run a one-shot command and return its stdout as text.
export async function run(adb: Adb, command: string): Promise<string> {
  const out = await adb.subprocess.noneProtocol.spawnWaitText(command);
  return out;
}

// USB mode configs from core contract (single source of truth).
export type UsbMode = "adb" | "rndis";
export async function usbCfgString(mode: UsbMode): Promise<string> {
  const c = await getContract();
  return c.usb[mode];
}

// SELinux session toggle (devmem). `setenforce 0` is neverallow-blocked on the G3,
// so we poke the selinux_state enforce byte. Session-only (resets on reboot).
// Addresses and offset from core contract (single source of truth).

export async function getSelinux(adb: Adb): Promise<string> {
  return (await run(adb, "getenforce")).trim();
}

/** mode: "permissive" → 0x00, "enforcing" → 0x01. Returns the resulting state. */
export async function setSelinux(adb: Adb, mode: "permissive" | "enforcing"): Promise<string> {
  const c = await getContract();
  const byte = mode === "permissive" ? "0x00" : "0x01";
  const addrs = c.selinux.addrs.join(" ");
  const offset = c.selinux.enforce_offset;
  const sh =
    `for A in ${addrs}; do V=$(busybox devmem $A 32 2>/dev/null) || continue; ` +
    `case "$V" in 0x01000100|0x01000000) busybox devmem $(printf 0x%X $((A+${offset}))) 8 ${byte}; break;; esac; done; getenforce`;
  return (await run(adb, sh)).trim();
}

// natartos (persistent mod framework) — read-only status + the low-risk kill-switch.
// Install/uninstall stay in the CLI for now (persistent /vendor writes; brick-risk).
export interface NatartosStatus {
  installed: boolean;
  version: string;
  bootcount: string;
  disabled: boolean;
  mods: string[];
  running: boolean; // dji_glasses is actually running under the loader
}
export async function natartosStatus(adb: Adb): Promise<NatartosStatus> {
  const n = (await getContract()).natartos;
  const version = (
    await run(
      adb,
      `grep -o '"natartos_version"[^,]*' ${n.manifest_device} 2>/dev/null | cut -d'"' -f4`,
    )
  ).trim();
  const bootcount = (
    await run(
      adb,
      `if [ -f ${n.bootcount} ]; then od -A n -t u4 -N 4 ${n.bootcount} | tr -d ' '; else echo 0; fi`,
    )
  ).trim();
  const disabled = (await run(adb, `[ -f ${n.disabled} ] && echo 1 || echo 0`)).trim() === "1";
  // List mods from the device filesystem — the CLI installs this way and never
  // writes installed.json (which only the web release-installer would). mods/
  // holds the installed .so, enabled/ a touch-flag per loaded one.
  const base = (p: string) => p.split("/").pop() ?? p;
  const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).map(base);
  const installedSo = lines(await run(adb, `find /vendor/natartos/mods/ -name '*.so' 2>/dev/null`));
  const enabledSo = new Set(lines(await run(adb, `find /vendor/natartos/enabled/ -name '*.so' 2>/dev/null`)));
  const mods = installedSo.map((so) => (enabledSo.has(so) ? `${so} (enabled)` : so));
  // Mods are "running" only if the loader is actually mapped into dji_glasses —
  // enabled markers on disk don't mean the live process picked them up.
  const loaderMapped = (
    await run(adb, `grep -c natartos_loader /proc/$(pidof dji_glasses)/maps 2>/dev/null`)
  ).trim();
  const running = loaderMapped !== "" && loaderMapped !== "0";
  return { installed: version !== "", version, bootcount, disabled, mods, running };
}
/** Diagnostic dump for bug reports — mirrors `toolya natartos dump`. */
export async function natartosDump(adb: Adb): Promise<string> {
  const n = (await getContract()).natartos;
  const q = async (cmd: string) => {
    try { return (await run(adb, cmd)).trim(); }
    catch { return "(error)"; }
  };
  const entries: [string, string][] = [
    ["model",     await q("getprop ro.product.model")],
    ["device",    await q("getprop ro.product.device")],
    ["build",     await q("getprop ro.build.display.id")],
    ["kernel",    await q("uname -r")],
    ["id",        await q("id")],
    ["selinux",   await q("getenforce 2>&1")],
    ["usb",       await q("getprop sys.usb.config")],
    ["busybox",   await q("busybox 2>&1 | head -1")],
    ["df",        await q("df /vendor /data 2>&1")],
    ["version",   await q(`grep -o '"natartos_version"[^,}]*' ${n.manifest_device} 2>/dev/null | cut -d'"' -f4 || echo '(not installed)'`)],
    ["bootcount", await q(`if [ -f ${n.bootcount} ]; then od -A n -t u4 -N 4 ${n.bootcount} | tr -d ' '; else echo 0; fi`)],
    ["disabled",  await q(`[ -f ${n.disabled} ] && echo yes || echo no`)],
    ["mods",      await q("ls -la /vendor/natartos/mods/ 2>/dev/null || echo '(none)'")],
    ["loaded",    await q("cat /proc/$(pidof dji_glasses)/maps 2>/dev/null | grep natartos || echo '(none)'")],
    ["inject",    await q("cat /data/local/tmp/natartos_inject.pid 2>/dev/null && echo '' || echo '(no pid)'")],
    ["log",       await q("tail -30 /data/local/tmp/natartos_inject.log 2>/dev/null || echo '(no log)'")],
    ["ps",        await q("ps -A 2>/dev/null | grep -E 'dji_glasses|inject' || echo '(not running)'")],
  ];
  const lines = ["toolya natartos dump (web)"];
  for (const [key, val] of entries) {
    if (val.includes("\n")) {
      lines.push(`[${key}]`);
      for (const l of val.split("\n")) lines.push(`  ${l}`);
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  return lines.join("\n");
}

/** Kill-switch: on = disable mods next boot; off = re-enable + reset bootcount. */
export async function natartosSafe(adb: Adb, on: boolean): Promise<void> {
  const n = (await getContract()).natartos;
  if (on) await run(adb, `touch ${n.disabled}`);
  else await run(adb, `rm -f ${n.disabled}; printf '\\x00\\x00\\x00\\x00' > ${n.bootcount}`);
}

// --- boot start (experimental power-on menu) ---

const BOOT_RC_DEVICE = "/vendor/etc/init/natartos.rc";
const BOOT_SH_DEVICE = "/vendor/natartos/boot.sh";
const BOOT_FLAG = "/data/.natartos_boot_enabled";

// Shipped to /vendor/etc/init/ (never /system). Keep in sync with
// natartos:deploy/natartos.rc.
const BOOT_RC_CONTENT = `# natartos.rc — OPT-IN boot start for natartos (installed by toolya).
service natartos_boot /system/bin/sh /vendor/natartos/boot.sh
    class late_start
    user root
    group root system
    seclabel u:r:su:s0
    oneshot
    disabled

on property:sys.boot_completed=1
    start natartos_boot
`;

export interface BootStartStatus {
  rc: boolean;      // the init .rc is on the device
  sh: boolean;      // boot.sh (installed with natartos) is present
  flag: boolean;    // the master enable flag is set
  enabled: boolean; // all three → menu shows at power-on
}

// Optional self-provisioning payload. A delivered single-file build can inject
// window.__NATARTOS_BOOT_FILES__ = [{path, b64, mode}] with the boot files
// (boot.sh, updated inject.sh, bootmenu binary, natartos.rc). When present, the
// toggle installs them straight to the goggles — no release/CLI needed.
interface BootFile { path: string; b64: string; mode: string }
function bootPayload(): BootFile[] | null {
  const g = (globalThis as unknown as { __NATARTOS_BOOT_FILES__?: unknown }).__NATARTOS_BOOT_FILES__;
  return Array.isArray(g) && g.length > 0 ? (g as BootFile[]) : null;
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "/";
}

export async function natartosBootStatus(adb: Adb): Promise<BootStartStatus> {
  const has = async (p: string) =>
    (await run(adb, `[ -f ${p} ] && echo 1 || echo 0`)).trim() === "1";
  const rc = await has(BOOT_RC_DEVICE);
  const sh = await has(BOOT_SH_DEVICE);
  const flag = await has(BOOT_FLAG);
  return { rc, sh, flag, enabled: rc && sh && flag };
}

/** Turn the power-on Stock/Modified menu on or off.
 *  on  → install the init .rc (if missing) + set the enable flag.
 *  off → clear the flag (the .rc stays but is inert). */
export async function natartosBootStart(
  adb: Adb,
  on: boolean,
  log?: (s: string) => void,
): Promise<void> {
  if (!on) {
    await run(adb, `rm -f ${BOOT_FLAG}`);
    await run(adb, "sync");
    return;
  }

  await run(adb, "mount -o remount,rw /vendor");

  const payload = bootPayload();
  if (payload) {
    // Self-contained install: push every boot file from the embedded payload.
    for (const f of payload) {
      log?.(`pushing ${f.path}…`);
      await run(adb, `mkdir -p ${parentDir(f.path)}`);
      await pushFile(adb, f.path, b64ToBytes(f.b64));
      await run(adb, `chmod ${f.mode} ${f.path}`);
    }
  } else {
    // No payload: the boot files must already be installed with natartos.
    const sh = (await run(adb, `[ -f ${BOOT_SH_DEVICE} ] && echo 1 || echo 0`)).trim() === "1";
    if (!sh) throw new Error("boot.sh is not installed — install/update natartos first.");
    await run(adb, "mkdir -p /vendor/etc/init");
    await pushFile(adb, BOOT_RC_DEVICE, new TextEncoder().encode(BOOT_RC_CONTENT));
    await run(adb, `chmod 644 ${BOOT_RC_DEVICE}`);
  }

  await run(adb, `touch ${BOOT_FLAG}`);
  await run(adb, "sync");
}

export async function setUsbMode(adb: Adb, mode: UsbMode): Promise<void> {
  const cfg = await usbCfgString(mode);
  await run(adb, `setprop sys.usb.config none; sleep 2; setprop sys.usb.config ${cfg}`).catch(() => {
    /* USB re-enumerates mid-command; a dropped reply is expected */
  });
}

export interface ShellResult {
  output: string;
  cwd: string;
}

// The G3 interactive shell is broken (echoes input, emits sec_debug, returns no
// command output). So the web "terminal" is a one-shot REPL over working command
// mode, with cwd tracked client-side so `cd` persists between commands.
export async function runInDir(adb: Adb, line: string, cwd: string): Promise<ShellResult> {
  const esc = cwd.replace(/'/g, "'\\''");
  const wrapped = `cd '${esc}' 2>/dev/null; ${line}\n__t=$?; echo "__PWD:$(pwd)"`;
  const raw = await run(adb, wrapped);
  let newCwd = cwd;
  const out: string[] = [];
  for (const l of raw.split("\n")) {
    const m = l.match(/^__PWD:(.*)$/);
    if (m) newCwd = m[1] || cwd;
    else out.push(l);
  }
  return { output: out.join("\n"), cwd: newCwd };
}

// Usage counters from /data/glasses_statistics.json.
export interface UsageCounters {
  powerOns: number | null;
  motorStarts: number | null;
  raw?: string;
}

// Counters live in /data/glasses_statistics.json:
//   { "glasses_boot_cnt": N, "motor_start_cnt": N }
export async function readUsage(adb: Adb): Promise<UsageCounters> {
  const raw = await run(adb, "cat /data/glasses_statistics.json");
  try {
    const j = JSON.parse(raw);
    return {
      powerOns: typeof j.glasses_boot_cnt === "number" ? j.glasses_boot_cnt : null,
      motorStarts: typeof j.motor_start_cnt === "number" ? j.motor_start_cnt : null,
      raw,
    };
  } catch {
    return { powerOns: null, motorStarts: null, raw };
  }
}
