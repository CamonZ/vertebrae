-- vtb.lua - Vertebrae GUI automation primitives for Hammerspoon
--
-- Load this module in your Hammerspoon init.lua:
--   vtb = dofile("/path/to/vertebrae/hammerspoon/vtb.lua")
--
-- Then invoke from the CLI:
--   hs -c 'vtb.list_windows("Vertebrae")'
--   hs -c 'vtb.find_window("Vertebrae")'

local vtb = {}

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

local function window_to_table(win)
    local frame = win:frame()
    return {
        id = win:id(),
        title = win:title(),
        app = win:application():name(),
        frame = {
            x = frame.x,
            y = frame.y,
            w = frame.w,
            h = frame.h,
        },
    }
end

-- Find a running application by exact name (case-insensitive).
-- Uses manual iteration of runningApplications() instead of hs.application.find()
-- because the latter uses Spotlight and can hang for non-existent app names.
local function find_app_by_name(app_name)
    local lower_name = app_name:lower()
    for _, app in ipairs(hs.application.runningApplications()) do
        local name = app:name()
        if name and name:lower() == lower_name then
            return app
        end
    end
    return nil
end

-- Get windows from a specific application by name.
-- Returns a list of hs.window objects.
local function windows_for_app(app_name)
    local app = find_app_by_name(app_name)
    if not app then
        return {}
    end
    local result = {}
    local ok, wins = pcall(function() return app:allWindows() end)
    if ok and wins then
        for _, win in ipairs(wins) do
            local id = win:id()
            local title = win:title()
            if id and id > 0 and title and title ~= "" then
                table.insert(result, win)
            end
        end
    end
    return result
end

-- ---------------------------------------------------------------------------
-- Window management
-- ---------------------------------------------------------------------------

--- List windows for a given application name.
--- Returns a JSON array of objects with id, title, app, and frame.
function vtb.list_windows(app_name)
    if not app_name or app_name == "" then
        return hs.json.encode({ error = "app_name is required" })
    end
    local windows = windows_for_app(app_name)
    local result = {}
    for _, win in ipairs(windows) do
        table.insert(result, window_to_table(win))
    end
    return hs.json.encode(result)
end

--- Find windows whose title contains the given substring (case-insensitive).
--- app_name is required to avoid slow global window enumeration.
--- Returns a JSON array of matching window objects.
function vtb.find_window(title_substring, app_name)
    if not title_substring or title_substring == "" then
        return hs.json.encode({ error = "title_substring is required" })
    end
    if not app_name or app_name == "" then
        return hs.json.encode({ error = "app_name is required" })
    end

    local pattern = title_substring:lower()
    local windows = windows_for_app(app_name)
    local result = {}
    for _, win in ipairs(windows) do
        if win:title():lower():find(pattern, 1, true) then
            table.insert(result, window_to_table(win))
        end
    end
    return hs.json.encode(result)
end

--- Focus a window by its numeric window ID.
--- Returns JSON with success status and the focused window title.
function vtb.focus_window(window_id)
    if not window_id then
        return hs.json.encode({ error = "window_id is required" })
    end
    local win = hs.window.get(window_id)
    if not win then
        return hs.json.encode({ error = "window not found", window_id = window_id })
    end
    win:focus()
    local focused = hs.window.focusedWindow()
    local is_focused = (focused and focused:id() == win:id())
    return hs.json.encode({
        success = is_focused,
        window_id = win:id(),
        title = win:title(),
    })
end

--- Get the currently focused window.
--- Returns JSON with the focused window's details.
function vtb.focused_window()
    local win = hs.window.focusedWindow()
    if not win then
        return hs.json.encode({ error = "no focused window" })
    end
    return hs.json.encode(window_to_table(win))
end

-- ---------------------------------------------------------------------------
-- Mouse & keyboard input
-- ---------------------------------------------------------------------------

--- Click at absolute screen coordinates.
--- Optional delay_ms specifies how long to hold the click (default: 50ms).
function vtb.click_at(x, y, delay_ms)
    if not x or not y then
        return hs.json.encode({ error = "x and y coordinates are required" })
    end
    delay_ms = delay_ms or 50
    local point = hs.geometry.point(x, y)
    hs.eventtap.leftClick(point, delay_ms * 1000)
    return hs.json.encode({ success = true, x = x, y = y })
end

--- Right-click at absolute screen coordinates.
function vtb.right_click_at(x, y, delay_ms)
    if not x or not y then
        return hs.json.encode({ error = "x and y coordinates are required" })
    end
    delay_ms = delay_ms or 50
    local point = hs.geometry.point(x, y)
    hs.eventtap.rightClick(point, delay_ms * 1000)
    return hs.json.encode({ success = true, x = x, y = y })
end

--- Type a string of text using simulated keystrokes.
function vtb.type_text(text)
    if not text or text == "" then
        return hs.json.encode({ error = "text is required" })
    end
    hs.eventtap.keyStrokes(text)
    return hs.json.encode({ success = true, length = #text })
end

--- Press a key combination (e.g., vtb.key_press({"cmd"}, "s") for Cmd+S).
function vtb.key_press(modifiers, key)
    if not key then
        return hs.json.encode({ error = "key is required" })
    end
    modifiers = modifiers or {}
    hs.eventtap.keyStroke(modifiers, key)
    return hs.json.encode({ success = true, key = key, modifiers = modifiers })
end

-- ---------------------------------------------------------------------------
-- Screenshot capture
-- ---------------------------------------------------------------------------

--- Take a screenshot of the entire screen and save to a temp file.
--- Returns the absolute path to the saved PNG image.
function vtb.screenshot()
    local screen = hs.screen.mainScreen()
    local image = screen:snapshot()
    if not image then
        return hs.json.encode({ error = "failed to capture screenshot" })
    end
    local path = os.tmpname() .. ".png"
    image:saveToFile(path)
    return hs.json.encode({ success = true, path = path })
end

--- Take a screenshot of a specific window by ID.
--- Returns the absolute path to the saved PNG image.
function vtb.screenshot_window(window_id)
    if not window_id then
        return hs.json.encode({ error = "window_id is required" })
    end
    local win = hs.window.get(window_id)
    if not win then
        return hs.json.encode({ error = "window not found", window_id = window_id })
    end
    local image = win:snapshot()
    if not image then
        return hs.json.encode({ error = "failed to capture window screenshot", window_id = window_id })
    end
    local path = os.tmpname() .. ".png"
    image:saveToFile(path)
    return hs.json.encode({ success = true, path = path, window_id = window_id })
end

--- Take a screenshot of a window found by app name and optional title substring.
--- If title_substring is nil, captures the first window of the app.
function vtb.screenshot_app(app_name, title_substring)
    if not app_name or app_name == "" then
        return hs.json.encode({ error = "app_name is required" })
    end
    local windows = windows_for_app(app_name)
    if #windows == 0 then
        return hs.json.encode({ error = "no windows found for app: " .. app_name })
    end

    local target = windows[1]
    if title_substring and title_substring ~= "" then
        local pattern = title_substring:lower()
        target = nil
        for _, win in ipairs(windows) do
            if win:title():lower():find(pattern, 1, true) then
                target = win
                break
            end
        end
        if not target then
            return hs.json.encode({ error = "no window matching title: " .. title_substring })
        end
    end

    local image = target:snapshot()
    if not image then
        return hs.json.encode({
            error = "failed to capture window screenshot",
            title = target:title(),
        })
    end
    local path = os.tmpname() .. ".png"
    image:saveToFile(path)
    return hs.json.encode({
        success = true,
        path = path,
        window_id = target:id(),
        title = target:title(),
    })
end

-- ---------------------------------------------------------------------------
-- UI element inspection (Accessibility API)
-- ---------------------------------------------------------------------------

local function element_to_table(element, max_depth, current_depth)
    current_depth = current_depth or 0
    max_depth = max_depth or 3

    if current_depth > max_depth then
        return { truncated = true }
    end

    local info = {}
    info.role = element:attributeValue("AXRole")
    info.role_description = element:attributeValue("AXRoleDescription")
    info.title = element:attributeValue("AXTitle")
    info.value = element:attributeValue("AXValue")
    info.description = element:attributeValue("AXDescription")
    info.identifier = element:attributeValue("AXIdentifier")
    info.enabled = element:attributeValue("AXEnabled")

    local position = element:attributeValue("AXPosition")
    local size = element:attributeValue("AXSize")
    if position and size then
        info.frame = {
            x = position.x,
            y = position.y,
            w = size.w,
            h = size.h,
        }
    end

    local children = element:attributeValue("AXChildren")
    if children and #children > 0 then
        info.children = {}
        for _, child in ipairs(children) do
            table.insert(info.children, element_to_table(child, max_depth, current_depth + 1))
        end
    end

    return info
end

--- Read the accessibility element tree for a window identified by window ID.
--- max_depth controls how deep to traverse (default: 3).
--- Returns JSON with the element hierarchy including roles, titles, and positions.
function vtb.read_ui_elements(window_id, max_depth)
    if not window_id then
        return hs.json.encode({ error = "window_id is required" })
    end
    max_depth = max_depth or 3
    local win = hs.window.get(window_id)
    if not win then
        return hs.json.encode({ error = "window not found", window_id = window_id })
    end

    local app = win:application()
    local axApp = hs.axuielement.applicationElement(app)
    if not axApp then
        return hs.json.encode({ error = "failed to get accessibility element for app" })
    end

    local axWindows = axApp:attributeValue("AXWindows")
    if not axWindows then
        return hs.json.encode({ error = "no accessibility windows found" })
    end

    for _, axWin in ipairs(axWindows) do
        local axTitle = axWin:attributeValue("AXTitle")
        if axTitle == win:title() then
            local tree = element_to_table(axWin, max_depth)
            return hs.json.encode({
                success = true,
                window_id = window_id,
                title = win:title(),
                elements = tree,
            })
        end
    end

    -- Fallback: use first AX window if title match fails
    if #axWindows > 0 then
        local tree = element_to_table(axWindows[1], max_depth)
        return hs.json.encode({
            success = true,
            window_id = window_id,
            title = win:title(),
            elements = tree,
            note = "used first AX window (title match failed)",
        })
    end

    return hs.json.encode({ error = "no matching accessibility window found" })
end

--- Read UI elements for the first window of a given application.
--- Convenience wrapper around list_windows + read_ui_elements.
function vtb.read_ui_elements_for_app(app_name, max_depth)
    if not app_name or app_name == "" then
        return hs.json.encode({ error = "app_name is required" })
    end
    max_depth = max_depth or 3
    local windows = windows_for_app(app_name)
    if #windows == 0 then
        return hs.json.encode({ error = "no windows found for app: " .. app_name })
    end
    return vtb.read_ui_elements(windows[1]:id(), max_depth)
end

-- ---------------------------------------------------------------------------
-- Utility
-- ---------------------------------------------------------------------------

--- Get the current mouse cursor position.
function vtb.mouse_position()
    local pos = hs.mouse.absolutePosition()
    return hs.json.encode({ x = pos.x, y = pos.y })
end

--- Move the mouse to absolute screen coordinates without clicking.
function vtb.move_mouse(x, y)
    if not x or not y then
        return hs.json.encode({ error = "x and y coordinates are required" })
    end
    hs.mouse.absolutePosition(hs.geometry.point(x, y))
    return hs.json.encode({ success = true, x = x, y = y })
end

return vtb
