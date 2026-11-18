# herdr-app-resurrect

[Resurrect](mods/resurrect/) is a [Herdr app](https://herdr.dev) mod that
auto-saves and auto-resumes your coding-agent sessions:

- **Auto-save**: every Herdr live-data change, it records which agent runs
  in each pane (agent, argv, cwd, machine, session id) — persisted in the
  mod's storage, surviving app and machine restarts.
- **Auto-resume**: herdr-core keeps terminals alive across crashes and
  reboots by replacing a lost program with a shell in the same folder.
  Resurrect detects exactly that recovery and types the agent's own resume
  command back into the pane — `claude --resume <id>`,
  `pi --session <id>`, `codex resume <id>` — so the conversation continues
  where it was. Agents you exit normally are never relaunched.
- **Manual panel**: `mod.open resurrect` (command palette) lists tracked
  panes with per-row and bulk **Resume**, for agents lost while the app was
  closed.

It is the herdr-app counterpart of the TUI's `resume_agents_on_restore`
and the `herdr-resurrect` TUI plugin.

## Install

```sh
git clone https://github.com/<you>/herdr-app-resurrect
cp -r herdr-app-resurrect/mods/resurrect ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/resurrect
```

The worker docks itself as an invisible 1 px strip at the bottom of the
layout (`mod.json`: `place: bottom`, `size: 1`), so no layout editing is
needed. If you keep your mods in a dotfiles repo with symlinks, restart
Herdr after edits — symlinked mod folders do not hot-reload (terminals
keep running in herdr-core while the app restarts).

Supported agents: claude, codex, pi, omp, copilot, gemini, cursor,
devin, droid, kimi, mastracode, hermes, opencode, qodercli, qwen, kilo,
grok. Session ids are taken from the running agent's argv when present,
else resolved from the agent CLI's own on-disk session store (newest for
the pane's cwd, on the terminal's machine).

See [RECIPE.md](RECIPE.md) for the full build recipe, and
[preview.png](preview.png) for what the panel looks like.

## License

[MIT](LICENSE)
