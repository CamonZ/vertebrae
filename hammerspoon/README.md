# Hammerspoon GUI Automation Primitives

Lua module providing low-level GUI automation for the Vertebrae desktop app via [Hammerspoon](https://www.hammerspoon.org/).

## Setup

Add this to your `~/.hammerspoon/init.lua`:

```lua
vtb = dofile("/path/to/vertebrae/hammerspoon/vtb.lua")
```

Then reload Hammerspoon (`hs -c "hs.reload()"` or Cmd+Shift+R in the Hammerspoon console).

## Usage via CLI

All functions return JSON strings and can be invoked via `hs -c`:

### Window Management

```bash
# List windows for a specific application
hs -c 'vtb.list_windows("Vertebrae")'

# Find windows by title substring within an app (case-insensitive)
hs -c 'vtb.find_window("Settings", "Vertebrae")'

# Focus a window by ID
hs -c 'vtb.focus_window(12345)'

# Get the currently focused window
hs -c 'vtb.focused_window()'
```

### Mouse & Keyboard Input

```bash
# Click at screen coordinates
hs -c 'vtb.click_at(500, 300)'

# Right-click
hs -c 'vtb.right_click_at(500, 300)'

# Type text
hs -c 'vtb.type_text("hello world")'

# Press key combination (Cmd+S)
hs -c 'vtb.key_press({"cmd"}, "s")'

# Move mouse without clicking
hs -c 'vtb.move_mouse(500, 300)'

# Get current mouse position
hs -c 'vtb.mouse_position()'
```

### Screenshots

```bash
# Full screen screenshot (returns path to PNG)
hs -c 'vtb.screenshot()'

# Screenshot of a specific window by ID
hs -c 'vtb.screenshot_window(12345)'

# Screenshot by app name (captures first window)
hs -c 'vtb.screenshot_app("Vertebrae")'

# Screenshot by app name with title filter
hs -c 'vtb.screenshot_app("Vertebrae", "Settings")'
```

### UI Element Inspection

```bash
# Read accessibility tree for a window (default depth: 3)
hs -c 'vtb.read_ui_elements(12345)'

# With custom depth
hs -c 'vtb.read_ui_elements(12345, 5)'

# By app name (inspects first window)
hs -c 'vtb.read_ui_elements_for_app("Vertebrae", 3)'
```

## Return Format

All functions return JSON strings. Success responses include a `success: true` field. Error responses include an `error` field with a description.

## Design Notes

Window enumeration uses `hs.application.runningApplications()` with per-app window queries instead of `hs.window.allWindows()`. The latter can timeout when some applications are slow to respond to accessibility queries. For this reason, `list_windows` and `find_window` require an `app_name` parameter.

## Testing

```bash
# Run all tests (requires Hammerspoon running + visible windows)
./hammerspoon/test_vtb.sh

# Run basic tests only (no window dependency)
./hammerspoon/test_vtb.sh --basic
```
