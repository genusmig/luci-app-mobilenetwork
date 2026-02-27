
module("luci.controller.mobilescan", package.seeall)

local http  = require "luci.http"
local jsonc = require "luci.jsonc"
local sys   = require "luci.sys"
local nixio = require "nixio"

local RPC_URL = "http://127.0.0.1:80/rpc"
local DEFAULT_BUS  = "1-1.2"
local DEFAULT_PORT = "/dev/ttyUSB2"

local function shell_escape_single(s)
  return "'" .. (s:gsub("'", [['"'"']])) .. "'"
end

local function rpc_call(obj, max_time)
  local body = jsonc.stringify(obj)
  local connect_timeout = 3
  local max_t = tonumber(max_time) or 60

  local cmd = "curl -s --connect-timeout " .. connect_timeout .. " --max-time " .. max_t .. " " ..
              "-H 'glinet: 1' " ..
              "-H 'Content-Type: application/json' " ..
              "-H 'Accept: application/json' " ..
              shell_escape_single(RPC_URL) .. " " ..
              "-d " .. shell_escape_single(body)

  local res = sys.exec(cmd)
  if not res or res == "" then
    return nil, { ok=false, error="Time out. Please try again." }
  end

  res = res:gsub("%s+$", "")
  local parsed = jsonc.parse(res)
  if not parsed then
    return nil, { ok=false, error="RPC response not JSON", body=res }
  end

  return parsed, nil
end

local function is_busy_error(parsed, err)
  local function has_busy(s)
    if not s or type(s) ~= "string" then return false end
    return s:lower():match("busy") ~= nil
  end

  if err and has_busy(err.error) then return true end
  if parsed and parsed.error then
    if has_busy(parsed.error.message) then return true end
    if has_busy(parsed.error.data) then return true end
  end
  if parsed and parsed.result and has_busy(parsed.result.response) then return true end
  return false
end

local function rpc_call_retry(obj, max_time, retries)
  local last_parsed, last_err
  local tries = tonumber(retries) or 3
  if tries < 1 then tries = 1 end

  for i = 1, tries do
    local parsed, err = rpc_call(obj, max_time)
    last_parsed, last_err = parsed, err
    if not is_busy_error(parsed, err) then
      return parsed, err
    end
    if i < tries then
      nixio.nanosleep(1, 0)
    end
  end

  return last_parsed, last_err
end

function index()
  entry({"admin", "network", "mobilescan"}, template("mobilescan/index"), _("Mobile Network"), 90).dependent = true
  entry({"admin", "network", "mobilescan", "scan"}, call("action_scan")).leaf = true
  entry({"admin", "network", "mobilescan", "connect"}, call("action_connect")).leaf = true
  entry({"admin", "network", "mobilescan", "set_auto_connect"}, call("action_set_auto_connect")).leaf = true
  entry({"admin", "network", "mobilescan", "at"}, call("action_at")).leaf = true
end

function action_scan()
  http.prepare_content("application/json")

  -- First: Disconnect modem
  local disconnect_payload = {
    jsonrpc = "2.0",
    method  = "call",
    params  = { "", "modem", "disconnect", { bus= DEFAULT_BUS } },
    id      = 1
  }

  local parsed_disc, err_disc = rpc_call_retry(disconnect_payload, 60, 3)
  if err_disc then
    http.write_json(err_disc)
    return
  end

  -- Optional: check disconnect success
  if parsed_disc and parsed_disc.error then
    http.write_json({ ok=false, error="Disconnect failed", detail=parsed_disc })
    return
  end

  -- Then: Perform Scan
  local scan_payload = {
    jsonrpc = "2.0",
    method  = "call",
    params  = {
      "",
      "modem",
      "send_at_command",
      { bus = DEFAULT_BUS, port = DEFAULT_PORT, command = "AT+COPS=?" }
    },
    id = 1
  }

  local parsed_scan, err_scan = rpc_call_retry(scan_payload, 60, 3)
  if err_scan then
    http.write_json(err_scan)
    return
  end

  http.write_json({ ok=true, data=parsed_scan })
end

function action_connect()
  http.prepare_content("application/json")
  local plmn = http.formvalue("plmn") or ""
  if plmn == "" or not plmn:match("^%d+$") then
    http.write_json({ ok=false, error="Invalid PLMN" })
    return
  end

  local cmd = string.format('AT+COPS=1,2,"%s"', plmn)
  local payload = {
    jsonrpc = "2.0",
    method  = "call",
    params  = { "", "modem", "send_at_command",
      { bus= DEFAULT_BUS, port= DEFAULT_PORT, command= cmd } },
    id = 1
  }
  local parsed, err = rpc_call_retry(payload, 60, 3)
  if err then http.write_json(err); return end
  http.write_json({ ok=true, data=parsed })
end

function action_set_auto_connect()
  http.prepare_content("application/json")
  local payload = {
    jsonrpc = "2.0",
    method  = "call",
    params  = { "", "modem", "set_connect", { bus= DEFAULT_BUS } },
    id = 1
  }
  local parsed, err = rpc_call_retry(payload, 60, 3)
  if err then http.write_json(err); return end
  http.write_json({ ok=true, data=parsed })
end

function action_at()
  http.prepare_content("application/json")
  local cmd = http.formvalue("cmd") or ""
  if cmd == "" or not cmd:match("^AT") then
    http.write_json({ ok=false, error="Invalid AT command" })
    return
  end
  local payload = {
    jsonrpc = "2.0",
    method  = "call",
    params  = { "", "modem", "send_at_command",
      { bus= DEFAULT_BUS, port=DEFAULT_PORT, command=cmd } },
    id = 1
  }
  local parsed, err = rpc_call_retry(payload, 60, 3)
  if err then http.write_json(err); return end
  http.write_json({ ok=true, data=parsed })
end
