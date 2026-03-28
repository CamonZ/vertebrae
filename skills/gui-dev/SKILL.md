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

## Step-by-Step Guide

### 1. Launch the Development App

Start the Tauri dev server and wait for the window to appear:

```bash
hammerspoon/bin/vtb-gui launch Vertebrae 60
```

Returns JSON with window info once the app is ready. If the app is already running, returns immediately with `"status": "already_running"`.

To just check if the app is already running without launching:

```bash
hammerspoon/bin/vtb-gui window list Vertebrae
```

If the app was started externally (e.g., from another terminal), wait for its window to appear:

```bash
hammerspoon/bin/vtb-gui wait-for-window Vertebrae 30
```

### 2. Make Code Changes

Edit React components in `crates/gui/src/` or Rust backend in `crates/gui/src-tauri/src/`. Vite hot reload picks up frontend changes automatically. Tauri rebuilds automatically for Rust backend changes (slower).

### 3. Wait for Hot Reload

After editing frontend files, wait 2-3 seconds for Vite hot reload. After editing Rust backend files, wait 10-15 seconds for Tauri rebuild.

### 4. Capture a Screenshot

Capture the app window by name (preferred -- finds and captures the first window):

```bash
hammerspoon/bin/vtb-gui screenshot-app Vertebrae
```

Returns JSON: `{"success": true, "path": "/tmp/vtb-screenshot-XXXXXX.png"}`

To capture a specific window by title substring (useful if the app has multiple windows):

```bash
hammerspoon/bin/vtb-gui screenshot-app Vertebrae "Settings"
```

Other screenshot variants:

```bash
# Full screen screenshot (captures entire display)
hammerspoon/bin/vtb-gui screenshot

# Screenshot a specific window by its numeric ID
hammerspoon/bin/vtb-gui screenshot-window 12345
```

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
hammerspoon/bin/vtb-gui screenshot-pipeline Vertebrae "click 500 300" "" 2
```

Or do it manually:

```bash
# 1. Capture "before" state
hammerspoon/bin/vtb-gui screenshot-app Vertebrae
# Note the path from the response

# 2. Make code changes and wait for reload

# 3. Capture "after" state
hammerspoon/bin/vtb-gui screenshot-app Vertebrae
# Note the path from the response

# 4. Compare the two screenshots
hammerspoon/bin/vtb-gui screenshot-diff /tmp/vtb-before.png /tmp/vtb-after.png
```

The diff returns a similarity score (0.0-1.0) and generates a visual diff image highlighting changed pixels in red.

## Cropping a Region

To focus analysis on a specific area of the UI:

```bash
hammerspoon/bin/vtb-gui screenshot-region /tmp/vtb-screenshot.png 100 200 400 300
```

Arguments: `<source_png> <x> <y> <width> <height>`

## Interacting with the UI

### Click and Type

```bash
# Click at screen coordinates
hammerspoon/bin/vtb-gui click 500 300

# Right-click
hammerspoon/bin/vtb-gui right-click 500 300

# Type text into the focused element
hammerspoon/bin/vtb-gui type "search query"

# Press a key combination (e.g., Cmd+S)
hammerspoon/bin/vtb-gui key-press s cmd

# Move mouse without clicking
hammerspoon/bin/vtb-gui move-mouse 500 300

# Get current mouse position
hammerspoon/bin/vtb-gui mouse-position
```

### Window Management

```bash
# List all windows for an app
hammerspoon/bin/vtb-gui window list Vertebrae

# Find windows by title substring
hammerspoon/bin/vtb-gui window find "Settings" Vertebrae

# Focus a window by ID
hammerspoon/bin/vtb-gui window focus 12345

# Get the currently focused window
hammerspoon/bin/vtb-gui window focused
```

### UI Element Inspection

Inspect the accessibility tree to find element positions for clicking:

```bash
# By app name (inspects first window, default depth 3)
hammerspoon/bin/vtb-gui ui-elements-app Vertebrae

# With custom depth for more detail
hammerspoon/bin/vtb-gui ui-elements-app Vertebrae 5

# By specific window ID
hammerspoon/bin/vtb-gui ui-elements 12345 3
```

Use the returned element positions (x, y, width, height) to calculate click coordinates.

## Typical GUI Ticket Workflow

When implementing a GUI ticket, follow this pattern:

```
1. vtb-gui launch Vertebrae 60          # Ensure app is running
2. vtb-gui screenshot-app Vertebrae     # Capture baseline state
3. Read the baseline screenshot         # Understand current appearance
4. Edit React/CSS files                 # Make the changes
5. Sleep 3 seconds                      # Wait for hot reload
6. vtb-gui screenshot-app Vertebrae     # Capture new state
7. Read the new screenshot              # Verify visual result
8. vtb-gui screenshot-diff <before> <after>  # Quantify changes
9. If not right, go to step 4           # Iterate until correct
```

## Output Format

All `vtb-gui` commands return JSON. Success responses include `"success": true`. Error responses include an `"error"` field. Screenshot commands return a `"path"` field with the absolute path to the PNG file.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `hs command not found` | Install Hammerspoon and enable the CLI tool |
| `no JSON output` | Check that `vtb.lua` is loaded in Hammerspoon's `init.lua` |
| App window not found | Verify the app name matches exactly (use `vtb-gui window list <name>`) |
| Screenshot is blank | Ensure Screen Recording permission is granted to Hammerspoon |
| Hot reload not working | Check Vite dev server is running (`npm run dev` in `crates/gui/`) |

## See Also

- `hammerspoon/README.md` - Low-level Hammerspoon primitives documentation
- `hammerspoon/bin/vtb-gui --help` - Full command reference
- `crates/gui/` - GUI source code (React frontend + Tauri backend)
