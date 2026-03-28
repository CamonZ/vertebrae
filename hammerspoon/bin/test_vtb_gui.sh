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

    # Test: screenshot-region with no args returns JSON error
    run_test
    output="$("$VTB_GUI" screenshot-region 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d; assert 'usage' in d['error']" 2>/dev/null; then
        pass "screenshot-region with no args returns usage JSON error"
    else
        fail "screenshot-region with no args returns usage JSON error" "exit=$exit_code output=$output"
    fi

    # Test: screenshot-region with nonexistent file returns JSON error
    run_test
    output="$("$VTB_GUI" screenshot-region /tmp/nonexistent_img_12345.png 0 0 10 10 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d; assert 'not found' in d['error']" 2>/dev/null; then
        pass "screenshot-region with nonexistent file returns JSON error"
    else
        fail "screenshot-region with nonexistent file returns JSON error" "exit=$exit_code output=$output"
    fi

    # Test: screenshot-diff with no args returns JSON error
    run_test
    output="$("$VTB_GUI" screenshot-diff 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d; assert 'usage' in d['error']" 2>/dev/null; then
        pass "screenshot-diff with no args returns usage JSON error"
    else
        fail "screenshot-diff with no args returns usage JSON error" "exit=$exit_code output=$output"
    fi

    # Test: screenshot-pipeline with no args returns JSON error
    run_test
    output="$("$VTB_GUI" screenshot-pipeline 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d; assert 'usage' in d['error']" 2>/dev/null; then
        pass "screenshot-pipeline with no args returns usage JSON error"
    else
        fail "screenshot-pipeline with no args returns usage JSON error" "exit=$exit_code output=$output"
    fi

    # Test: --help lists new screenshot commands
    run_test
    output="$("$VTB_GUI" --help 2>&1)"
    local new_cmds_found=true
    for cmd in "screenshot-region" "screenshot-diff" "screenshot-pipeline"; do
        if ! echo "$output" | grep -q "$cmd"; then
            new_cmds_found=false
            break
        fi
    done
    if [ "$new_cmds_found" = true ]; then
        pass "--help lists screenshot-region, screenshot-diff, screenshot-pipeline"
    else
        fail "--help lists screenshot-region, screenshot-diff, screenshot-pipeline" "missing: $cmd"
    fi
}

# ---------------------------------------------------------------------------
# Image processing tests (no Hammerspoon required, tests actual image ops)
# ---------------------------------------------------------------------------
test_image_processing() {
    printf "\n${YELLOW}=== Image Processing Tests (no Hammerspoon required) ===${NC}\n\n"

    local img_diff="$SCRIPT_DIR/vtb-img-diff"

    # Create test images
    local test_dir
    test_dir="$(mktemp -d /tmp/vtb-img-test-XXXXXX)"
    python3 -c "
from PIL import Image
# 100x100 solid red
img = Image.new('RGB', (100, 100), (255, 0, 0))
img.save('$test_dir/red.png')
# 100x100 red with 20x20 blue square at (30,30)
img2 = img.copy()
for x in range(30, 50):
    for y in range(30, 50):
        img2.putpixel((x, y), (0, 0, 255))
img2.save('$test_dir/red_blue.png')
# 100x100 solid green
img3 = Image.new('RGB', (100, 100), (0, 255, 0))
img3.save('$test_dir/green.png')
# 200x100 wide image
img4 = Image.new('RGB', (200, 100), (128, 128, 128))
img4.save('$test_dir/wide.png')
"

    # Test: vtb-img-diff crop produces correct output dimensions
    run_test
    local output
    output="$("$img_diff" crop "$test_dir/red.png" "$test_dir/cropped.png" 10 10 30 40 2>&1)" && local exit_code=0 || local exit_code=$?
    if [ "$exit_code" -eq 0 ] && echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['success'] == True
assert d['region']['x'] == 10
assert d['region']['y'] == 10
assert d['region']['w'] == 30
assert d['region']['h'] == 40
assert d['source_size']['w'] == 100
assert d['source_size']['h'] == 100
" 2>/dev/null; then
        pass "vtb-img-diff crop returns correct JSON with region and source_size"
    else
        fail "vtb-img-diff crop returns correct JSON with region and source_size" "output=$output"
    fi

    # Test: cropped image has correct pixel dimensions
    run_test
    local crop_size
    crop_size="$(python3 -c "from PIL import Image; img=Image.open('$test_dir/cropped.png'); print(f'{img.size[0]}x{img.size[1]}')")"
    if [ "$crop_size" = "30x40" ]; then
        pass "cropped image has correct dimensions (30x40)"
    else
        fail "cropped image has correct dimensions (30x40)" "got=$crop_size"
    fi

    # Test: vtb-img-diff crop rejects out-of-bounds region
    run_test
    output="$("$img_diff" crop "$test_dir/red.png" "$test_dir/bad_crop.png" 90 90 20 20 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d; assert 'exceeds' in d['error']" 2>/dev/null; then
        pass "vtb-img-diff crop rejects out-of-bounds region with error"
    else
        fail "vtb-img-diff crop rejects out-of-bounds region with error" "exit=$exit_code output=$output"
    fi

    # Test: diff of identical images returns similarity 1.0
    run_test
    output="$("$img_diff" diff "$test_dir/red.png" "$test_dir/red.png" 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -eq 0 ] && echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['success'] == True
assert d['similarity'] == 1.0
assert d['changed_pixels'] == 0
assert d['mean_diff'] == 0.0
assert d['size_match'] == True
" 2>/dev/null; then
        pass "diff of identical images returns similarity=1.0, changed_pixels=0"
    else
        fail "diff of identical images returns similarity=1.0, changed_pixels=0" "output=$output"
    fi

    # Test: diff of red vs red+blue returns correct changed pixel count
    run_test
    output="$("$img_diff" diff "$test_dir/red.png" "$test_dir/red_blue.png" 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -eq 0 ] && echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['success'] == True
assert d['changed_pixels'] == 400, f\"expected 400, got {d['changed_pixels']}\"
assert d['total_pixels'] == 10000
assert 0.9 < d['similarity'] < 1.0
assert d['similarity'] == 0.96
" 2>/dev/null; then
        pass "diff of red vs red+blue detects exactly 400 changed pixels (similarity=0.96)"
    else
        fail "diff of red vs red+blue detects exactly 400 changed pixels (similarity=0.96)" "output=$output"
    fi

    # Test: diff of completely different images returns low similarity
    run_test
    output="$("$img_diff" diff "$test_dir/red.png" "$test_dir/green.png" 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -eq 0 ] && echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['success'] == True
assert d['similarity'] == 0.0
assert d['changed_pixels'] == 10000
" 2>/dev/null; then
        pass "diff of red vs green returns similarity=0.0 (all pixels changed)"
    else
        fail "diff of red vs green returns similarity=0.0 (all pixels changed)" "output=$output"
    fi

    # Test: diff with --diff-output produces a visual diff image
    run_test
    output="$("$img_diff" diff "$test_dir/red.png" "$test_dir/red_blue.png" --diff-output "$test_dir/visual_diff.png" 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -eq 0 ] && [ -f "$test_dir/visual_diff.png" ] && echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert 'diff_image' in d
assert d['diff_image'].endswith('.png')
" 2>/dev/null; then
        local diff_size
        diff_size="$(python3 -c "from PIL import Image; img=Image.open('$test_dir/visual_diff.png'); print(f'{img.size[0]}x{img.size[1]}')")"
        if [ "$diff_size" = "100x100" ]; then
            pass "diff with --diff-output produces visual diff image (100x100)"
        else
            fail "diff with --diff-output produces visual diff image (100x100)" "size=$diff_size"
        fi
    else
        fail "diff with --diff-output produces visual diff image" "exit=$exit_code output=$output"
    fi

    # Test: diff of different-sized images reports size_match=false
    run_test
    output="$("$img_diff" diff "$test_dir/red.png" "$test_dir/wide.png" 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -eq 0 ] && echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['success'] == True
assert d['size_match'] == False
assert d['before_size'] == {'w': 100, 'h': 100}
assert d['after_size'] == {'w': 200, 'h': 100}
" 2>/dev/null; then
        pass "diff of different-sized images reports size_match=false with correct sizes"
    else
        fail "diff of different-sized images reports size_match=false with correct sizes" "output=$output"
    fi

    # Test: diff with nonexistent before image returns error
    run_test
    output="$("$img_diff" diff /tmp/no_such_image.png "$test_dir/red.png" 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -ne 0 ] && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in d; assert 'not found' in d['error']" 2>/dev/null; then
        pass "diff with nonexistent before image returns error"
    else
        fail "diff with nonexistent before image returns error" "exit=$exit_code output=$output"
    fi

    # Test: vtb-gui screenshot-region works end-to-end
    run_test
    output="$("$VTB_GUI" screenshot-region "$test_dir/red_blue.png" 30 30 20 20 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -eq 0 ] && echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['success'] == True
assert d['region']['w'] == 20
assert d['region']['h'] == 20
" 2>/dev/null; then
        local region_path
        region_path="$(echo "$output" | python3 -c "import sys,json; print(json.load(sys.stdin)['path'])")"
        local pixel
        pixel="$(python3 -c "from PIL import Image; img=Image.open('$region_path'); print(img.getpixel((0,0)))")"
        if [ "$pixel" = "(0, 0, 255)" ]; then
            pass "vtb-gui screenshot-region crops correct region (blue pixel at origin)"
        else
            fail "vtb-gui screenshot-region crops correct region (blue pixel at origin)" "pixel=$pixel"
        fi
        rm -f "$region_path"
    else
        fail "vtb-gui screenshot-region crops correct region" "exit=$exit_code output=$output"
    fi

    # Test: vtb-gui screenshot-diff works end-to-end
    run_test
    output="$("$VTB_GUI" screenshot-diff "$test_dir/red.png" "$test_dir/red_blue.png" 2>&1)" && exit_code=0 || exit_code=$?
    if [ "$exit_code" -eq 0 ] && echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['success'] == True
assert d['similarity'] == 0.96
assert d['changed_pixels'] == 400
assert 'diff_image' in d
" 2>/dev/null; then
        local diff_path
        diff_path="$(echo "$output" | python3 -c "import sys,json; print(json.load(sys.stdin)['diff_image'])")"
        if [ -f "$diff_path" ]; then
            pass "vtb-gui screenshot-diff produces correct results with diff image"
            rm -f "$diff_path"
        else
            fail "vtb-gui screenshot-diff produces correct results with diff image" "diff_path=$diff_path not found"
        fi
    else
        fail "vtb-gui screenshot-diff produces correct results with diff image" "exit=$exit_code output=$output"
    fi

    # Cleanup
    rm -rf "$test_dir"
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
            test_image_processing
            ;;
        --live)
            test_live
            ;;
        --images)
            test_image_processing
            ;;
        *)
            test_basic
            test_missing_hs
            test_image_processing
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
