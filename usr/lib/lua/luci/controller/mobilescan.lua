
module("luci.controller.mobilescan", package.seeall)

local http  = require "luci.http"
local jsonc = require "luci.jsonc"
local sys   = require "luci.sys"

local RPC_URL = "http://127.0.0.1:80/rpc"
local DEFAULT_BUS  = "1-1.2"
local DEFAULT_PORT = "/dev/ttyUSB2"

local function shell_escape_single(s)
  return "'" .. (s:gsub("'", [['"'"']])) .. "'"
end

local function rpc_call(obj, max_time)
  local body = jsonc.stringify(obj)
  local connect_timeout = 3
  local max_t = tonumber(max_time) or 25

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

function index()
  entry({"admin", "network", "mobilescan"}, template("mobilescan/index"), _("Mobile Network"), 90).dependent = true
  entry({"admin", "network", "mobilescan", "scan"}, call("action_scan")).leaf = true
  entry({"admin", "network", "mobilescan", "connect"}, call("action_connect")).leaf = true
  entry({"admin", "network", "mobilescan", "set_auto_connect"}, call("action_set_auto_connect")).leaf = true
  entry({"admin", "network", "mobilescan", "at"}, call("action_at")).leaf = true
end

function action_scan()
  http.prepare_content("application/json")
  local payload = {
    jsonrpc = "2.0",
    method  = "call",
    params  = { "", "modem", "send_at_command", { bus= DEFAULT_BUS, port= DEFAULT_PORT, command= "AT+COPS=?" } },
    id = 1
  }
  local parsed, err = rpc_call(payload, 45)
  if err then http.write_json(err); return end
  http.write_json({ ok=true, data=parsed })
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

  local parsed_disc, err_disc = rpc_call(disconnect_payload, 20)
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

  local parsed_scan, err_scan = rpc_call(scan_payload, 45)
  if err_scan then
    http.write_json(err_scan)
    return
  end

  http.write_json({ ok=true, data=parsed_scan })
end

function action_set_auto_connect()
  http.prepare_content("application/json")
  local payload = {
    jsonrpc = "2.0",
    method  = "call",
    params  = { "", "modem", "set_connect", { bus= DEFAULT_BUS } },
    id = 1
  }
  local parsed, err = rpc_call(payload, 15)
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
  local parsed, err = rpc_call(payload, 25)
  if err then http.write_json(err); return end
  http.write_json({ ok=true, data=parsed })
end
