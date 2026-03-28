#!/usr/bin/env bash
#
# test_vtb_gui.sh - Integration tests for vtb-gui wrapper script
#
# Usage:
#   ./hammerspoon/bin/test_vtb_gui.sh              # Run all tests
#   ./hammerspoon/bin/test_vtb_gui.sh --basic       # Run tests that don't need Hammerspoon
#   ./hammerspoon/bin/test_vtb_gui.sh --live         # Run tests that require Hammerspoon + a visible window

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VTB_GUI="$SCRIPT_DIR/vtb-gui"

# Counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass() {
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "  ${GREEN}PASS${NC} %s\n" "$1"
}

fail() {
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "  ${RED}FAIL${NC} %s\n" "$1"
    if [ -n "${2:-}" ]; then
        printf "       %s\n" "$2"
    fi
}

run_test() {
    TESTS_RUN=$((TESTS_RUN + 1))
}

# ---------------------------------------------------------------------------
# Basic tests (no Hammerspoon required)
# ---------------------------------------------------------------------------
test_basic() {
    printf "\n${YELLOW}=== Basic Tests (no Hammerspoon required) ===${NC}\n\n"

    # Test: --help exits 0
    run_test
    local output
    output="$("$VTB_GUI" --help 2>&1)" && local exit_code=0 || local exit_code=$?
    if [ "$exit_code" -eq 0 ] && echo "$output" | grep -q "vtb-gui"; then
        pass "--help prints usage and exits 0"
    else
        fail "--help prints usage and exits 0" "exit_code=$exit_code"
    fi

    # Test: help subcommand exits 0
    run_test
    output="$("$VTB_GUI" help 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -eq 0 ] && echo "$output" | grep -q "Window Management"; then
        pass "help subcommand prints usage and exits 0"
    else
        fail "help subcommand prints usage and exits 0" "exit_code=$exit_code"
    fi

    # Test: no args shows help and exits 0
    run_test
    output="$("$VTB_GUI" 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -eq 0 ] && echo "$output" | grep -q "vtb-gui"; then
        pass "no arguments shows help and exits 0"
    else
        fail "no arguments shows help and exits 0" "exit_code=$exit_code"
    fi

    # Test: --help contains all subcommand categories
    run_test
    output="$("$VTB_GUI" --help 2>&1)"
    local all_found=true
    for section in "Window Management" "Mouse & Keyboard" "Screenshots" "UI Inspection" "App Lifecycle"; do
        if ! echo "$output" | grep -q "$section"; then
            all_found=false
            break
        fi
    done
    if [ "$all_found" = true ]; then
        pass "--help contains all subcommand categories"
    else
        fail "--help contains all subcommand categories" "missing section: $section"
    fi

    # Test: --help lists specific commands
    run_test
    local commands_found=true
    for cmd in "window list" "click" "right-click" "type" "key-press" "screenshot" "screenshot-app" "ui-elements" "launch" "wait-for-window" "mouse-position" "move-mouse"; do
        if ! echo "$output" | grep -q "$cmd"; then
            commands_found=false
            break
        fi
    done
    if [ "$commands_found" = true ]; then
        pass "--help lists all expected commands"
    else
        fail "--help lists all expected commands" "missing command: $cmd"
    fi

    # Test: unknown command returns JSON error and exits non-zero
    run_test
    output="$("$VTB_GUI" nonexistent-command 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d" 2>/dev/null; then
        pass "unknown command returns JSON error with non-zero exit"
    else
        fail "unknown command returns JSON error with non-zero exit" "exit=$exit_code output=$output"
    fi

    # Test: window with no subcommand returns JSON error
    run_test
    output="$("$VTB_GUI" window 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d" 2>/dev/null; then
        pass "window with no subcommand returns JSON error"
    else
        fail "window with no subcommand returns JSON error" "exit=$exit_code output=$output"
    fi

    # Test: window list with no app_name returns JSON error
    run_test
    output="$("$VTB_GUI" window list 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d; assert 'usage' in d['error']" 2>/dev/null; then
        pass "window list with no app_name returns usage JSON error"
    else
        fail "window list with no app_name returns usage JSON error" "exit=$exit_code output=$output"
    fi

    # Test: click with missing args returns JSON error
    run_test
    output="$("$VTB_GUI" click 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d" 2>/dev/null; then
        pass "click with missing args returns JSON error"
    else
        fail "click with missing args returns JSON error" "exit=$exit_code output=$output"
    fi

    # Test: click with only x returns JSON error
    run_test
    output="$("$VTB_GUI" click 100 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d" 2>/dev/null; then
        pass "click with only x coordinate returns JSON error"
    else
        fail "click with only x coordinate returns JSON error" "exit=$exit_code output=$output"
    fi

    # Test: type with no text returns JSON error
    run_test
    output="$("$VTB_GUI" type 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d" 2>/dev/null; then
        pass "type with no text returns JSON error"
    else
        fail "type with no text returns JSON error" "exit=$exit_code output=$output"
    fi

    # Test: screenshot-window with no id returns JSON error
    run_test
    output="$("$VTB_GUI" screenshot-window 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d" 2>/dev/null; then
        pass "screenshot-window with no id returns JSON error"
    else
        fail "screenshot-window with no id returns JSON error" "exit=$exit_code output=$output"
    fi

    # Test: screenshot-app with no app_name returns JSON error
    run_test
    output="$("$VTB_GUI" screenshot-app 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d" 2>/dev/null; then
        pass "screenshot-app with no app_name returns JSON error"
    else
        fail "screenshot-app with no app_name returns JSON error" "exit=$exit_code output=$output"
    fi

    # Test: ui-elements with no window_id returns JSON error
    run_test
    output="$("$VTB_GUI" ui-elements 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d" 2>/dev/null; then
        pass "ui-elements with no window_id returns JSON error"
    else
        fail "ui-elements with no window_id returns JSON error" "exit=$exit_code output=$output"
    fi

    # Test: ui-elements-app with no app_name returns JSON error
    run_test
    output="$("$VTB_GUI" ui-elements-app 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d" 2>/dev/null; then
        pass "ui-elements-app with no app_name returns JSON error"
    else
        fail "ui-elements-app with no app_name returns JSON error" "exit=$exit_code output=$output"
    fi

    # Test: key-press with no key returns JSON error
    run_test
    output="$("$VTB_GUI" key-press 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d" 2>/dev/null; then
        pass "key-press with no key returns JSON error"
    else
        fail "key-press with no key returns JSON error" "exit=$exit_code output=$output"
    fi

    # Test: right-click with missing args returns JSON error
    run_test
    output="$("$VTB_GUI" right-click 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d" 2>/dev/null; then
        pass "right-click with missing args returns JSON error"
    else
        fail "right-click with missing args returns JSON error" "exit=$exit_code output=$output"
    fi

    # Test: move-mouse with missing args returns JSON error
    run_test
    output="$("$VTB_GUI" move-mouse 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d" 2>/dev/null; then
        pass "move-mouse with missing args returns JSON error"
    else
        fail "move-mouse with missing args returns JSON error" "exit=$exit_code output=$output"
    fi

    # Test: window find with missing args returns JSON error
    run_test
    output="$("$VTB_GUI" window find 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d" 2>/dev/null; then
        pass "window find with missing args returns JSON error"
    else
        fail "window find with missing args returns JSON error" "exit=$exit_code output=$output"
    fi

    # Test: window focus with no window_id returns JSON error
    run_test
    output="$("$VTB_GUI" window focus 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d" 2>/dev/null; then
        pass "window focus with no window_id returns JSON error"
    else
        fail "window focus with no window_id returns JSON error" "exit=$exit_code output=$output"
    fi
}

# ---------------------------------------------------------------------------
# Tests with simulated missing hs
# ---------------------------------------------------------------------------
test_missing_hs() {
    printf "\n${YELLOW}=== Missing hs Tests ===${NC}\n\n"

    # Test: commands fail gracefully when hs is not on PATH
    run_test
    local output
    output="$(PATH=/usr/bin:/bin "$VTB_GUI" screenshot 2>&1)" && local exit_code=0 || local exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d; assert 'hs command not found' in d['error']" 2>/dev/null; then
        pass "screenshot returns JSON error when hs not on PATH"
    else
        fail "screenshot returns JSON error when hs not on PATH" "exit=$exit_code output=$output"
    fi

    run_test
    output="$(PATH=/usr/bin:/bin "$VTB_GUI" window list Vertebrae 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d; assert 'hs command not found' in d['error']" 2>/dev/null; then
        pass "window list returns JSON error when hs not on PATH"
    else
        fail "window list returns JSON error when hs not on PATH" "exit=$exit_code output=$output"
    fi

    run_test
    output="$(PATH=/usr/bin:/bin "$VTB_GUI" click 100 200 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d; assert 'hs command not found' in d['error']" 2>/dev/null; then
        pass "click returns JSON error when hs not on PATH"
    else
        fail "click returns JSON error when hs not on PATH" "exit=$exit_code output=$output"
    fi

    # help should still work without hs
    run_test
    output="$(PATH=/usr/bin:/bin "$VTB_GUI" --help 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -eq 0 ] && echo "$output" | grep -q "vtb-gui"; then
        pass "--help works even when hs is not on PATH"
    else
        fail "--help works even when hs is not on PATH" "exit=$exit_code"
    fi
}

# ---------------------------------------------------------------------------
# Live tests (require Hammerspoon running)
# ---------------------------------------------------------------------------
test_live() {
    printf "\n${YELLOW}=== Live Tests (require Hammerspoon) ===${NC}\n\n"

    if ! command -v hs &>/dev/null; then
        printf "  ${YELLOW}SKIP${NC} hs command not found, skipping live tests\n"
        return
    fi

    # Test: window list returns valid JSON array
    run_test
    local output
    output="$("$VTB_GUI" window list Finder 2>&1)" && local exit_code=0 || local exit_code=$?
    if [ "$exit_code" -eq 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert isinstance(d, list)" 2>/dev/null; then
        pass "window list Finder returns valid JSON array"
    else
        fail "window list Finder returns valid JSON array" "exit=$exit_code output=$output"
    fi

    # Test: mouse-position returns valid JSON with x and y
    run_test
    output="$("$VTB_GUI" mouse-position 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -eq 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'x' in d and 'y' in d" 2>/dev/null; then
        pass "mouse-position returns JSON with x and y"
    else
        fail "mouse-position returns JSON with x and y" "exit=$exit_code output=$output"
    fi

    # Test: screenshot returns valid JSON with path to PNG
    run_test
    output="$("$VTB_GUI" screenshot 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -eq 0 ]; then
        local path
        path="$(echo "$output" | python3 -c "import sys,json; print(json.load(sys.stdin).get('path',''))" 2>/dev/null)"
        if [ -n "$path" ] && [ -f "$path" ]; then
            pass "screenshot returns JSON with path to existing PNG file"
            rm -f "$path"
        else
            fail "screenshot returns JSON with path to existing PNG file" "path=$path"
        fi
    else
        fail "screenshot returns JSON with path to existing PNG file" "exit=$exit_code output=$output"
    fi

    # Test: focused window returns valid JSON
    run_test
    output="$("$VTB_GUI" window focused 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -eq 0 ] && echo "$output" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
        pass "window focused returns valid JSON"
    else
        fail "window focused returns valid JSON" "exit=$exit_code output=$output"
    fi

    # Test: click returns success JSON
    run_test
    output="$("$VTB_GUI" click 100 200 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -eq 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('success') == True" 2>/dev/null; then
        pass "click 100 200 returns JSON with success=true"
    else
        fail "click 100 200 returns JSON with success=true" "exit=$exit_code output=$output"
    fi

    # Test: move-mouse returns success JSON
    run_test
    output="$("$VTB_GUI" move-mouse 500 500 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -eq 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('success') == True; assert d['x'] == 500 and d['y'] == 500" 2>/dev/null; then
        pass "move-mouse 500 500 returns success with correct coordinates"
    else
        fail "move-mouse 500 500 returns success with correct coordinates" "exit=$exit_code output=$output"
    fi

    # Test: window list for non-existent app returns empty array
    run_test
    output="$("$VTB_GUI" window list NonExistentApp12345 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -eq 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d == []" 2>/dev/null; then
        pass "window list for non-existent app returns empty JSON array"
    else
        fail "window list for non-existent app returns empty JSON array" "exit=$exit_code output=$output"
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    local mode="${1:-all}"

    printf "\n${YELLOW}vtb-gui Integration Tests${NC}\n"
    printf "Script: %s\n" "$VTB_GUI"

    case "$mode" in
        --basic)
            test_basic
            test_missing_hs
            ;;
        --live)
            test_live
            ;;
        *)
            test_basic
            test_missing_hs
            test_live
            ;;
    esac

    printf "\n${YELLOW}Results: %d tests, ${GREEN}%d passed${NC}, ${RED}%d failed${NC}\n\n" \
        "$TESTS_RUN" "$TESTS_PASSED" "$TESTS_FAILED"

    if [ "$TESTS_FAILED" -gt 0 ]; then
        exit 1
    fi
}

main "$@"
