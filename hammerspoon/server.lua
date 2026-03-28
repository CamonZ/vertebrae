-- server.lua - Hammerspoon HTTP server exposing vtb.lua functions as JSON endpoints
--
-- Replaces the vtb-gui shell script that spawned hs -c subprocesses (which
-- created zombie shells). This server runs inside Hammerspoon and handles
-- requests via hs.httpserver on localhost only.
--
-- Usage in ~/.hammerspoon/init.lua:
--   vtb = dofile("/path/to/vertebrae/hammerspoon/vtb.lua")
--   vtb_server = dofile("/path/to/vertebrae/hammerspoon/server.lua")
--   vtb_server.start(vtb)

local server_mod = {}

local http_server = nil
local PORT = 19024

-- JSON helpers
local function json_ok(data)
    return hs.json.encode(data), 200, {["Content-Type"] = "application/json"}
end

local function json_error(msg, status)
    status = status or 400
    return hs.json.encode({ error = msg }), status, {["Content-Type"] = "application/json"}
end

local function parse_json_body(body)
    if not body or body == "" then
        return {}
    end
    local ok, parsed = pcall(hs.json.decode, body)
    if not ok or parsed == nil then
        return nil
    end
    return parsed
end

-- Screenshot helper: capture a window screenshot and return base64 PNG data
-- instead of writing to a temp file. This avoids the file path + Read roundtrip.
local function screenshot_to_base64(image)
    if not image then
        return nil
    end
    local png_data = image:encodeAsURLString()
    -- encodeAsURLString returns "data:image/png;base64,<data>"
    -- Strip the prefix to get raw base64
    local base64 = png_data:gsub("^data:image/%w+;base64,", "")
    return base64
end

-- Shared helper: capture a window screenshot and build the response
local function capture_window_response(win, window_id)
    local image = win:snapshot()
    if not image then
        return nil, "failed to capture window screenshot"
    end
    local base64 = screenshot_to_base64(image)
    if not base64 then
        return nil, "failed to encode screenshot"
    end
    local frame = win:frame()
    return {
        success = true,
        image_base64 = base64,
        window_id = window_id,
        title = win:title(),
        frame = { x = frame.x, y = frame.y, w = frame.w, h = frame.h },
    }
end

-- Factory for click/right-click handlers (identical structure, different vtb function)
local function make_click_handler(vtb_fn_name)
    return function(params, vtb)
        local x, y = params.x, params.y
        if not x or not y then
            return nil, "x and y are required"
        end
        local result = vtb[vtb_fn_name](x, y, params.delay_ms)
        return hs.json.decode(result)
    end
end

-- Route handlers. Each receives the parsed JSON body and the vtb module.
-- Returns (response_table) or (nil, error_string).

local function handle_window_list(params, vtb)
    local app_name = params.app_name
    if not app_name or app_name == "" then
        return nil, "app_name is required"
    end
    local result = vtb.list_windows(app_name)
    return hs.json.decode(result)
end

local function handle_window_find(params, vtb)
    local title = params.title
    local app_name = params.app_name
    if not title or title == "" then
        return nil, "title is required"
    end
    if not app_name or app_name == "" then
        return nil, "app_name is required"
    end
    local result = vtb.find_window(title, app_name)
    return hs.json.decode(result)
end

local function handle_window_focus(params, vtb)
    local window_id = params.window_id
    if not window_id then
        return nil, "window_id is required"
    end
    local result = vtb.focus_window(window_id)
    return hs.json.decode(result)
end

local function handle_window_focused(_, vtb)
    local result = vtb.focused_window()
    return hs.json.decode(result)
end

local handle_click = make_click_handler("click_at")
local handle_right_click = make_click_handler("right_click_at")

local function handle_type(params, vtb)
    local text = params.text
    if not text or text == "" then
        return nil, "text is required"
    end
    local result = vtb.type_text(text)
    return hs.json.decode(result)
end

local function handle_key_press(params, vtb)
    local key = params.key
    if not key then
        return nil, "key is required"
    end
    local result = vtb.key_press(params.modifiers or {}, key)
    return hs.json.decode(result)
end

local function handle_mouse_position(_, vtb)
    local result = vtb.mouse_position()
    return hs.json.decode(result)
end

local function handle_move_mouse(params, vtb)
    local x = params.x
    local y = params.y
    if not x or not y then
        return nil, "x and y are required"
    end
    local result = vtb.move_mouse(x, y)
    return hs.json.decode(result)
end

local function handle_screenshot(_, vtb)
    local screen = hs.screen.mainScreen()
    local image = screen:snapshot()
    if not image then
        return nil, "failed to capture screenshot"
    end
    local base64 = screenshot_to_base64(image)
    if not base64 then
        return nil, "failed to encode screenshot"
    end
    return { success = true, image_base64 = base64 }
end

local function handle_screenshot_window(params, vtb)
    local window_id = params.window_id
    if not window_id then
        return nil, "window_id is required"
    end
    local win = hs.window.get(window_id)
    if not win then
        return nil, "window not found"
    end
    return capture_window_response(win, window_id)
end

local function handle_screenshot_app(params, vtb)
    local app_name = params.app_name
    if not app_name or app_name == "" then
        return nil, "app_name is required"
    end

    -- Reuse vtb internal logic: find the app and its windows
    local result_json = vtb.list_windows(app_name)
    local windows = hs.json.decode(result_json)

    if windows.error then
        return nil, windows.error
    end
    if #windows == 0 then
        return nil, "no windows found for app: " .. app_name
    end

    -- Find matching window
    local target_info = windows[1]
    if params.title and params.title ~= "" then
        local pattern = params.title:lower()
        target_info = nil
        for _, w in ipairs(windows) do
            if w.title:lower():find(pattern, 1, true) then
                target_info = w
                break
            end
        end
        if not target_info then
            return nil, "no window matching title: " .. params.title
        end
    end

    local win = hs.window.get(target_info.id)
    if not win then
        return nil, "could not get window handle"
    end

    return capture_window_response(win, target_info.id)
end

local function handle_ui_elements(params, vtb)
    local window_id = params.window_id
    local max_depth = params.max_depth or 3
    if not window_id then
        return nil, "window_id is required"
    end
    local result = vtb.read_ui_elements(window_id, max_depth)
    return hs.json.decode(result)
end

local function handle_ui_elements_app(params, vtb)
    local app_name = params.app_name
    if not app_name or app_name == "" then
        return nil, "app_name is required"
    end
    local result = vtb.read_ui_elements_for_app(app_name, params.max_depth or 3)
    return hs.json.decode(result)
end

-- Route table: method + path -> handler
local routes = {
    ["POST /window/list"]     = handle_window_list,
    ["POST /window/find"]     = handle_window_find,
    ["POST /window/focus"]    = handle_window_focus,
    ["GET /window/focused"]   = handle_window_focused,
    ["POST /click"]           = handle_click,
    ["POST /right-click"]     = handle_right_click,
    ["POST /type"]            = handle_type,
    ["POST /key-press"]       = handle_key_press,
    ["GET /mouse/position"]   = handle_mouse_position,
    ["POST /mouse/move"]      = handle_move_mouse,
    ["GET /screenshot"]       = handle_screenshot,
    ["POST /screenshot/window"] = handle_screenshot_window,
    ["POST /screenshot/app"]  = handle_screenshot_app,
    ["POST /ui-elements"]     = handle_ui_elements,
    ["POST /ui-elements/app"] = handle_ui_elements_app,
}

function server_mod.start(vtb, port)
    port = port or PORT

    if http_server then
        print("[vtb-server] Server already running on port " .. port)
        return http_server
    end

    http_server = hs.httpserver.new()
    http_server:setPort(port)
    http_server:setInterface("localhost")

    http_server:setCallback(function(method, path, headers, body)
        -- Health check
        if path == "/health" then
            return json_ok({ status = "ok", port = port })
        end

        local route_key = method .. " " .. path
        local handler = routes[route_key]

        if not handler then
            return json_error("not found: " .. method .. " " .. path, 404)
        end

        local params = parse_json_body(body)
        if params == nil then
            -- Invalid JSON body; GET requests may have no body, treat as empty
            if method == "GET" then
                params = {}
            else
                return json_error("invalid JSON body", 400)
            end
        end

        local ok, result_or_err, err = pcall(handler, params, vtb)

        if not ok then
            return json_error("internal error: " .. tostring(result_or_err), 500)
        end

        if result_or_err == nil then
            return json_error(err or "unknown error", 400)
        end

        return json_ok(result_or_err)
    end)

    http_server:start()
    print("[vtb-server] Started on localhost:" .. port)
    return http_server
end

function server_mod.stop()
    if http_server then
        http_server:stop()
        http_server = nil
        print("[vtb-server] Stopped")
    end
end

function server_mod.restart(vtb, port)
    server_mod.stop()
    return server_mod.start(vtb, port)
end

return server_mod
