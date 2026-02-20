luci-app-mobilenetwork (Mobile Network scan/connect)
===================================================

What this does
--------------
- Adds a LuCI page:  Network -> Mobile Network
- Button "Scan Network" calls a LuCI Lua endpoint (/admin/network/mobilescan/scan)
- The Lua endpoint POSTs JSON-RPC to GL.iNet RPC endpoint: http://127.0.0.1:80/rpc
  with required header: glinet: 1
- Default scan command: AT+COPS=?
- Results are parsed from json.data.result.response which includes +COPS: tuples.
- Results show as radio-selectable table rows with a small signal-bars icon.
- On selection:
    - 1st element (tuple[0]) controls Connect enable:
        0..2 => enabled
        3    => disabled
    - 4th element (tuple[3], PLMN) is used for connect command.
- Button "Connect" sends: AT+COPS=1,2,<PLMN>
- Button "Set Auto-connect" calls modem.set_auto_connect with {bus:"1-1.2"}

Files included
--------------
- /usr/lib/lua/luci/controller/mobilescan.lua
- /usr/lib/lua/luci/view/mobilescan/index.htm
- /www/luci-static/resources/view/mobilescan/index.js
- /usr/share/luci/menu.d/luci-app-mobilescan.json

Install instructions (copy files)
---------------------------------
1) Copy the folders from this zip to your router root (/). Example using scp from your PC:

   scp -r usr www root@<router-ip>:/

   Or copy file-by-file into the same paths.

2) Restart LuCI web server:

   /etc/init.d/uhttpd restart

   (If your device uses a different web server, restart that one instead.)

3) Open LuCI in browser:
   Network -> Mobile Network

Adjustments you may need
------------------------
- If your modem bus/port differs, edit defaults in:
    /usr/lib/lua/luci/controller/mobilescan.lua
  Look for:
    local bus  = ... or "1-1.2"
    local port = ... or "/dev/ttyUSB2"

- If your scan command differs from AT+COPS=?, edit:
    local cmd = ... or "AT+COPS=?"

Optional endpoint
-----------------
- /admin/network/mobilescan/set_auto_connect
  This calls JSON-RPC method "modem.set_auto_connect" with {bus:"1-1.2"}
  (Not wired into the UI by default.)

Troubleshooting
---------------
- If scan returns 0 networks:
  - Confirm /rpc works from the router shell:
      curl -H 'glinet: 1' -s http://127.0.0.1:80/rpc -d '{"jsonrpc":"2.0","method":"call","params":["","modem","send_at_command",{"bus":"1-1.2","port":"ttyUSB2","command":"AT+COPS=?"}],"id":1}'
  - Verify bus/port values.
- If Connect is always disabled:
  - Ensure your +COPS tuples have the first element 0..3 as expected.

Dependency
----------
- This build uses `curl` from the router shell because `luci.httpclient` is not available on your LuCI.
  If `curl` is missing, install it:
    opkg update && opkg install curl
