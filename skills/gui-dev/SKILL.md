---
name: gui-dev
description: Orchestrate GUI development with visual feedback via Hammerspoon MCP tools. Use when implementing GUI tickets, making visual changes to the Tauri/React app, or verifying UI appearance.
---

# /gui-dev

Orchestrate the full GUI development feedback loop: make code changes, wait for hot reload, capture screenshots, analyze visual results, and iterate. Uses Hammerspoon automation via MCP tools that communicate with a Hammerspoon HTTP server.

## Prerequisites

- Hammerspoon installed and running with `vtb` module and `vtb_server` loaded (see Setup below)
- Python 3 with `mcp` and `httpx` packages installed
- MCP server configured in `.claude/settings.json` (see below)

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

## Architecture

```
Claude Code <--MCP stdio--> Python MCP Server <--HTTP--> Hammerspoon hs.httpserver <--calls--> vtb.lua
```

No `hs -c` subprocesses are spawned. The Hammerspoon HTTP server runs inside Hammerspoon itself, avoiding zombie shells entirely.

## Coordinate Systems

**You do NOT need to convert coordinates manually.** The MCP tools accept **image coordinates** (from screenshots) and convert to screen coordinates automatically using the window frame.

- `gui_click(image_x, image_y, app_name)` -- takes image coords, converts internally
- `gui_screenshot(app_name)` -- returns inline image, no file path handling needed
- `gui_click_and_screenshot(image_x, image_y, app_name)` -- click + screenshot in one call

If you spot a UI element at position (1200, 630) in a screenshot, just call:
```
gui_click(image_x=1200, image_y=630, app_name="gui")
```

For the rare case when you already have screen coordinates, use `gui_click_screen(x, y)`.

**IMPORTANT:** The Tauri app appears as `gui` in the process list, NOT `Vertebrae`. Use `gui` as the app name, and `"Vertebrae"` as the optional title filter.

## Workflow Overview

```
1. Verify app is running (gui_window_list)
2. Make code changes (React components, styles, etc.)
3. Wait for hot reload (~2-3 seconds)
4. Take screenshot (gui_screenshot) -- image appears inline
5. Analyze the screenshot visually
6. If incorrect, iterate from step 2
```

## Step-by-Step Guide

### 1. Check if App is Running

```
gui_window_list(app_name="gui")
```

Returns window IDs, titles, and frames. If empty, launch the Tauri dev server:

```bash
cd crates/gui && npm run tauri:dev &>/tmp/tauri-dev.log &
```

### 2. Make Code Changes

Edit React components in `crates/gui/src/` or Rust backend in `crates/gui/src-tauri/src/`. Vite hot reload picks up frontend changes automatically. Tauri rebuilds automatically for Rust backend changes (slower).

### 3. Wait for Hot Reload

After editing frontend files, wait 2-3 seconds for Vite. After editing Rust backend, wait 10-15 seconds for Tauri rebuild.

### 4. Capture and Analyze

Take a screenshot -- the image appears directly in the conversation:

```
gui_screenshot(app_name="gui", title="Vertebrae")
```

No need to read a file path. The image is returned inline as base64.

### 5. Click and Verify

When you need to click a UI element and see the result:

```
gui_click_and_screenshot(image_x=500, image_y=300, app_name="gui")
```

This performs the click, waits briefly for UI to update, then returns the screenshot. One tool call instead of two.

### 6. Iterate

If the visual result doesn't match expectations, go back to step 2 and make corrections.

## Available MCP Tools

### Window Management

| Tool | Description |
|------|-------------|
| `gui_window_list(app_name)` | List windows for an application |
| `gui_window_find(title, app_name)` | Find windows by title substring |
| `gui_window_focus(window_id)` | Focus a window by ID |
| `gui_window_focused()` | Get the currently focused window |

### Screenshots (return inline images)

| Tool | Description |
|------|-------------|
| `gui_screenshot(app_name, title?)` | Screenshot app window |
| `gui_screenshot_full()` | Screenshot entire screen |
| `gui_screenshot_window(window_id)` | Screenshot specific window |

### Click (with coordinate conversion)

| Tool | Description |
|------|-------------|
| `gui_click(image_x, image_y, app_name?, title?)` | Click at image coordinates |
| `gui_click_screen(x, y)` | Click at screen coordinates |
| `gui_right_click(image_x, image_y, app_name?, title?)` | Right-click at image coordinates |
| `gui_click_and_screenshot(image_x, image_y, app_name?, title?, delay_ms?)` | Click + screenshot in one call |

### Keyboard

| Tool | Description |
|------|-------------|
| `gui_type(text)` | Type text into focused element |
| `gui_key_press(key, modifiers?)` | Press a key combination |

### Mouse

| Tool | Description |
|------|-------------|
| `gui_mouse_position()` | Get current mouse position |
| `gui_move_mouse(image_x, image_y, app_name?, title?)` | Move mouse to image coordinates |

### UI Inspection

| Tool | Description |
|------|-------------|
| `gui_ui_elements(window_id, max_depth?)` | Read accessibility tree for window |
| `gui_ui_elements_app(app_name, max_depth?)` | Read accessibility tree by app name |

### Health

| Tool | Description |
|------|-------------|
| `gui_health()` | Check if Hammerspoon server is reachable |

## Typical GUI Ticket Workflow

```
1. gui_window_list(app_name="gui")         # Check if app is running
2. gui_screenshot(app_name="gui")           # Capture baseline (inline image)
3. Analyze the screenshot visually           # Understand current state
4. Edit React/CSS files                      # Make the changes
5. Wait 2-3s (Vite) or 10-15s (Rust)        # Wait for hot reload
6. gui_screenshot(app_name="gui")           # Capture new state (inline image)
7. Analyze the screenshot                    # Verify visual result
8. If not right, go to step 4               # Iterate until correct
```

**Key principles:**
- Use `gui_click_and_screenshot` to click and see the result in one call
- Coordinate conversion is automatic -- pass image coordinates from screenshots directly
- Screenshots are inline images -- no file path handling needed
- The app process is named `gui`, not `Vertebrae`
- Use `gui_health()` to verify the Hammerspoon server is running if tools fail

## Troubleshooting

| Problem | Solution |
|---------|----------|
| MCP tools not available | Check MCP server config in `.claude/settings.json` |
| `Hammerspoon server not reachable` | Ensure `vtb_server.start(vtb)` is in your init.lua and Hammerspoon is running |
| App window not found | The process is named `gui`, not `Vertebrae`. Use `gui_window_list("gui")` |
| Click lands in wrong spot | Coordinate conversion uses the window frame. Check `gui_window_list` to verify frame values |
| Screenshot is blank | Ensure Screen Recording permission is granted to Hammerspoon |
| Hot reload not working | Check Vite dev server is running (`npm run dev` in `crates/gui/`) |

## See Also

- `hammerspoon/README.md` - Low-level Hammerspoon primitives documentation
- `hammerspoon/server.lua` - Hammerspoon HTTP server source
- `hammerspoon/mcp/server.py` - MCP server source
- `crates/gui/` - GUI source code (React frontend + Tauri backend)
