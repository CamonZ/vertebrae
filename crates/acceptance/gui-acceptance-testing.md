# GUI Acceptance Testing: Evaluation

This document evaluates two approaches for GUI acceptance testing of the Vertebrae Tauri desktop application.

## Option 1: tauri-driver + WebDriverIO

**How it works:** Tauri provides `tauri-driver`, a WebDriver-compatible server that wraps the native WebView. WebDriverIO connects to it and drives the GUI via the W3C WebDriver protocol (clicks, text input, element assertions).

### Pros

- **Official Tauri integration** -- `tauri-driver` is maintained by the Tauri team and designed for this exact use case.
- **Industry-standard protocol** -- WebDriver is well-documented with large community support. Tests written with WebDriverIO transfer to other frameworks (Selenium, Playwright) if needed.
- **Rich assertion library** -- WebDriverIO provides element selectors, waits, text/attribute assertions out of the box.
- **Cross-platform** -- Works on Linux, macOS, and Windows. Can run headless on Linux CI via `xvfb`.
- **Can test the full Tauri app** -- Builds a real release binary and interacts with the actual app window, including IPC between React frontend and Rust backend.

### Cons

- **Heavyweight setup** -- Requires Node.js, WebDriverIO, and the tauri-driver binary. CI needs `xvfb` on Linux and a display server.
- **Slow test execution** -- Each test scenario launches the full app, which includes Tauri startup, React hydration, and backend initialization.
- **Platform-specific WebDriver backends** -- Linux uses `WebKitWebDriver` (WebKitGTK), macOS uses `safaridriver`. Behavior can differ between platforms.
- **macOS CI limitations** -- GitHub Actions macOS runners have limited display support. `safaridriver` requires enabling "Allow Remote Automation" in Safari preferences, which is problematic in CI.
- **Fragile selectors** -- Tests depend on DOM structure. React component refactors can break tests without changing behavior.
- **No HVF requirement** -- This approach does NOT require Hypervisor.framework, so it works on the user's Hackintosh.

### CI Compatibility

- **Linux (GitHub Actions):** Works with `xvfb-run` and `WebKitWebDriver`. Requires `libwebkit2gtk-4.1-dev`.
- **macOS (GitHub Actions):** Possible but requires `safaridriver --enable` and display configuration. Less reliable.
- **Windows:** Supported via Microsoft Edge WebDriver.

---

## Option 2: Hammerspoon (macOS only)

**How it works:** Hammerspoon is a macOS automation tool using Lua scripting. It can detect windows, send keystrokes/mouse events, and take screenshots via the macOS Accessibility API.

### Pros

- **OS-level interaction** -- Tests the actual rendered app as a user would see it, including native window chrome, system dialogs, and accessibility features.
- **Independent of implementation** -- Does not depend on DOM structure, WebDriver, or any framework-specific tooling. Works with any GUI app.
- **Screenshot-based verification** -- Can capture screenshots and compare against references for visual regression testing.
- **Lightweight scripting** -- Lua scripts are simple and don't require a heavy test framework.

### Cons

- **macOS only** -- Hammerspoon is exclusively a macOS tool. Cannot run on Linux or Windows, making it unusable for Linux-based CI runners.
- **No GitHub Actions support** -- GitHub Actions macOS runners don't have Hammerspoon installed, and installing it requires Accessibility permissions that can't be granted in CI.
- **Brittle** -- Screen coordinates and window positioning vary by display resolution, dark mode settings, and macOS version. Tests break when the system appearance changes.
- **No semantic assertions** -- Cannot assert on element text or state directly. Must rely on screenshot comparison or pixel matching, which is fragile.
- **Manual setup** -- Requires Hammerspoon to be installed and configured on each developer machine. No `cargo test` integration.
- **HVF irrelevant** -- Hammerspoon does not use Hypervisor.framework, but its macOS-only nature is a bigger limitation.

### CI Compatibility

- **Linux:** Not supported.
- **macOS (GitHub Actions):** Not practical -- requires Accessibility permissions.
- **Windows:** Not supported.

---

## Recommendation

**Use tauri-driver + WebDriverIO** for GUI acceptance testing.

### Rationale

1. **Cross-platform CI** -- The primary goal of acceptance tests is to run in CI. Hammerspoon is macOS-only and cannot run on GitHub Actions, making it unsuitable for automated PR checks.

2. **Tauri ecosystem alignment** -- `tauri-driver` is the officially recommended approach from the Tauri project. It will continue to be maintained and compatible with future Tauri versions.

3. **Semantic testing** -- WebDriverIO can assert on element text, attributes, and state, providing meaningful test failures ("expected title to be X but got Y") rather than pixel comparison.

4. **Existing infrastructure** -- The project already uses Node.js for the GUI (React, Vite, Vitest). Adding WebDriverIO is incremental.

### Suggested Implementation Plan

1. Install WebDriverIO as a dev dependency in `crates/gui/`.
2. Create a `crates/gui/tests/e2e/` directory for Gherkin feature files and step definitions.
3. Configure WebDriverIO to launch `tauri-driver` and the built Tauri app.
4. Write GUI scenarios that test the most critical user flows (project selection, task creation, workflow execution).
5. Add a CI job that builds the Tauri app, starts Sacrum, and runs the GUI acceptance tests with `xvfb-run` on Linux.
