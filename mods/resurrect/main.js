// Resurrect — auto-save and auto-resume agent sessions in the Herdr app.
//
// A port of the herdr TUI's `resume_agents_on_restore` and the
// herdr-resurrect plugin to the app's mod system:
//
//  - Watch: on every live-data change (render) and on a timer, read the
//    core's terminal records (terminals()). Terminals whose foreground is a
//    known agent are remembered — {agent, argv, cwd, session?, reported?} —
//    in localStorage (data/resurrect/store.json), so the memory survives
//    the app closing.
//  - Auto-resume: herdr-core keeps a terminal alive across crashes and
//    reboots by replacing its lost program with a shell in the same folder.
//    Core clears the record's `reported` flag when it does that, while an
//    agent the user exits normally leaves it set — that is the signal.
//    When a remembered agent's pane is back to an idle shell after a loss,
//    its own resume command is typed in once (claude --resume <id>,
//    pi --session <id>, ...), so the conversation continues where it was.
//  - Session ids come from the running agent's own argv when it carries
//    one, else from the agent CLI's on-disk session store, newest for that
//    cwd — the same heuristic as the TUI plugin. Store lookups run on the
//    terminal's machine (local or remote).
//  - Plain programs are tracked but never auto-rerun; the panel offers a
//    manual Resume for them.
//
// Manual use: `mod.open resurrect` (command palette) lists what is tracked
// and can resume anything — including agents lost while the app was closed.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { checking, exec, hc, home, notify, props, terminals, theme } from "herdr";

const WATCH_MS = 30_000; // how often the store is rewritten, even without changes
const SETTLE_MS = 2_000; // let the recovered shell finish starting before typing
const PRUNE_MS = 7 * 24 * 3600_000; // forget terminals gone for a week

// Known agents: relaunch word + resume/continue tails (from the TUI's
// agent_resume.rs plan() table and the resurrect plugin's agents.js).
// `{v}` is the session id.
const KNOWN = {
  claude: { resume: ["--resume", "{v}"], cont: ["--continue"] },
  codex: { resume: ["resume", "{v}"], cont: ["resume", "--last"] },
  gemini: { resume: ["--resume", "{v}"], cont: [] },
  copilot: { resume: ["--resume={v}"], cont: ["--continue"] },
  cursor: { resume: ["--resume={v}"], cont: [], bin: "cursor-agent" },
  devin: { resume: ["--resume", "{v}"], cont: [] },
  droid: { resume: ["--resume", "{v}"], cont: [] },
  kimi: { resume: ["--session", "{v}"], cont: [] },
  mastracode: { resume: ["--thread", "{v}"], cont: [] },
  pi: { resume: ["--session", "{v}"], cont: ["--continue"] },
  omp: { resume: ["--resume={v}"], cont: [] },
  hermes: { resume: ["--resume", "{v}"], cont: [] },
  opencode: { resume: ["--session", "{v}"], cont: [] },
  qodercli: { resume: ["--resume", "{v}"], cont: [] },
  qwen: { resume: ["--resume", "{v}"], cont: [] },
  kilo: { resume: ["--session", "{v}"], cont: [] },
  grok: { resume: ["--resume", "{v}"], cont: [] },
};

// Reasons that mean "the program was lost", not "the user closed it".
// Exit with a code and an explicit kill are final; anything else on a kept
// terminal ends with the shell being restarted in place.
const LOST = new Set(["holder_lost", "stopped_by_restart", "host_shutdown", "server_stop", "signaled"]);

// Shell process names: the pane's idle state.
const SHELLS = new Set(["zsh", "bash", "sh", "dash", "ksh", "fish", "nu", "pwsh", "powershell"]);

const read = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
};

function shellQuote(s) {
  return /[\s"']/.test(s) ? `"${String(s).replace(/(["\\])/g, "\\$1")}"` : String(s);
}

// The session id, if the agent is running with an explicit one
// (claude --resume <id>, codex resume <id>, pi --session <id>, ...).
function sessionFromArgv(argv) {
  const a = argv ?? [];
  for (let i = 0; i < a.length; i++) {
    const arg = String(a[i]);
    let m = /^--resume(?:=(.*))?$/.exec(arg);
    if (m) return m[1] ?? a[i + 1];
    if (arg === "resume" && a[i + 1] && !String(a[i + 1]).startsWith("-")) return a[i + 1];
    m = /^--(session|session-id|thread|conversation)(?:=(.*))?$/.exec(arg);
    if (m) return m[2] ?? a[i + 1];
  }
  return null;
}

function agentOf(fg) {
  const name = String(fg?.name ?? "").toLowerCase();
  if (KNOWN[name]) return name;
  const argv0 = String(fg?.argv?.[0] ?? "").split("/").pop().toLowerCase();
  return KNOWN[argv0] ? argv0 : null;
}

function machineOf(address) {
  return String(address).includes("/") ? String(address).split("/")[0] : null;
}

function shortPath(p) {
  const h = home();
  return p && p.startsWith(h) ? "~" + p.slice(h.length) : p;
}

// Best-effort session lookup from the agent CLI's own on-disk store, newest
// for the cwd — the same idea as the plugin's agent-sessions.js. Runs on the
// terminal's machine, so remote agents resolve too.
async function sessionFromStore(agent, cwd, machine) {
  if (!cwd) return null;
  const name = String(agent ?? "").toLowerCase();
  const run = (script) => exec("sh", ["-c", script], machine ? { on: machine } : undefined);
  try {
    if (name === "claude") {
      const munged = String(cwd).replace(/[^A-Za-z0-9]/g, "-");
      const out = await run(`ls -t "$HOME/.claude/projects/${munged}" 2>/dev/null | head -1`);
      const m = /^([0-9a-f-]{36})\.jsonl$/.exec(out.stdout.trim());
      return m ? m[1] : null;
    }
    if (name === "pi" || name === "omp") {
      const dir = "--" + String(cwd).replace(/^\/+/, "").replace(/[^A-Za-z0-9_.-]/g, "-") + "--";
      const out = await run(`ls -t "$HOME/.pi/agent/sessions/${dir}" 2>/dev/null | head -1`);
      const m = /_([0-9a-fA-F-]{36})\.jsonl$/.exec(out.stdout.trim());
      return m ? m[1] : null;
    }
    if (name === "codex") {
      const out = await run(`grep -l '"cwd":"${cwd}"' "$HOME"/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -3`);
      for (const file of out.stdout.trim().split("\n")) {
        if (!file) continue;
        const meta = await exec("sh", ["-c", `head -c 4096 "${file}"`], machine ? { on: machine } : undefined);
        const m = /"id":"([0-9a-f-]{36})"/.exec(meta.stdout);
        if (m) return m[1];
      }
      return null;
    }
  } catch { /* no store, no sh, or a different layout */ }
  return null;
}

export default class Resurrect extends View {
  init(_props, cx) {
    this.watch = read("watch", {});
    if (checking()) return; // `herdr-app check` stays side-effect free
    this.sent = new Set(); // auto-resume attempts this app run
    this.panel = Boolean(props()?.overlay); // overlay copies are the panel
    if (this.panel) return; // the worker runs in the layout copy
    this.observe(cx); // first scan at once
    cx.timer.every(WATCH_MS, (cx) => this.observe(cx));
  }

  // The state machine. Synchronous and cheap, so it runs on every live-data
  // change (render) and on the timer: a loss that begins and ends between
  // ticks is still caught, because the after-state (idle shell, reported
  // cleared) is what triggers the resume.
  observe(cx) {
    if (!this.watch) return;
    let dirty = false;
    const now = Date.now();
    const list = terminals();
    for (const t of list) {
      if (t.state !== "live") continue;
      const fg = t.foreground;
      const rec = this.watch[t.address] ?? {};
      const agentName = agentOf(fg);

      if (agentName) {
        // An agent is running there: remember everything needed to resume.
        this.watch[t.address] = {
          ...rec,
          agent: agentName,
          argv: fg.argv,
          cwd: fg.cwd || t.cwd,
          session: rec.session ?? sessionFromArgv(fg.argv),
          machine: machineOf(t.address),
          reported: rec.reported || t.reported === true,
          lost: false,
          at: now,
        };
        dirty = true;
        continue;
      }

      // The loss phase: the program died, the shell has not restarted yet.
      // Only loss reasons count, so a normal agent exit is never mistaken
      // for a loss (that is what `reported` below is for).
      if (t.pid == null && LOST.has(String(t.reason ?? ""))) {
        if (rec.agent && !rec.lost) {
          this.watch[t.address] = { ...rec, lost: true, at: now };
          dirty = true;
        }
        continue;
      }

      // Back to an idle shell where we remember an agent. Either the user
      // exited it (core keeps `reported` set) or the terminal was recovered
      // after a loss (core cleared `reported`); both may carry the observed
      // loss flag. Only a loss is resumed automatically.
      const idleShell = t.pid != null && SHELLS.has(String(fg?.name ?? ""));
      const lostNow = rec.lost || (rec.agent && rec.reported === true && t.reported === false);
      if (idleShell && rec.agent && lostNow && !this.sent.has(t.address)) {
        this.sent.add(t.address);
        this.watch[t.address] = { ...rec, lost: false, at: now };
        dirty = true;
        cx.spawn(async (cx) => {
          await new Promise((ok) => cx.timer.after(SETTLE_MS, ok)); // shell settles
          await this.resume(t.address, rec);
          cx.notify();
        });
      }
    }

    // Forget entries whose terminals have been gone for a week.
    const live = new Set(list.map((t) => t.address));
    for (const [addr, rec] of Object.entries(this.watch)) {
      if (!live.has(addr) && now - (rec.at ?? 0) > PRUNE_MS) {
        delete this.watch[addr];
        dirty = true;
      }
    }
    if (dirty) localStorage.setItem("watch", JSON.stringify(this.watch));
  }

  // ---- resuming ----------------------------------------------------------

  async resume(address, rec) {
    const argv = await this.resumeArgv(rec);
    if (!argv?.length) {
      notify({ title: "Resurrect", body: `Nothing to resume in ${address}`, level: "info", timeout: 4000 });
      return false;
    }
    const line = argv.map(shellQuote).join(" ");
    const out = await hc(["send", address, line]);
    if (out.code !== 0) {
      notify({ title: "Resurrect", body: `Could not resume ${rec.agent ?? rec.argv?.[0] ?? ""} in ${address}: ${(out.stderr || out.stdout).trim()}`, level: "warning" });
      return false;
    }
    notify({ title: "Resurrect", body: `Resumed ${rec.agent} in ${address} (${shortPath(rec.cwd ?? "")})`, level: "success", timeout: 4000 });
    return true;
  }

  async resumeArgv(rec) {
    const spec = rec.agent ? KNOWN[String(rec.agent).toLowerCase()] : null;
    if (!spec) return rec.argv?.length ? rec.argv : null; // a plain program: rerun it
    const bin = spec.bin ?? String(rec.agent).toLowerCase();
    let session = rec.session;
    if (!session) session = await sessionFromStore(rec.agent, rec.cwd, rec.machine);
    if (session) return [bin, ...spec.resume.map((a) => a.replace("{v}", session))];
    return [bin, ...spec.cont];
  }

  // ---- panel -------------------------------------------------------------

  statusLine(address, rec) {
    const bits = [address];
    if (rec.agent) bits.push(rec.agent);
    else if (rec.argv?.length) bits.push(String(rec.argv[0]).split("/").pop());
    if (rec.cwd) bits.push(shortPath(rec.cwd));
    if (rec.lost) bits.push("lost");
    if (rec.session) bits.push(String(rec.session).slice(0, 8));
    return bits.join("  ");
  }

  resumeAll(cx) {
    cx.spawn(async (cx) => {
      for (const [address, rec] of Object.entries(this.watch)) {
        if (!rec.agent && !rec.argv?.length) continue;
        await this.resume(address, rec);
      }
      cx.notify();
    });
  }

  render(cx) {
    if (!this.panel) {
      this.observe(cx); // the worker: watch on every live-data change
      return div().w(0).h(0);
    }
    const t = theme();
    const rows = Object.entries(this.watch)
      .filter(([, rec]) => rec.agent || rec.argv?.length)
      .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
      .slice(0, 60);
    const row = (address, rec) =>
      h_flex().id(`row-${address.replace(/[^a-z0-9-]/gi, "-")}`).gap(8).items_center()
        .child(div().flex_1().truncate().text_color(t.foreground).child(this.statusLine(address, rec)))
        .child(h_flex().id(`go-${address}`).px(8).h(24).items_center().rounded(6).border_1().border_color(t.input)
          .text_size(11).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click(() => cx.spawn(async (cx) => { await this.resume(address, rec); cx.notify(); }))
          .child("Resume"));
    return v_flex()
      .id("resurrect")
      .size_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .bg(t.popover)
      .rounded(8)
      .text_size(13)
      .child(h_flex().items_center()
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Resurrect"))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().text_color(t.muted)
        .child(rows.length
          ? `Tracking ${rows.length} terminals. Agents are resumed in place after a crash or reboot.`
          : "Nothing tracked yet — terminals running agents appear here within a minute."))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(4).children(rows.map(([a, rec]) => row(a, rec))))
      .child(h_flex().justify_end().gap(8)
        .child(h_flex().id("scan").px(12).h(30).items_center().rounded(7).border_1().border_color(t.input)
          .text_size(12).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click(() => this.observe(cx))
          .child("Scan now"))
        .child(h_flex().id("all").px(12).h(30).items_center().rounded(7).bg(t.solid).text_color(t.solid_foreground)
          .text_size(12).cursor_pointer().hover((s) => s.opacity(0.88))
          .on_click(() => this.resumeAll(cx))
          .child("Resume all")));
  }
}
