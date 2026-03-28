#!/usr/bin/env bash
#
# Integration tests for vtb.lua Hammerspoon automation primitives.
#
# Usage:
#   ./hammerspoon/test_vtb.sh          # Run all tests (some require open windows)
#   ./hammerspoon/test_vtb.sh --basic  # Run only tests that don't require specific windows
#
# Prerequisites:
#   - Hammerspoon must be running
#   - hs CLI must be on PATH
#   - For full tests: at least one visible window must be open

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VTB_LUA="$SCRIPT_DIR/vtb.lua"

PASS=0
FAIL=0
SKIP=0
BASIC_ONLY=false

if [[ "${1:-}" == "--basic" ]]; then
    BASIC_ONLY=true
fi

# Helper: run a Lua expression via hs with vtb loaded.
# Strips Hammerspoon extension-loading messages (lines starting with "-- ")
# that are printed to stdout the first time a module is loaded.
run_hs() {
    hs -c "vtb = dofile('$VTB_LUA'); $1" 2>/dev/null | grep -v '^-- '
}

pass() {
    PASS=$((PASS + 1))
    echo "  PASS: $1"
}

fail() {
    FAIL=$((FAIL + 1))
    echo "  FAIL: $1"
    if [[ -n "${2:-}" ]]; then
        echo "        Output: $2"
    fi
}

skip() {
    SKIP=$((SKIP + 1))
    echo "  SKIP: $1"
}

# Helper: check if output is valid JSON
is_json() {
    echo "$1" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null
}

# Helper: check if JSON has an error field
has_error() {
    echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'error' in d else 'no')" 2>/dev/null || echo "parse_error"
}

# ---------------------------------------------------------------------------
# Test: Module loads without error
# ---------------------------------------------------------------------------
echo "=== Module Loading ==="

output=$(run_hs "return type(vtb)")
if [[ "$output" == "table" ]]; then
    pass "vtb module loads as a table"
else
    fail "vtb module loads as a table" "$output"
fi

for fn in list_windows find_window focus_window focused_window click_at right_click_at type_text key_press screenshot screenshot_window screenshot_app read_ui_elements read_ui_elements_for_app mouse_position move_mouse; do
    output=$(run_hs "return type(vtb.$fn)")
    if [[ "$output" == "function" ]]; then
        pass "vtb.$fn is a function"
    else
        fail "vtb.$fn is a function" "got: $output"
    fi
done

# ---------------------------------------------------------------------------
# Test: list_windows requires app_name
# ---------------------------------------------------------------------------
echo ""
echo "=== Window Listing ==="

output=$(run_hs 'return vtb.list_windows("")')
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "list_windows with empty string returns error"
else
    fail "list_windows with empty string returns error" "$output"
fi

output=$(run_hs "return vtb.list_windows(nil)")
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "list_windows with nil returns error"
else
    fail "list_windows with nil returns error" "$output"
fi

# List Finder windows (Finder is always running on macOS)
output=$(run_hs 'return vtb.list_windows("Finder")')
if is_json "$output"; then
    pass "list_windows('Finder') returns valid JSON"
else
    fail "list_windows('Finder') returns valid JSON" "$output"
fi

window_count=$(echo "$output" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
if [[ "$window_count" -gt 0 ]]; then
    pass "list_windows('Finder') found $window_count windows"

    has_fields=$(echo "$output" | python3 -c "
import sys, json
windows = json.load(sys.stdin)
w = windows[0]
required = ['id', 'title', 'app', 'frame']
missing = [f for f in required if f not in w]
frame_fields = ['x', 'y', 'w', 'h']
if 'frame' in w:
    missing += ['frame.' + f for f in frame_fields if f not in w['frame']]
print(','.join(missing) if missing else 'ok')
" 2>/dev/null || echo "parse_error")

    if [[ "$has_fields" == "ok" ]]; then
        pass "window objects have required fields (id, title, app, frame{x,y,w,h})"
    else
        fail "window objects have required fields" "missing: $has_fields"
    fi
else
    skip "no Finder windows visible to verify structure"
fi

# Nonexistent app returns empty array
output=$(run_hs 'return vtb.list_windows("NonExistentApp12345")')
count=$(echo "$output" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "error")
if [[ "$count" == "0" ]]; then
    pass "list_windows with nonexistent app returns empty array"
else
    fail "list_windows with nonexistent app returns empty array" "count=$count"
fi

# ---------------------------------------------------------------------------
# Test: find_window
# ---------------------------------------------------------------------------
echo ""
echo "=== Window Finding ==="

output=$(run_hs 'return vtb.find_window("")')
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "find_window with empty title returns error"
else
    fail "find_window with empty title returns error" "$output"
fi

output=$(run_hs "return vtb.find_window(nil)")
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "find_window with nil title returns error"
else
    fail "find_window with nil title returns error" "$output"
fi

output=$(run_hs 'return vtb.find_window("test", "")')
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "find_window with empty app_name returns error"
else
    fail "find_window with empty app_name returns error" "$output"
fi

output=$(run_hs 'return vtb.find_window("zzzz_nonexistent_window_xyz_12345", "Finder")')
count=$(echo "$output" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "error")
if [[ "$count" == "0" ]]; then
    pass "find_window with nonexistent title returns empty array"
else
    fail "find_window with nonexistent title returns empty array" "count=$count"
fi

# ---------------------------------------------------------------------------
# Test: focus_window error cases
# ---------------------------------------------------------------------------
echo ""
echo "=== Window Focusing ==="

output=$(run_hs "return vtb.focus_window(nil)")
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "focus_window with nil returns error"
else
    fail "focus_window with nil returns error" "$output"
fi

output=$(run_hs "return vtb.focus_window(999999999)")
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "focus_window with invalid ID returns error"
else
    fail "focus_window with invalid ID returns error" "$output"
fi

# focused_window
output=$(run_hs "return vtb.focused_window()")
if is_json "$output"; then
    pass "focused_window returns valid JSON"
    has_id=$(echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'id' in d and isinstance(d['id'], int) else 'no')" 2>/dev/null || echo "no")
    if [[ "$has_id" == "yes" ]]; then
        pass "focused_window returns a window with numeric id"
    else
        # Might be an error if no window is focused
        if [[ "$(has_error "$output")" == "yes" ]]; then
            skip "no focused window available"
        else
            fail "focused_window returns a window with numeric id" "$output"
        fi
    fi
else
    fail "focused_window returns valid JSON" "$output"
fi

# ---------------------------------------------------------------------------
# Test: Input error cases
# ---------------------------------------------------------------------------
echo ""
echo "=== Input Functions ==="

output=$(run_hs "return vtb.click_at(nil, nil)")
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "click_at with nil coordinates returns error"
else
    fail "click_at with nil coordinates returns error" "$output"
fi

output=$(run_hs "return vtb.right_click_at(nil, nil)")
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "right_click_at with nil coordinates returns error"
else
    fail "right_click_at with nil coordinates returns error" "$output"
fi

output=$(run_hs 'return vtb.type_text("")')
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "type_text with empty string returns error"
else
    fail "type_text with empty string returns error" "$output"
fi

output=$(run_hs "return vtb.type_text(nil)")
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "type_text with nil returns error"
else
    fail "type_text with nil returns error" "$output"
fi

output=$(run_hs "return vtb.key_press(nil, nil)")
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "key_press with nil key returns error"
else
    fail "key_press with nil key returns error" "$output"
fi

output=$(run_hs "return vtb.move_mouse(nil, nil)")
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "move_mouse with nil coordinates returns error"
else
    fail "move_mouse with nil coordinates returns error" "$output"
fi

# ---------------------------------------------------------------------------
# Test: Screenshot of full screen
# ---------------------------------------------------------------------------
echo ""
echo "=== Screenshot ==="

output=$(run_hs "return vtb.screenshot()")
if is_json "$output"; then
    pass "screenshot returns valid JSON"
else
    fail "screenshot returns valid JSON" "$output"
fi

screenshot_path=$(echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('path',''))" 2>/dev/null || echo "")
if [[ -n "$screenshot_path" && -f "$screenshot_path" ]]; then
    pass "screenshot file exists at: $screenshot_path"

    file_type=$(file -b "$screenshot_path" 2>/dev/null || echo "unknown")
    if echo "$file_type" | grep -qi "png"; then
        pass "screenshot file is a valid PNG image"
    else
        fail "screenshot file is a valid PNG image" "file type: $file_type"
    fi

    rm -f "$screenshot_path"
else
    fail "screenshot file exists" "path=$screenshot_path"
fi

# ---------------------------------------------------------------------------
# Test: Screenshot window error cases
# ---------------------------------------------------------------------------
output=$(run_hs "return vtb.screenshot_window(nil)")
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "screenshot_window with nil returns error"
else
    fail "screenshot_window with nil returns error" "$output"
fi

output=$(run_hs "return vtb.screenshot_window(999999999)")
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "screenshot_window with invalid ID returns error"
else
    fail "screenshot_window with invalid ID returns error" "$output"
fi

# screenshot_app error cases
output=$(run_hs 'return vtb.screenshot_app("")')
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "screenshot_app with empty string returns error"
else
    fail "screenshot_app with empty string returns error" "$output"
fi

output=$(run_hs 'return vtb.screenshot_app("NonExistentApp12345")')
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "screenshot_app with nonexistent app returns error"
else
    fail "screenshot_app with nonexistent app returns error" "$output"
fi

# ---------------------------------------------------------------------------
# Test: UI element reading error cases
# ---------------------------------------------------------------------------
echo ""
echo "=== UI Element Inspection ==="

output=$(run_hs "return vtb.read_ui_elements(nil)")
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "read_ui_elements with nil returns error"
else
    fail "read_ui_elements with nil returns error" "$output"
fi

output=$(run_hs "return vtb.read_ui_elements(999999999)")
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "read_ui_elements with invalid ID returns error"
else
    fail "read_ui_elements with invalid ID returns error" "$output"
fi

output=$(run_hs 'return vtb.read_ui_elements_for_app("")')
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "read_ui_elements_for_app with empty string returns error"
else
    fail "read_ui_elements_for_app with empty string returns error" "$output"
fi

output=$(run_hs 'return vtb.read_ui_elements_for_app("NonExistentApp12345")')
if [[ "$(has_error "$output")" == "yes" ]]; then
    pass "read_ui_elements_for_app with nonexistent app returns error"
else
    fail "read_ui_elements_for_app with nonexistent app returns error" "$output"
fi

# ---------------------------------------------------------------------------
# Test: Mouse position utility
# ---------------------------------------------------------------------------
echo ""
echo "=== Utility Functions ==="

output=$(run_hs "return vtb.mouse_position()")
if is_json "$output"; then
    pass "mouse_position returns valid JSON"
else
    fail "mouse_position returns valid JSON" "$output"
fi

has_coords=$(echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'x' in d and 'y' in d and isinstance(d['x'], (int, float)) and isinstance(d['y'], (int, float)):
    print('yes')
else:
    print('no')
" 2>/dev/null || echo "parse_error")
if [[ "$has_coords" == "yes" ]]; then
    pass "mouse_position returns x and y as numbers"
else
    fail "mouse_position returns x and y as numbers" "$output"
fi

# ---------------------------------------------------------------------------
# Test: move_mouse + mouse_position roundtrip
# ---------------------------------------------------------------------------
output=$(run_hs "vtb.move_mouse(100, 200); return vtb.mouse_position()")
roundtrip_ok=$(echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
# Allow 1px tolerance for rounding
if abs(d['x'] - 100) <= 1 and abs(d['y'] - 200) <= 1:
    print('yes')
else:
    print('no: x=%s y=%s' % (d['x'], d['y']))
" 2>/dev/null || echo "parse_error")
if [[ "$roundtrip_ok" == "yes" ]]; then
    pass "move_mouse(100, 200) then mouse_position returns ~(100, 200)"
else
    fail "move_mouse roundtrip" "$roundtrip_ok"
fi

# ---------------------------------------------------------------------------
# Tests requiring a real window (skipped with --basic)
# ---------------------------------------------------------------------------
if [[ "$BASIC_ONLY" == "true" ]]; then
    echo ""
    echo "=== Skipping window-dependent tests (--basic mode) ==="
    skip "focus_window with real window"
    skip "screenshot_window with real window"
    skip "screenshot_app with real window"
    skip "read_ui_elements with real window"
    skip "find_window with real window"
else
    echo ""
    echo "=== Window-dependent Tests (using Finder) ==="

    # Use Finder which is always running on macOS
    output=$(run_hs 'return vtb.list_windows("Finder")')
    finder_windows=$(echo "$output" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

    if [[ "$finder_windows" -gt 0 ]]; then
        win_id=$(echo "$output" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])" 2>/dev/null)
        win_title=$(echo "$output" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['title'])" 2>/dev/null)
        echo "  Using Finder window: id=$win_id title='$win_title'"

        # Focus window
        output=$(run_hs "return vtb.focus_window($win_id)")
        is_success=$(echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('success') else 'no')" 2>/dev/null || echo "no")
        if [[ "$is_success" == "yes" ]]; then
            pass "focus_window succeeds with real Finder window ID ($win_id)"
        else
            fail "focus_window with real window" "$output"
        fi

        # Find window by title substring
        if [[ -n "$win_title" && ${#win_title} -ge 3 ]]; then
            search_term=$(echo "$win_title" | cut -c1-5)
            output=$(run_hs "return vtb.find_window('$search_term', 'Finder')")
            found_count=$(echo "$output" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
            if [[ "$found_count" -gt 0 ]]; then
                pass "find_window('$search_term', 'Finder') found $found_count window(s)"
            else
                fail "find_window with real title substring" "found 0 windows for '$search_term'"
            fi
        fi

        # Screenshot window
        output=$(run_hs "return vtb.screenshot_window($win_id)")
        screenshot_path=$(echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('path',''))" 2>/dev/null || echo "")
        if [[ -n "$screenshot_path" && -f "$screenshot_path" ]]; then
            file_type=$(file -b "$screenshot_path" 2>/dev/null || echo "unknown")
            if echo "$file_type" | grep -qi "png"; then
                pass "screenshot_window produces a valid PNG file"
            else
                fail "screenshot_window produces a valid PNG" "file type: $file_type"
            fi
            rm -f "$screenshot_path"
        else
            fail "screenshot_window produces a file" "path=$screenshot_path, output=$output"
        fi

        # Screenshot app
        output=$(run_hs 'return vtb.screenshot_app("Finder")')
        screenshot_path=$(echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('path',''))" 2>/dev/null || echo "")
        if [[ -n "$screenshot_path" && -f "$screenshot_path" ]]; then
            file_type=$(file -b "$screenshot_path" 2>/dev/null || echo "unknown")
            if echo "$file_type" | grep -qi "png"; then
                pass "screenshot_app('Finder') produces a valid PNG file"
            else
                fail "screenshot_app produces a valid PNG" "file type: $file_type"
            fi
            rm -f "$screenshot_path"
        else
            fail "screenshot_app produces a file" "path=$screenshot_path, output=$output"
        fi

        # Read UI elements
        output=$(run_hs "return vtb.read_ui_elements($win_id, 2)")
        is_success=$(echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('success') else 'no')" 2>/dev/null || echo "no")
        if [[ "$is_success" == "yes" ]]; then
            has_elements=$(echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
e = d.get('elements', {})
has_role = 'role' in e
print('yes' if has_role else 'no')
" 2>/dev/null || echo "no")
            if [[ "$has_elements" == "yes" ]]; then
                pass "read_ui_elements returns element tree with role field"
            else
                fail "read_ui_elements tree structure" "$output"
            fi
        else
            fail "read_ui_elements with real window" "$output"
        fi

        # Read UI elements for app
        output=$(run_hs 'return vtb.read_ui_elements_for_app("Finder", 2)')
        is_success=$(echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('success') else 'no')" 2>/dev/null || echo "no")
        if [[ "$is_success" == "yes" ]]; then
            pass "read_ui_elements_for_app('Finder') returns success"
        else
            fail "read_ui_elements_for_app with Finder" "$output"
        fi
    else
        skip "no visible Finder windows for window-dependent tests"
    fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "============================================================"
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
echo "============================================================"

if [[ $FAIL -gt 0 ]]; then
    exit 1
fi
