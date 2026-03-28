---
name: gui-dev
description: Orchestrate GUI development with visual feedback via Hammerspoon screenshot capture. Use when implementing GUI tickets, making visual changes to the Tauri/React app, or verifying UI appearance.
---

# /gui-dev

Orchestrate the full GUI development feedback loop: make code changes, wait for hot reload, capture screenshots, analyze visual results, and iterate. Uses Hammerspoon automation via the `vtb-gui` CLI wrapper.

## Prerequisites

- Hammerspoon installed and running with the `vtb` module loaded
- `hs` CLI command available on PATH
- Python 3 with PIL/numpy (for image diffing)
- The `hammerspoon/bin/` directory on PATH (or use absolute paths)

## Workflow Overview

```
1. Launch dev app (or verify it's running)
2. Make code changes (React components, styles, etc.)
3. Wait for hot reload (~2-3 seconds)
4. Capture screenshot of the app window
5. Read the screenshot image to analyze visual result
6. If incorrect, iterate from step 2
```

## Critical: Coordinate Systems

Screenshots use **image coordinates** (0,0 = top-left of the captured window). Click/mouse commands use **screen coordinates** (absolute position on the display). You MUST convert between them.

**Conversion formula:**
```
screen_x = window_frame.x + image_x
screen_y = window_frame.y + image_y
```

Get the window frame from `vtb-gui window list gui`:
```json
{"app":"gui","frame":{"x":911,"y":292,"w":3077,"h":1787},"title":"Vertebrae","id":3509}
```

If a UI element is at image coordinates (1200, 630), the click target is:
```
screen_x = 911 + 1200 = 2111
screen_y = 292 + 630 = 922
```

**IMPORTANT:** The Tauri app appears as `gui` in the process list, NOT `Vertebrae`. Use `gui` as the app name for window commands, and `"Vertebrae"` as the optional title filter.

## Critical: Performance

**Chain commands in a single Bash call.** Each separate tool invocation adds overhead. Do this:

```bash
# GOOD: one Bash call, no sleep needed
vtb-gui click 2111 922 && vtb-gui screenshot-app gui "Vertebrae"
```

```bash
# BAD: two separate tool calls with sleep
vtb-gui click 2111 922    # call 1
sleep 1                    # unnecessary wait
vtb-gui screenshot-app gui # call 2
```

**Crop inline with screenshots.** Don't take a full screenshot, then crop, then read — combine when possible:

```bash
# Capture and crop in one chain
vtb-gui screenshot-app gui "Vertebrae" && vtb-gui screenshot-region "$(jq -r .path < /tmp/last.json)" 100 200 400 300
```

**UI updates are instant** after clicks in a web-based app. Only sleep when waiting for:
- Hot reload after code changes (2-3s for Vite, 10-15s for Rust)
- Network requests to complete
- Animations to finish

## Step-by-Step Guide

### 1. Launch the Development App

Start the Tauri dev server (from `crates/gui/`):

```bash
cd crates/gui && npm run tauri:dev &>/tmp/tauri-dev.log &
```

Wait for the window to appear (first build takes several minutes):

```bash
vtb-gui wait-for-window gui 120
```

To check if the app is already running:

```bash
vtb-gui window list gui
```

**Note:** The process name is `gui`, the window title is `Vertebrae`.

### 2. Make Code Changes

Edit React components in `crates/gui/src/` or Rust backend in `crates/gui/src-tauri/src/`. Vite hot reload picks up frontend changes automatically. Tauri rebuilds automatically for Rust backend changes (slower).

### 3. Wait for Hot Reload

After editing frontend files, wait 2-3 seconds for Vite hot reload. After editing Rust backend files, wait 10-15 seconds for Tauri rebuild.

### 4. Capture and Analyze in One Step

Capture the app window and read the result immediately:

```bash
vtb-gui screenshot-app gui "Vertebrae"
```

Returns JSON: `{"success": true, "path": "/tmp/lua_XXXXXX.png", "window_id": 3509}`

Then read the image with the Read tool to analyze it visually.

**For small/dense UI areas, crop first:**

```bash
# Take screenshot, then crop to the area of interest
vtb-gui screenshot-app gui "Vertebrae"
# Use the returned path to crop:
vtb-gui screenshot-region /tmp/lua_XXXXXX.png 700 250 1700 700
```

Image coordinates for cropping: `<source> <x> <y> <width> <height>` — all in image pixels (0,0 = top-left of window).

### 5. Analyze the Screenshot

Read the screenshot file to visually inspect the result:

```
Read the PNG file at the path returned by the screenshot command.
```

The Read tool supports reading image files and presents them visually for analysis.

### 6. Iterate

If the visual result doesn't match expectations, go back to step 2 and make corrections. Use the before/after comparison tools to verify changes quantitatively.

## Before/After Comparison

When iterating on visual changes, use the screenshot pipeline to automatically capture before/after and diff:

```bash
# Full pipeline: capture before, execute an action, capture after, diff
vtb-gui screenshot-pipeline Vertebrae "click 500 300" "" 2
```

Or do it manually:

```bash
# 1. Capture "before" state
vtb-gui screenshot-app Vertebrae
# Note the path from the response

# 2. Make code changes and wait for reload

# 3. Capture "after" state
vtb-gui screenshot-app Vertebrae
# Note the path from the response

# 4. Compare the two screenshots
vtb-gui screenshot-diff /tmp/vtb-before.png /tmp/vtb-after.png
```

The diff returns a similarity score (0.0-1.0) and generates a visual diff image highlighting changed pixels in red.

## Cropping a Region

To focus analysis on a specific area of the UI:

```bash
vtb-gui screenshot-region /tmp/vtb-screenshot.png 100 200 400 300
```

Arguments: `<source_png> <x> <y> <width> <height>`

## Interacting with the UI

### Click and Type

All click/mouse commands use **screen coordinates** (not image coordinates). See the coordinate system section above.

```bash
# Click at screen coordinates — chain with screenshot for instant feedback
vtb-gui click 2111 922 && vtb-gui screenshot-app gui "Vertebrae"

# Right-click
vtb-gui right-click 500 300

# Type text into the focused element
vtb-gui type "search query"

# Press a key combination (e.g., Cmd+S)
vtb-gui key-press s cmd

# Move mouse without clicking
vtb-gui move-mouse 500 300

# Get current mouse position (useful for debugging coordinate issues)
vtb-gui mouse-position
```

### Finding Click Targets

**Preferred approach: screenshot and crop.** Take a screenshot, crop the area of interest, read it visually, then calculate screen coordinates from image coordinates.

```bash
# 1. Screenshot and get window frame
vtb-gui window list gui
# → frame: {x: 911, y: 292, w: 3077, h: 1787}

# 2. Crop an area to see UI elements clearly
vtb-gui screenshot-app gui "Vertebrae"
vtb-gui screenshot-region /tmp/lua_XXX.png 20 170 60 100

# 3. Read the crop, identify the element at image coords (50, 220)
# 4. Convert: screen_x=911+50=961, screen_y=292+220=512
vtb-gui click 961 512
```

**Fallback: accessibility inspection.** For web-based Tauri apps, this is slow and often returns a flat tree. Use depth 1 to avoid timeouts:

```bash
vtb-gui ui-elements-app gui 1
```

### Window Management

```bash
# List all windows (use "gui" as app name, NOT "Vertebrae")
vtb-gui window list gui

# Find windows by title substring
vtb-gui window find "Settings" gui

# Focus a window by ID
vtb-gui window focus 3509

# Get the currently focused window
vtb-gui window focused
```

## Typical GUI Ticket Workflow

When implementing a GUI ticket, follow this pattern:

```
1. vtb-gui window list gui                       # Check if app is running
2. vtb-gui screenshot-app gui "Vertebrae"         # Capture baseline (note path)
3. Read the screenshot, crop areas of interest     # Understand current state
4. Edit React/CSS files                            # Make the changes
5. Sleep 2-3s (Vite) or 10-15s (Rust)             # Wait for hot reload
6. vtb-gui screenshot-app gui "Vertebrae"          # Capture new state
7. Read the screenshot                             # Verify visual result
8. vtb-gui screenshot-diff <before> <after>        # Quantify changes (optional)
9. If not right, go to step 4                      # Iterate until correct
```

**Key principles:**
- Chain `click && screenshot` in one Bash call — no sleep between them
- Use `screenshot-region` to crop dense areas before reading — full screenshots are often too small to analyze
- Convert image coords → screen coords before clicking (add window frame x/y)
- The app process is named `gui`, not `Vertebrae`

## Output Format

All `vtb-gui` commands return JSON. Success responses include `"success": true`. Error responses include an `"error"` field. Screenshot commands return a `"path"` field with the absolute path to the PNG file.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `hs command not found` | Install Hammerspoon and enable the CLI tool |
| `no JSON output` | Check that `vtb.lua` is loaded in Hammerspoon's `init.lua` |
| App window not found | The process is named `gui`, not `Vertebrae`. Use `vtb-gui window list gui` |
| Click lands in wrong spot | You're using image coords instead of screen coords. Add window frame x/y |
| Commands feel slow | Chain with `&&` in one Bash call. Don't sleep between click and screenshot |
| Screenshot is blank | Ensure Screen Recording permission is granted to Hammerspoon |
| Hot reload not working | Check Vite dev server is running (`npm run dev` in `crates/gui/`) |

## See Also

- `hammerspoon/README.md` - Low-level Hammerspoon primitives documentation
- `vtb-gui --help` - Full command reference
- `crates/gui/` - GUI source code (React frontend + Tauri backend)
