---
name: gui-dev
description: Orchestrate GUI development with visual feedback via Hammerspoon MCP tools. Use when implementing GUI tickets, making visual changes to the Tauri/React app, or verifying UI appearance — including from a git worktree while other worktrees' dev builds are running.
---

# /gui-dev

Orchestrate the full GUI development feedback loop: make code changes, wait for hot reload, capture screenshots, analyze visual results, and iterate. Uses Hammerspoon automation via MCP tools that communicate with a Hammerspoon HTTP server.

## Prerequisites

- Hammerspoon installed and running with `vtb` module and `vtb_server` loaded (see Setup below)
- Python 3 with `mcp` and `httpx` packages installed
- MCP server configured in `.mcp.json` (see below)

## Setup

Add this to your `~/.hammerspoon/init.lua`:

```lua
vtb = dofile("/path/to/vertebrae/hammerspoon/vtb.lua")
vtb_server = dofile("/path/to/vertebrae/hammerspoon/server.lua")
vtb_server.start(vtb)
```

Then reload Hammerspoon. The HTTP server starts on `localhost:19024`.

Install MCP server dependencies:

```bash
pip install -r hammerspoon/mcp/requirements.txt
```

After changing `vtb.lua` or `server.lua`, reload Hammerspoon. After changing `hammerspoon/mcp/server.py`, restart the MCP server (`/mcp`).

## Architecture

```
Claude Code <--MCP stdio--> Python MCP Server <--HTTP--> Hammerspoon hs.httpserver <--calls--> vtb.lua
```

No `hs -c` subprocesses are spawned. The Hammerspoon HTTP server runs inside Hammerspoon itself, avoiding zombie shells entirely.

## Targeting the right app instance

The Tauri app is named `gui` when run from `tauri dev` and `Vertebrae` when installed as a bundle. Either name matches either build, so the default `app_name="gui"` works for both. `"Vertebrae"` is the window title filter.

Several dev builds can run at once — one per worktree, often started by other sessions — and they are all named `gui`. Every app-targeted tool takes an optional `worktree` argument and acts only on the instance running from that checkout:

| `worktree` value | Targets |
|---|---|
| `"/abs/path/to/checkout"` | The dev build launched from that checkout (main repo or worktree) |
| `"installed"` | The bundled app (`/Applications/Vertebrae.app`) |
| omitted | `VTB_GUI_WORKTREE` if the MCP server has it, else the checkout the session started in |

The instance is identified by its process working directory: `tauri dev` runs the binary from `<checkout>/crates/gui/src-tauri`, even when the binary was built into a shared `CARGO_TARGET_DIR` elsewhere.

Matching rules:

- An explicit `worktree` must match, or the tool fails.
- When `worktree` is omitted and only one instance is running, that instance is used wherever it lives.
- When several are running and none matches, the tool fails with a list of what is running (pid and worktree) instead of driving another session's app.

**Working in a worktree from a session rooted in the main checkout** (the usual `/implement` setup): the default resolves to the main checkout, so pass `worktree=` on every app-targeted call:

```
gui_screenshot(worktree="/Users/me/code/vertebrae-1a2b3c4d")
gui_click_and_screenshot(image_x=500, image_y=300, worktree="/Users/me/code/vertebrae-1a2b3c4d")
```

Run `gui_instances()` whenever unsure; it lists every instance with its pid, worktree (`root`, `null` for the installed app), windows, and whether it is the default target.

## Coordinate Systems

**You do NOT need to convert coordinates manually.** The MCP tools accept **image coordinates** (from screenshots) and convert to screen coordinates automatically using the target instance's window frame.

- `gui_click(image_x, image_y, worktree=...)` -- takes image coords, converts internally
- `gui_screenshot(worktree=...)` -- returns inline image, no file path handling needed
- `gui_click_and_screenshot(image_x, image_y, worktree=...)` -- click + screenshot in one call

If you spot a UI element at position (1200, 630) in a screenshot, click it on the same instance:
```
gui_click(image_x=1200, image_y=630, worktree="/abs/path/to/worktree")
```

For the rare case when you already have screen coordinates, use `gui_click_screen(x, y)`.

## Workflow Overview

```
1. Find your instance (gui_instances) -- launch it if missing
2. Make code changes (React components, styles, etc.)
3. Wait for hot reload (~2-3 seconds)
4. Take screenshot (gui_screenshot, worktree=...) -- image appears inline
5. Analyze the screenshot visually
6. If incorrect, iterate from step 2
```

## Step-by-Step Guide

### 1. Find or Launch Your Instance

```
gui_instances()
```

Look for an instance whose `root` is your checkout. If there is none, launch the dev build from that checkout:

```bash
cd <checkout>/crates/gui && npm run tauri:dev &>/tmp/tauri-dev-<id>.log &
```

Vite uses `strictPort` on 1420, so a second dev build fails to start while another checkout's server holds that port (`lsof -nP -iTCP:1420 -sTCP:LISTEN`). Give each extra worktree its own port:

```bash
cd <worktree>/crates/gui && npm ci   # first run only
npx tauri dev --config '{"build":{"devUrl":"http://localhost:1430","beforeDevCommand":"npm run tauri:prepare-sidecars && npx vite --port 1430"}}' \
  &>/tmp/tauri-dev-<id>.log &
```

A fresh worktree builds the whole workspace into its own `target/` on first launch, which takes several minutes. Wait for the log line `Running .../debug/gui` (or an `error`) with a background `until grep -q ...` loop rather than polling with sleeps. Then confirm with `gui_instances()`.

### 2. Make Code Changes

Edit React components in `crates/gui/src/` or Rust backend in `crates/gui/src-tauri/src/` of the same checkout the instance runs from. Vite hot reload picks up frontend changes automatically. Tauri rebuilds automatically for Rust backend changes (slower).

### 3. Wait for Hot Reload

After editing frontend files, wait 2-3 seconds for Vite. After editing Rust backend, wait 10-15 seconds for Tauri rebuild.

### 4. Capture and Analyze

Take a screenshot -- the image appears directly in the conversation:

```
gui_screenshot(title="Vertebrae", worktree="/abs/path/to/worktree")
```

No need to read a file path. The image is returned inline as base64. Native popups (for example an open `<select>` menu) are separate windows and do not appear in window screenshots; use `gui_screenshot_full()` for those.

### 5. Click and Verify

When you need to click a UI element and see the result:

```
gui_click_and_screenshot(image_x=500, image_y=300, worktree="/abs/path/to/worktree")
```

This performs the click, waits briefly for UI to update, then returns the screenshot. One tool call instead of two.

Other sessions may be driving their own instances, so your window can lose focus between calls, and a click on an unfocused window only focuses it. If a click seems to do nothing, focus first with `gui_window_focus(window_id)` (ids come from `gui_instances()`), then click.

### 6. Iterate

If the visual result doesn't match expectations, go back to step 2 and make corrections.

## Available MCP Tools

`worktree?` is optional on every tool that takes it; see "Targeting the right app instance".

### Instances and Windows

| Tool | Description |
|------|-------------|
| `gui_instances(app_name?)` | List running instances with pid, worktree (`root`) and windows |
| `gui_window_list(app_name, worktree?)` | List windows of the target instance |
| `gui_window_find(title, app_name, worktree?)` | Find the target instance's windows by title substring |
| `gui_window_focus(window_id)` | Focus a window by ID |
| `gui_window_focused()` | Get the currently focused window |

### Screenshots (return inline images)

| Tool | Description |
|------|-------------|
| `gui_screenshot(app_name?, title?, worktree?)` | Screenshot the target instance's window |
| `gui_screenshot_full()` | Screenshot entire screen |
| `gui_screenshot_window(window_id)` | Screenshot a specific window |

### Click (with coordinate conversion)

| Tool | Description |
|------|-------------|
| `gui_click(image_x, image_y, app_name?, title?, worktree?)` | Click at image coordinates |
| `gui_click_screen(x, y)` | Click at screen coordinates |
| `gui_right_click(image_x, image_y, app_name?, title?, worktree?)` | Right-click at image coordinates |
| `gui_click_and_screenshot(image_x, image_y, app_name?, title?, delay_ms?, worktree?)` | Click + screenshot in one call |

### Keyboard

Keyboard tools act on whatever has focus; focus your window first.

| Tool | Description |
|------|-------------|
| `gui_type(text)` | Type text into focused element |
| `gui_key_press(key, modifiers?)` | Press a key combination |

### Mouse

| Tool | Description |
|------|-------------|
| `gui_mouse_position()` | Get current mouse position |
| `gui_move_mouse(image_x, image_y, app_name?, title?, worktree?)` | Move mouse to image coordinates (hover states) |

### UI Inspection

| Tool | Description |
|------|-------------|
| `gui_ui_elements(window_id, max_depth?)` | Read accessibility tree for window |
| `gui_ui_elements_app(app_name, max_depth?, worktree?)` | Read the target instance's accessibility tree |

### Health

| Tool | Description |
|------|-------------|
| `gui_health()` | Check if Hammerspoon server is reachable |

## Typical GUI Ticket Workflow

```
WT=/abs/path/to/worktree
1. gui_instances()                              # Is an instance running from $WT?
2. Launch from $WT if not (see step 1 above)
3. gui_screenshot(worktree=WT)                  # Capture baseline (inline image)
4. Analyze the screenshot visually              # Understand current state
5. Edit React/CSS files in $WT                  # Make the changes
6. Wait 2-3s (Vite) or 10-15s (Rust)            # Wait for hot reload
7. gui_screenshot(worktree=WT)                  # Capture new state (inline image)
8. Analyze the screenshot                       # Verify visual result
9. If not right, go to step 5                   # Iterate until correct
```

**Key principles:**
- Always know which instance you are driving: pass `worktree=` when the session's checkout is not the one you edit
- Use `gui_click_and_screenshot` to click and see the result in one call
- Coordinate conversion is automatic -- pass image coordinates from screenshots directly
- Screenshots are inline images -- no file path handling needed
- `gui` and `Vertebrae` both name the app; instances are told apart by worktree, not name
- Use `gui_health()` to verify the Hammerspoon server is running if tools fail
- Leave other sessions' instances alone; never quit or resize an app you did not launch

## Troubleshooting

| Problem | Solution |
|---------|----------|
| MCP tools not available | Check the `hammerspoon-gui` server in `.mcp.json` and that it is enabled |
| `Hammerspoon server not reachable` | Ensure `vtb_server.start(vtb)` is in your init.lua and Hammerspoon is running |
| `no instance running from <path>` | Your instance isn't running, or several are and none is yours. Run `gui_instances()`, then launch yours or pass the right `worktree=` |
| `app is not running` | No `gui`/`Vertebrae` process found. Launch the dev build |
| Screenshots show another worktree's app | Pass `worktree=` explicitly, or set `VTB_GUI_WORKTREE` for the MCP server |
| `/app/instances` errors or `worktree` is ignored | Hammerspoon still has the old `vtb.lua`/`server.lua` loaded. Reload Hammerspoon |
| Dev build exits: port 1420 in use | Another checkout's Vite holds it (`strictPort`). Launch on another port (step 1) |
| Click does nothing | The window wasn't focused; `gui_window_focus(window_id)` then click again |
| Click lands in wrong spot | Coordinate conversion uses the target window's frame. Check `gui_window_list(..., worktree=...)` frame values |
| `a bytes-like object is required` | The MCP server predates the base64 decode fix; restart it (`/mcp`) |
| Screenshot is blank | Ensure Screen Recording permission is granted to Hammerspoon |
| Hot reload not working | Check Vite dev server for that checkout is running (`tail` its tauri-dev log) |

## See Also

- `hammerspoon/README.md` - Low-level Hammerspoon primitives documentation
- `hammerspoon/server.lua` - Hammerspoon HTTP server source
- `hammerspoon/mcp/server.py` - MCP server source (instance resolution lives here)
- `hammerspoon/mcp/test_server.py` - Unit tests for instance selection
- `crates/gui/` - GUI source code (React frontend + Tauri backend)
