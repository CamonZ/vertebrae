"""
Hammerspoon MCP Server

Translates MCP tool calls into HTTP requests to the Hammerspoon HTTP server
(server.lua). Screenshots are returned as inline base64 images via MCP's
image content type, not as file paths.

Coordinate conversion is built into click tools: callers pass image coordinates
plus a window reference, and the server converts to screen coordinates using the
window's frame.

Worktree awareness: several Vertebrae dev builds can run at once (one per git
worktree), all named "gui". App-targeted tools pick the instance whose process
runs inside the requested worktree. The worktree defaults to the
VTB_GUI_WORKTREE environment variable, then to the checkout containing this
server's working directory; pass `worktree="installed"` for the bundled app.

Usage:
    python server.py                     # stdio transport (default)
    python server.py --port 19024        # custom Hammerspoon server port
"""

import argparse
import base64
import json
import os
import subprocess
import time

import httpx
from mcp.server.fastmcp import FastMCP, Image

HS_BASE_URL = "http://localhost:19024"

# Selects the bundled (installed) app rather than a dev build in a worktree.
INSTALLED = "installed"

mcp = FastMCP("hammerspoon-gui")

# ---------------------------------------------------------------------------
# HTTP transport to Hammerspoon server
# ---------------------------------------------------------------------------


_client: httpx.Client | None = None


def _get_client() -> httpx.Client:
    """Get or create the shared HTTP client (lazy init after arg parsing)."""
    global _client
    if _client is None:
        _client = httpx.Client(base_url=HS_BASE_URL, timeout=30.0)
    return _client


def _hs_get(path: str) -> dict:
    """Send a GET request to the Hammerspoon HTTP server."""
    resp = _get_client().get(path)
    resp.raise_for_status()
    return resp.json()


def _hs_post(path: str, body: dict | None = None) -> dict:
    """Send a POST request to the Hammerspoon HTTP server."""
    resp = _get_client().post(path, json=body or {})
    resp.raise_for_status()
    return resp.json()


def _png_image(result: dict) -> Image:
    """Build an MCP image from a Hammerspoon screenshot response.

    Hammerspoon returns base64 text; FastMCP's Image expects raw PNG bytes and
    base64-encodes them itself.
    """
    if "error" in result:
        raise ValueError(result["error"])
    return Image(data=base64.b64decode(result["image_base64"]), format="png")


# ---------------------------------------------------------------------------
# Instance resolution (which running app, in which worktree)
# ---------------------------------------------------------------------------


def _run(args: list[str]) -> str | None:
    """Run a short local command, returning stdout or None on failure."""
    try:
        out = subprocess.run(
            args, capture_output=True, text=True, timeout=3, check=True
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() or None


def _process_cwd(pid: int) -> str | None:
    """Working directory of a process (lsof field `n` of the cwd descriptor)."""
    out = _run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"])
    if not out:
        return None
    for line in out.splitlines():
        if line.startswith("n"):
            return line[1:]
    return None


def _checkout_root(path: str | None) -> str | None:
    """Top level of the git checkout (main repo or worktree) containing path."""
    if not path or not os.path.isdir(path):
        return None
    root = _run(["git", "-C", path, "rev-parse", "--show-toplevel"])
    return os.path.realpath(root) if root else None


def _instance_root(instance: dict) -> str | None:
    """Checkout an instance runs from, or None for the installed app.

    `tauri dev` starts the binary with its cwd inside the worktree's
    `crates/gui/src-tauri`, even when the binary itself was built into a
    shared CARGO_TARGET_DIR, so the cwd is the reliable signal. The executable
    path is the fallback for unbundled binaries started some other way.
    """
    root = _checkout_root(_process_cwd(instance["pid"]))
    if root:
        return root
    path = instance.get("path") or ""
    if path.endswith(".app"):
        return None
    return _checkout_root(os.path.dirname(path))


def _default_worktree() -> str | None:
    """The worktree to target when a tool call does not name one."""
    configured = os.environ.get("VTB_GUI_WORKTREE")
    if configured:
        return configured
    return _checkout_root(os.getcwd())


def _describe(instance: dict) -> str:
    root = instance.get("root") or INSTALLED
    return f"pid {instance['pid']} ({instance.get('name')}) -> {root}"


def select_instance(
    instances: list[dict], worktree: str | None, explicit: bool
) -> dict:
    """Pick the app instance for a worktree.

    `instances` carry a resolved `root` (None for the installed app). An
    explicit worktree must match. An implicit one (from the environment or the
    server's cwd) is a preference: with a single instance running, that
    instance is used even if it lives elsewhere. Ambiguity is an error rather
    than a guess, so a session never drives another worktree's app.
    """
    if not instances:
        raise ValueError("app is not running")
    if worktree == INSTALLED:
        matches = [i for i in instances if i.get("root") is None]
    elif worktree:
        target = os.path.realpath(os.path.expanduser(worktree))
        matches = [i for i in instances if i.get("root") == target]
    else:
        matches = []
    if matches:
        with_windows = [i for i in matches if i.get("windows")]
        return (with_windows or matches)[0]
    if not explicit and len(instances) == 1:
        return instances[0]
    running = "; ".join(_describe(i) for i in instances)
    wanted = worktree or "(no worktree detected)"
    raise ValueError(
        f"no instance running from {wanted}. Running: {running}. "
        "Pass worktree=<checkout path> or worktree='installed'."
    )


def _list_instances(app_name: str) -> list[dict]:
    result = _hs_post("/app/instances", {"app_name": app_name})
    if isinstance(result, dict) and "error" in result:
        raise ValueError(result["error"])
    instances = result if isinstance(result, list) else []
    for instance in instances:
        instance["root"] = _instance_root(instance)
    return instances


def _resolve_pid(app_name: str, worktree: str | None) -> int:
    """Resolve the pid of the app instance a tool call should act on."""
    explicit = worktree is not None
    target = worktree if explicit else _default_worktree()
    return select_instance(_list_instances(app_name), target, explicit)["pid"]


def _app_body(app_name: str, worktree: str | None) -> dict:
    """Request body selecting one app instance by name and pid."""
    return {"app_name": app_name, "pid": _resolve_pid(app_name, worktree)}


def _find_target_window(
    app_name: str, title: str | None = None, worktree: str | None = None
) -> dict:
    """Fetch window list and return the matching window info dict."""
    result = _hs_post("/window/list", _app_body(app_name, worktree))
    if isinstance(result, dict) and "error" in result:
        raise ValueError(result["error"])
    if not isinstance(result, list) or len(result) == 0:
        raise ValueError(f"no windows found for app: {app_name}")

    target = result[0]
    if title:
        pattern = title.lower()
        target = None
        for w in result:
            if pattern in w.get("title", "").lower():
                target = w
                break
        if target is None:
            raise ValueError(f"no window matching title: {title}")

    return target


def _image_to_screen_coords(
    image_x: int,
    image_y: int,
    app_name: str,
    title: str | None = None,
    worktree: str | None = None,
) -> tuple[int, int, int]:
    """Convert image coordinates to screen coordinates. Returns (screen_x, screen_y, window_id)."""
    target = _find_target_window(app_name, title, worktree)
    frame = target["frame"]
    return frame["x"] + image_x, frame["y"] + image_y, target["id"]


def _image_action(
    endpoint: str,
    image_x: int,
    image_y: int,
    app_name: str,
    title: str | None = None,
    worktree: str | None = None,
) -> str:
    """Perform a coordinate-converted action (click, right-click, move) and return result."""
    screen_x, screen_y, _ = _image_to_screen_coords(
        image_x, image_y, app_name, title, worktree
    )
    result = _hs_post(endpoint, {"x": screen_x, "y": screen_y})
    return json.dumps({
        "success": result.get("success", False),
        "image_coords": {"x": image_x, "y": image_y},
        "screen_coords": {"x": screen_x, "y": screen_y},
    }, indent=2)


# ---------------------------------------------------------------------------
# Window management tools
# ---------------------------------------------------------------------------


@mcp.tool()
def gui_instances(app_name: str = "gui") -> str:
    """List every running instance of an app with its pid, worktree and windows.

    Use this to see which worktree each Vertebrae dev build runs from before
    targeting one with the `worktree` argument of the other tools.

    Args:
        app_name: Application name; 'gui' and 'Vertebrae' both match Vertebrae
    """
    instances = _list_instances(app_name)
    target = _default_worktree()
    for instance in instances:
        instance["default_target"] = (
            instance["root"] is not None and instance["root"] == target
        )
    return json.dumps(instances, indent=2)


@mcp.tool()
def gui_window_list(app_name: str, worktree: str | None = None) -> str:
    """List all windows for an application. Returns window IDs, titles, and frames.

    The Vertebrae app is named 'gui' when run from `tauri dev` and 'Vertebrae'
    when installed as a bundle; either name matches whichever build is running.

    Args:
        app_name: Application process name (e.g., 'gui', 'Safari', 'Terminal')
        worktree: Checkout path whose dev build to target, or 'installed'
            (default: VTB_GUI_WORKTREE, then this session's checkout)
    """
    result = _hs_post("/window/list", _app_body(app_name, worktree))
    return json.dumps(result, indent=2)


@mcp.tool()
def gui_window_find(
    title: str, app_name: str, worktree: str | None = None
) -> str:
    """Find windows whose title contains the given substring (case-insensitive).

    Args:
        title: Substring to search for in window titles
        app_name: Application process name to search within
        worktree: Checkout path whose dev build to target, or 'installed'
            (default: VTB_GUI_WORKTREE, then this session's checkout)
    """
    body = {"title": title, **_app_body(app_name, worktree)}
    result = _hs_post("/window/find", body)
    return json.dumps(result, indent=2)


@mcp.tool()
def gui_window_focus(window_id: int) -> str:
    """Focus a specific window by its numeric ID.

    Args:
        window_id: Window ID (from gui_window_list)
    """
    result = _hs_post("/window/focus", {"window_id": window_id})
    return json.dumps(result, indent=2)


@mcp.tool()
def gui_window_focused() -> str:
    """Get information about the currently focused window."""
    result = _hs_get("/window/focused")
    return json.dumps(result, indent=2)


# ---------------------------------------------------------------------------
# Screenshot tools (return inline images)
# ---------------------------------------------------------------------------


@mcp.tool()
def gui_screenshot(
    app_name: str = "gui", title: str | None = None, worktree: str | None = None
) -> Image:
    """Take a screenshot of an application window. Returns the image directly.

    If no title is given, captures the first window of the app.

    Args:
        app_name: Application process name (default: 'gui')
        title: Optional window title substring to match
        worktree: Checkout path whose dev build to target, or 'installed'
            (default: VTB_GUI_WORKTREE, then this session's checkout)
    """
    body: dict = _app_body(app_name, worktree)
    if title:
        body["title"] = title
    result = _hs_post("/screenshot/app", body)
    return _png_image(result)


@mcp.tool()
def gui_screenshot_full() -> Image:
    """Take a screenshot of the entire screen. Returns the image directly."""
    result = _hs_get("/screenshot")
    return _png_image(result)


@mcp.tool()
def gui_screenshot_window(window_id: int) -> Image:
    """Take a screenshot of a specific window by ID. Returns the image directly.

    Args:
        window_id: Window ID (from gui_window_list)
    """
    result = _hs_post("/screenshot/window", {"window_id": window_id})
    return _png_image(result)


# ---------------------------------------------------------------------------
# Click tools (with built-in coordinate conversion)
# ---------------------------------------------------------------------------


@mcp.tool()
def gui_click(
    image_x: int,
    image_y: int,
    app_name: str = "gui",
    title: str | None = None,
    worktree: str | None = None,
) -> str:
    """Click at a position specified in image coordinates.

    Converts image coordinates to screen coordinates using the window frame,
    then performs the click. Image coordinates have (0,0) at the top-left of
    the window screenshot.

    Args:
        image_x: X coordinate in the screenshot image
        image_y: Y coordinate in the screenshot image
        app_name: Application process name (default: 'gui')
        title: Optional window title substring for coordinate conversion
        worktree: Checkout path whose dev build to target, or 'installed'
            (default: VTB_GUI_WORKTREE, then this session's checkout)
    """
    return _image_action(
        "/click", image_x, image_y, app_name, title, worktree
    )


@mcp.tool()
def gui_click_screen(x: int, y: int) -> str:
    """Click at absolute screen coordinates. Use gui_click instead when you have
    image coordinates from a screenshot.

    Args:
        x: Absolute screen X coordinate
        y: Absolute screen Y coordinate
    """
    result = _hs_post("/click", {"x": x, "y": y})
    return json.dumps(result, indent=2)


@mcp.tool()
def gui_right_click(
    image_x: int,
    image_y: int,
    app_name: str = "gui",
    title: str | None = None,
    worktree: str | None = None,
) -> str:
    """Right-click at a position specified in image coordinates.

    Args:
        image_x: X coordinate in the screenshot image
        image_y: Y coordinate in the screenshot image
        app_name: Application process name (default: 'gui')
        title: Optional window title substring for coordinate conversion
        worktree: Checkout path whose dev build to target, or 'installed'
            (default: VTB_GUI_WORKTREE, then this session's checkout)
    """
    return _image_action(
        "/right-click", image_x, image_y, app_name, title, worktree
    )


# ---------------------------------------------------------------------------
# Combined click-and-screenshot tool
# ---------------------------------------------------------------------------


@mcp.tool()
def gui_click_and_screenshot(
    image_x: int,
    image_y: int,
    app_name: str = "gui",
    title: str | None = None,
    delay_ms: int = 200,
    worktree: str | None = None,
) -> list:
    """Click at image coordinates and immediately capture a screenshot.

    Combines a click and screenshot into a single tool call, returning both the
    click result and the resulting screenshot. The brief delay between click and
    screenshot allows UI to update.

    Args:
        image_x: X coordinate in the screenshot image
        image_y: Y coordinate in the screenshot image
        app_name: Application process name (default: 'gui')
        title: Optional window title substring
        delay_ms: Milliseconds to wait between click and screenshot (default: 200)
        worktree: Checkout path whose dev build to target, or 'installed'
            (default: VTB_GUI_WORKTREE, then this session's checkout)
    """
    screen_x, screen_y, window_id = _image_to_screen_coords(
        image_x, image_y, app_name, title, worktree
    )
    click_result = _hs_post("/click", {"x": screen_x, "y": screen_y})

    time.sleep(delay_ms / 1000.0)

    screenshot = _png_image(_hs_post("/screenshot/window", {"window_id": window_id}))

    click_info = json.dumps(
        {
            "action": "click",
            "image_coords": {"x": image_x, "y": image_y},
            "screen_coords": {"x": screen_x, "y": screen_y},
            "success": click_result.get("success", False),
        }
    )

    return [click_info, screenshot]


# ---------------------------------------------------------------------------
# Keyboard tools
# ---------------------------------------------------------------------------


@mcp.tool()
def gui_type(text: str) -> str:
    """Type text using simulated keystrokes into the currently focused element.

    Args:
        text: The text to type
    """
    result = _hs_post("/type", {"text": text})
    return json.dumps(result, indent=2)


@mcp.tool()
def gui_key_press(key: str, modifiers: list[str] | None = None) -> str:
    """Press a key combination.

    Args:
        key: The key to press (e.g., 's', 'return', 'escape', 'tab')
        modifiers: Optional list of modifiers (e.g., ['cmd'], ['cmd', 'shift'])
    """
    result = _hs_post("/key-press", {"key": key, "modifiers": modifiers or []})
    return json.dumps(result, indent=2)


# ---------------------------------------------------------------------------
# Mouse tools
# ---------------------------------------------------------------------------


@mcp.tool()
def gui_mouse_position() -> str:
    """Get the current mouse cursor position in screen coordinates."""
    result = _hs_get("/mouse/position")
    return json.dumps(result, indent=2)


@mcp.tool()
def gui_move_mouse(
    image_x: int,
    image_y: int,
    app_name: str = "gui",
    title: str | None = None,
    worktree: str | None = None,
) -> str:
    """Move the mouse to a position specified in image coordinates (no click).

    Args:
        image_x: X coordinate in the screenshot image
        image_y: Y coordinate in the screenshot image
        app_name: Application process name (default: 'gui')
        title: Optional window title substring for coordinate conversion
        worktree: Checkout path whose dev build to target, or 'installed'
            (default: VTB_GUI_WORKTREE, then this session's checkout)
    """
    return _image_action(
        "/mouse/move", image_x, image_y, app_name, title, worktree
    )


# ---------------------------------------------------------------------------
# UI inspection tools
# ---------------------------------------------------------------------------


@mcp.tool()
def gui_ui_elements(window_id: int, max_depth: int = 3) -> str:
    """Read the accessibility element tree for a window.

    Returns the UI element hierarchy including roles, titles, values, and
    positions. Useful for finding specific UI elements to interact with.

    Args:
        window_id: Window ID (from gui_window_list)
        max_depth: How deep to traverse the element tree (default: 3)
    """
    result = _hs_post(
        "/ui-elements", {"window_id": window_id, "max_depth": max_depth}
    )
    return json.dumps(result, indent=2)


@mcp.tool()
def gui_ui_elements_app(
    app_name: str, max_depth: int = 3, worktree: str | None = None
) -> str:
    """Read the accessibility element tree for the first window of an app.

    Args:
        app_name: Application process name
        max_depth: How deep to traverse the element tree (default: 3)
        worktree: Checkout path whose dev build to target, or 'installed'
            (default: VTB_GUI_WORKTREE, then this session's checkout)
    """
    body = {"max_depth": max_depth, **_app_body(app_name, worktree)}
    result = _hs_post("/ui-elements/app", body)
    return json.dumps(result, indent=2)


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------


@mcp.tool()
def gui_health() -> str:
    """Check if the Hammerspoon HTTP server is running and reachable."""
    try:
        result = _hs_get("/health")
        return json.dumps(result, indent=2)
    except Exception as e:
        return f"Hammerspoon server not reachable: {e}"


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hammerspoon MCP Server")
    parser.add_argument(
        "--port",
        type=int,
        default=19024,
        help="Port of the Hammerspoon HTTP server (default: 19024)",
    )
    args = parser.parse_args()
    HS_BASE_URL = f"http://localhost:{args.port}"
    mcp.run(transport="stdio")
