# herdr-app-mods

Mods for the [Herdr app](https://herdr.dev) — the GPUI desktop app for
terminals and coding agents. Each folder under `mods/` is one
self-contained mod: copy it into `~/.config/herdr-app/mods/` and it runs
(`herdr-app check` to verify). Install one or all.

## Mods

| Mod | What it does | More |
|---|---|---|
| [resurrect](mods/resurrect/) | Remembers which coding agent ran in each pane and resumes it in place after a crash or reboot (`claude --resume <id>`, `pi --session <id>`); manual recovery panel. | [RECIPE](mods/resurrect/RECIPE.md) · [preview](mods/resurrect/preview.png) |
| [file-picker](mods/file-picker/) | fd-backed file/directory picker that inserts paths into the focused terminal **without pressing Enter**, `@`-prefixed for agents; git-root and zoxide variants. | [RECIPE](mods/file-picker/RECIPE.md) · [preview](mods/file-picker/preview.png) |

## Install

One mod:

```sh
git clone https://github.com/shivammehta25/herdr-app-mods
cp -r herdr-app-mods/mods/<name> ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/<name>
```

On Windows, the mods folder is `%APPDATA%\herdr-app\mods\`.

All mods:

```sh
for d in herdr-app-mods/mods/*/; do cp -r "$d" ~/.config/herdr-app/mods/; done
```

Both mods here self-dock an invisible 1 px strip (`mod.json`:
`place: bottom`, `size: 1`) so nothing needs layout editing. Open from
the command palette (`mod.open <name>`) or bind mod commands in
`keys.json`, e.g.:

```json
{ "global": { "ctrl-alt-p": "file-picker.pick", "ctrl-alt-g": "file-picker.pick-git-root",
              "ctrl-alt-d": "file-picker.pick-dirs", "ctrl-alt-z": "file-picker.pick-zoxide" } }
```

`resurrect.save` / `resurrect.restore` work the same way.

Mods are trusted code: they run programs, read files and use the local
clipboard. Read `main.js` before installing; each mod's RECIPE.md lists
exactly what it runs. If you keep your mods in a dotfiles repo with
symlinks, restart Herdr after edits — symlinked mod folders do not
hot-reload (terminals keep running in herdr-core while the app restarts).

## Adding a mod

Keep the shape: `mods/<name>/{main.js, mod.json, RECIPE.md, preview.png}`
(+ `config.json.example` if configurable). The root README's table is the
index. `herdr-app check mods/<name>` must pass before committing.

## License

[MIT](LICENSE) — one license for the repo; per-mod headers may carry
their own (both current mods also credit their upstreams in RECIPE.md).
