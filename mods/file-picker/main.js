// File Picker — pop up a file/directory picker that inserts paths into the
// focused terminal, for prompting AI coding agents.
//
// A port of shivammehta25/herdr-file-picker (the TUI plugin, itself a port of
// raine/tmux-file-picker) to the Herdr app's mod system:
//
//   - fd (or fdfind) lists files, exactly like the plugin.
//   - Selection inserts into the focused pane WITHOUT pressing Enter, so you
//     keep typing your prompt. Text goes out through the clipboard +
//     `terminal.paste` (the app's own paste, never Enter) — the same
//     no-Enter route the app's file drops use.
//   - Paths are quoted as the destination shell reads them (POSIX
//     single-quote; PowerShell double-apostrophe on local Windows targets).
//   - `@`-prefix mode when the target pane holds an agent, so the paths read
//     as file references (the plugin's HERDR_FILE_PICKER_AT_PREFIX=auto).
//   - Variants (openOverlay props): "files" (default), "dirs", "git-root",
//     "zoxide", "zoxide-dirs".
//
// Open from the command palette (`mod.open file-picker`) or bind keys to
// `mod:file-picker` commands in keys.json:
//   "mod:file-picker": { "ctrl-p": "file-picker.pick" }
//
// Requires fd (or fdfind) on PATH; zoxide for the zoxide variants.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { checking, closeOverlay, exec, focused, home, nextCommand, notify, openOverlay, panes, props, readTextFile, run, spaces, terminals, theme, window } from "herdr";

const FD_LIMIT = 20000; // entries listed per search root (fd is fast; the list is virtual anyway)
const VARIANTS = ["files", "dirs", "git-root", "zoxide", "zoxide-dirs"];
// Friendly command names from keys.json map to variants.
const COMMANDS = { pick: "files", "pick-dirs": "dirs", "pick-git-root": "git-root", "pick-zoxide": "zoxide", "pick-zoxide-dirs": "zoxide-dirs" };

// Paths as the destination shell reads them. Mirrors the app's own
// drag_paths::quote_paths: trailing space, no Enter, POSIX quoting; Windows
// only for a local (unprefixed) target.
function quotePaths(paths, target) {
  const windows = !String(target ?? "").includes("/") && platformIsWindows();
  return paths
    .map((p) => {
      if (/^[\w./._\-+=:@%~]+$/.test(p) && (!windows || !p.includes(","))) return p;
      return windows ? `'${p.replaceAll("'", "''")}'` : `'${p.replaceAll("'", "'\\''")}'`;
    })
    .join(" ") + " ";
}

function platformIsWindows() {
  return window()?.platform === "windows";
}

// fd flags per variant, like the plugin's.
function fdFlags(variant) {
  const base = ["--hidden", "--follow", "--exclude", ".git"];
  if (variant === "dirs") return [...base, "--type", "d"];
  return [...base, "--type", "f"];
}

// The search root: the focused pane's cwd (like the plugin), else home.
function paneDir() {
  const f = focused();
  return f?.cwd || home();
}

// The focused pane's terminal address, for paste routing and agent detection.
function paneTerminal() {
  return focused()?.terminal ?? null;
}



// An agent occupies the pane when the pane's program is an agent or its
// terminal reports a status — the plugin used herdr's pane.agent.
function paneHasAgent(terminal) {
  if (!terminal) return false;
  const t = terminals().find((x) => x.address === terminal);
  if (t?.report?.state || t?.status) return true;
  const p = panes().find((x) => x.terminal === terminal);
  return Boolean(p?.program?.agent);
}

// cwd for a remote pane is remote; only list files there with fd via hc exec?
// The plugin ran locally in the pane's own machine context. In the app, exec
// can run on the pane's machine: spaces().machine for its space.
function machineOf(terminal) {
  if (!terminal) return null;
  const pane = panes().find((p) => p.terminal === terminal);
  if (pane) {
    const space = spaces().find((s) => s.tabs?.some((tab) => tab.id === pane.tab));
    if (space?.machine) return space.machine;
  }
  return null;
}

export default class FilePicker extends View {
  init(_props, cx) {
    this.variant = props()?.variant ?? "files";
    this.at = 0;
    this.filter = "";
    this.files = [];
    this.preview = null;
    this.root = null;
    this.gitRoot = null;
    this.input = InputState.new({ placeholder: this.placeholder() });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.pick(cx));
    this.handle = cx.focus_handle();
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    if (!checking()) this.load(cx);
    // Mod commands from keys.json (mod:file-picker section): a variant name
    // opens the picker for it, closing any open copy first.
    cx.spawn(async (cx) => {
      for (;;) {
        let command;
        try { command = await nextCommand(); } catch { break; }
        const variant = typeof command === "string" ? COMMANDS[command] ?? (VARIANTS.includes(command) ? command : null) : null;
        if (variant) {
          const open = props()?.overlay;
          if (open) closeOverlay(open);
          openOverlay({ mod: "file-picker", kind: "dialog", width: 760, height: 480, props: { variant } });
        }
      }
    });
  }

  placeholder() {
    return {
      files: "Pick files (relative to the pane's folder)…",
      dirs: "Pick directories…",
      "git-root": "Pick files (relative to the git root)…",
      zoxide: "Pick files from a zoxide directory…",
      "zoxide-dirs": "Pick a zoxide directory…",
    }[this.variant] ?? "Pick files…";
  }

  async load(cx) {
    try {
      if (this.variant === "zoxide" || this.variant === "zoxide-dirs") {
        await this.loadZoxide(cx);
        return;
      }
      const dir = paneDir();
      this.root = dir;
      if (this.variant === "git-root") {
        const out = await exec("git", ["-C", dir, "rev-parse", "--show-cdup"], { cwd: dir });
        if (out.code !== 0) {
          notify({ title: "File picker", body: `'${dir}' is not inside a git repository.`, level: "warning" });
          this.files = [];
          cx.notify();
          return;
        }
        // cdup is relative; normalize against the search root like the plugin.
        const cdup = out.stdout.trim() || ".";
        this.gitRoot = normalize(join(dir, cdup));
      }
      const searchRoot = this.gitRoot ?? dir;
      this.root = searchRoot;
      const fd = await fdBin();
      if (!fd) {
        notify({ title: "File picker", body: "Required command 'fd' (or 'fdfind') not found.", level: "warning" });
        cx.notify();
        return;
      }
      const out = await exec(fd, [...fdFlags(this.variant), "--max-results", String(FD_LIMIT), "."], { cwd: searchRoot });
      const lines = out.stdout ? out.stdout.split("\n").filter(Boolean) : [];
      this.files = lines.map((l) => normalize(join(searchRoot, l)));
      cx.notify();
    } catch (e) {
      notify({ title: "File picker", body: `Listing failed: ${e}`, level: "warning" });
      cx.notify();
    }
  }

  async loadZoxide(cx) {
    const out = await exec("zoxide", ["query", "-l"]);
    if (out.code !== 0 || !out.stdout.trim()) {
      notify({ title: "File picker", body: "zoxide not available or has no directories yet.", level: "warning" });
      cx.notify();
      return;
    }
    this.zDirs = out.stdout.split("\n").filter(Boolean).reverse(); // most frequent first
    if (this.variant === "zoxide-dirs") {
      this.files = this.zDirs.map(normalize);
      this.root = null; // absolute paths out
      cx.notify();
      return;
    }
    // zoxide files: first pick a directory (Enter), then list its files.
    this.stage = "dir";
    this.files = this.zDirs.map(normalize);
    cx.notify();
  }

  shown(cx) {
    const f = (this.filter ?? "").toLowerCase();
    let list = this.files;
    if (f) list = list.filter((p) => p.toLowerCase().includes(f));
    return list;
  }

  // The output path for a selected file: relative to what the variant implies.
  outPath(p) {
    if (this.variant === "zoxide" || this.variant === "zoxide-dirs" || this.root === null) {
      return p; // absolute
    }
    if (this.variant === "git-root") return relativeTo(this.gitRoot, p);
    return relativeTo(this.root, p);
  }

  async pick(cx) {
    const list = this.shown(cx);
    const chosen = list[this.at];
    if (!chosen) return;

    // zoxide files: two-stage pick.
    if (this.variant === "zoxide" && this.stage === "dir") {
      this.stage = "files";
      this.root = chosen;
      this.filter = "";
      this.input.set_value("");
      this.at = 0;
      const fd = await fdBin();
      if (!fd) {
        notify({ title: "File picker", body: "Required command 'fd' (or 'fdfind') not found.", level: "warning" });
        return;
      }
      const out = await exec(fd, [...fdFlags("files"), "--max-results", String(FD_LIMIT), "."], { cwd: chosen });
      this.files = (out.stdout ? out.stdout.split("\n").filter(Boolean) : []).map((l) => normalize(join(chosen, l)));
      cx.notify();
      return;
    }

    const terminal = paneTerminal();
    const at = paneHasAgent(terminal) || false;
    const paths = [this.outPath(chosen)];
    await this.insert(terminal, paths, at, cx);
  }

  async insert(terminal, paths, atPrefix, cx) {
    const text = (atPrefix ? paths.map((p) => `@${p} `).join("") : quotePaths(paths, terminal)).trimEnd() + " ";
    const overlay = props()?.overlay;
    // Paste needs keyboard focus back on the pane: close first.
    if (overlay) closeOverlay(overlay);
    await clipboardWrite(text);
    // terminal.paste goes to the focused terminal (the pane, now focused again).
    run("terminal.paste");
  }

  // A small text preview of the selected row.
  async previewOf(p, cx) {
    if (this.previewPath === p) return;
    this.previewPath = p;
    this.preview = null;
    try {
      const text = await readTextFile(p);
      this.preview = text == null ? null : text.slice(0, 4000);
    } catch { this.preview = null; }
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const list = this.shown(cx);
    this.at = Math.min(this.at, Math.max(0, list.length - 1));
    const row = (p, i) =>
      h_flex()
        .id(`f-${i}`)
        .px(10)
        .h(26)
        .items_center()
        .gap(6)
        .text_size(12)
        .when(i === this.at, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click(() => {
          if (this.at === i) cx.spawn(async (cx) => this.pick(cx)); // click the selected row: insert
          else {
            this.at = i;
            cx.spawn(async (cx) => { await this.previewOf(list[this.at], cx); cx.notify(); });
          }
        })
        .child(svg("icons/file.svg").size(12).flex_none().text_color(t.dim))
        .child(div().truncate().text_color(i === this.at ? t.foreground : t.muted).child(this.outPath(p)));
    return v_flex()
      .id("file-picker")
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      .p(14)
      .gap(10)
      .bg(t.popover)
      .rounded(8)
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") { closeOverlay(props()?.overlay); return; }
        if (k === "down") this.at = (this.at + 1) % Math.max(1, list.length);
        else if (k === "up") this.at = (this.at + list.length - 1) % Math.max(1, list.length);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().flex_1().child(Input.new(this.input))),
      )
      .child(
        h_flex().flex_1().min_h(0).gap(10)
          .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(1)
            .children(list.slice(0, 500).map((p, i) => row(p, i)))
            .when(list.length > 500, (el) => el.child(div().px(10).text_size(11).text_color(t.dim).child(`… ${list.length - 500} more — type to filter`))))
          .child(v_flex().w(300).min_h(0).overflow_y_scrollbar().p(8).rounded(6).bg(t.surface)
            .child(div().text_size(11).font_semibold().text_color(t.dim).child("Preview"))
            .child(v_flex().mt(4).gap(0)
              .children((this.preview ?? (this.previewPath ? "(binary or too large)" : "Select a file")).split("\n").slice(0, 200).map((line, li) => div().id(`pv-${li}`).text_size(11).text_color(t.muted).child(line)))))
      )
      .child(h_flex().gap(8).text_size(11).text_color(t.dim)
        .child("↑↓ select · Enter or click selected row inserts (no Enter sent) · Esc close"));
  }
}

// ---- helpers ---------------------------------------------------------------

let FD = null;
async function fdBin() {
  if (FD !== null) return FD;
  for (const bin of ["fd", "fdfind"]) {
    try {
      const r = await exec("sh", ["-c", `command -v ${bin}`]);
      if (r.code === 0 && r.stdout.trim()) { FD = bin; return FD; }
    } catch {}
  }
  FD = false;
  return FD;
}

// Clipboard write for the paste route. pbcopy on macOS, xclip/wl-copy on
// Linux, clip.exe on WSL; last resort: OSC 52 is not reachable from a mod.
async function clipboardWrite(text) {
  const cmds = [
    ["pbcopy"],
    ["xclip", "-selection", "clipboard"],
    ["wl-copy"],
    ["clip.exe"],
  ];
  const safe = text.replace(/'/g, `'\''`);
  for (const cmd of cmds) {
    try {
      const r = await exec("sh", ["-c", `printf '%s' '${safe}' | ${cmd}`]);
      if (r.code === 0) return true;
    } catch {}
  }
  return false;
}

// join/normalize/relativeTo: pure JS path math (the plugin's _normalize_path /
// _relative_to, which existed to avoid realpath deps).
function join(base, rel) {
  if (!rel) return base;
  if (rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) return rel;
  return `${base.replace(/[/]+$/, "")}/${rel}`;
}

function normalize(p) {
  const absolute = p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
  const parts = p.split(/[\\/]+/);
  const out = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
    } else out.push(part);
  }
  const joined = out.join("/");
  return absolute ? (joined.match(/^[A-Za-z]:/) ? joined : `/${joined}`) : (joined || ".");
}

function relativeTo(base, target) {
  const b = normalize(base).replace(/^[A-Za-z]:[\\/]/, "").split("/").filter(Boolean);
  const t = normalize(target).replace(/^[A-Za-z]:[\\/]/, "").split("/").filter(Boolean);
  let i = 0;
  while (i < b.length && i < t.length && b[i] === t[i]) i++;
  const out = [...Array(b.length - i).fill(".."), ...t.slice(i)];
  return out.join("/") || ".";
}
