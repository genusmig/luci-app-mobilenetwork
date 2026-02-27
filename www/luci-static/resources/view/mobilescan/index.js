'use strict';
'require view';
'require request';

function el(tag, attrs, children) {
  const n = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(k => n.setAttribute(k, attrs[k]));
  (children || []).forEach(c => n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return n;
}

function isIntLike(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return true;
  if (typeof v === 'string' && v.trim() !== '' && /^-?\d+$/.test(v.trim())) return true;
  return false;
}

function toInt(v) {
  if (typeof v === 'number') return v | 0;
  return parseInt(String(v).trim(), 10);
}

/** Robust LuCI URL builder */
function luciUrl(path) {
  let base = (typeof L !== 'undefined' && L.env && (L.env.dispatcher_base || L.env.cgi_base)) || '';
  if (!base) base = '/cgi-bin/luci';
  if (base === '/cgi-bin') base = '/cgi-bin/luci';
  if (!path.startsWith('/')) path = '/' + path;
  return base + path;
}

function parseCopsResponse(text) {
  if (!text || typeof text !== 'string') return [];
  const groups = text.match(/\([^\)]*\)/g);
  if (!groups) return [];

  return groups
    .map(g => g.slice(1, -1))
    .map(inner => {
      const tokens = inner.match(/"[^"]*"|[^,]+/g) || [];
      return tokens.map(t => t.trim()).map(t => {
        if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
        if (/^-?\d+$/.test(t)) return parseInt(t, 10);
        return t;
      });
    })
    .filter(arr => arr.length >= 4 && typeof arr[3] === 'string' && /^\d+$/.test(arr[3]));
}

/** signal -> 0..4 bars clamp */
function signalToBars(sig) {
  if (!isIntLike(sig)) return 0;
  const v = toInt(sig);
  // If it's already a 0..4 scale, keep it.
  if (v >= 0 && v <= 4) return v;
  // Map CSQ 0..31 to 0..4 bars.
  if (v <= 1) return 0;
  if (v <= 9) return 1;
  if (v <= 14) return 2;
  if (v <= 19) return 3;
  if (v <= 31) return 4;
  return 0;
}

function makeSignalIcon(sig) {
  const bars = signalToBars(sig);
  const wrap = el('span', { 'class': 'ms-signal' }, []);
  for (let i = 1; i <= 4; i++) {
    wrap.appendChild(el('span', {
      'class': 'ms-bar' + (i <= bars ? ' on' : ''),
      'data-b': String(i)
    }, []));
  }
  wrap.title = isIntLike(sig) ? `Signal: ${sig}` : 'Signal: n/a';
  return wrap;
}

function extractModemResponse(json) {
  return json?.data?.result?.response ?? '';
}

function responseHasOK(resp) {
  if (!resp || typeof resp !== 'string') return false;
  return /\r?\nOK\r?\n/i.test(resp) || /(^|\s)OK(\s|$)/i.test(resp);
}

function parseCopsCurrentOperator(resp) {
  if (!resp || typeof resp !== 'string') return null;
  const m = resp.match(/\+COPS:\s*\d+(?:,\d+)?(?:,\"([^\"]*)\")?/i);
  if (m && m[1]) return m[1].trim() || null;
  return null;
}

function parseCopsSignal(resp) {
  if (!resp || typeof resp !== 'string') return null;
  const m = resp.match(/\+CSQ:\s*(\d+)\s*,/i);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  if (!Number.isFinite(v)) return null;
  // 99 means "not known or not detectable"
  if (v === 99) return null;
  return v;
}
const REQUEST_TIMEOUT_MS = 60000;
/** Fix “weird ?” / object errors */
function prettyError(e) {
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;

  // LuCI request errors sometimes include status fields
  if (e.status) return `HTTP ${e.status} ${e.statusText || ''}`.trim();
  if (e.responseText) return String(e.responseText).slice(0, 200);

  try { return JSON.stringify(e); } catch (_) {}
  return String(e);
}

/* -------------------- Modal Status + Progress -------------------- */

function createStatusModal() {
  const overlay = el('div', { id: 'ms-modal-overlay', class: 'ms-modal-hidden' }, []);
  const modal = el('div', { id: 'ms-modal' }, [
    el('div', { id: 'ms-modal-title' }, [
      el('span', { id: 'ms-modal-title-icon', class: 'ms-modal-spinner' }, ['']),
      el('span', { id: 'ms-modal-title-text' }, ['Working...'])
    ]),
    el('div', { id: 'ms-modal-msg' }, ['Please wait...']),
    el('div', { id: 'ms-modal-progress' }, [
      el('div', { id: 'ms-modal-bar' }, [])
    ]),
    el('div', { id: 'ms-modal-eta' }, ['Time left: --s'])
  ]);

  overlay.appendChild(modal);
  return overlay;
}

function modalSetVisible(modal, show) {
  if (!modal) return;
  modal.classList.toggle('ms-modal-hidden', !show);
}

function modalSetMessage(modal, msg, title) {
  if (!modal) return;
  const titleEl = modal.querySelector('#ms-modal-title-text');
  const msgEl = modal.querySelector('#ms-modal-msg');
  if (titleEl && title) titleEl.textContent = String(title);
  if (msgEl) msgEl.textContent = String(msg || '');
}

function modalSetState(modal, state) {
  if (!modal) return;
  const icon = modal.querySelector('#ms-modal-title-icon');
  if (!icon) return;
  icon.classList.remove('ms-modal-spinner', 'ms-modal-icon-ok', 'ms-modal-icon-err');
  if (state === 'ok') {
    icon.textContent = 'OK';
    icon.classList.add('ms-modal-icon-ok');
  } else if (state === 'error') {
    icon.textContent = 'ERR';
    icon.classList.add('ms-modal-icon-err');
  } else {
    icon.textContent = '';
    icon.classList.add('ms-modal-spinner');
  }
}
function modalSetProgress(modal, ratio, secondsLeft) {
  if (!modal) return;
  const bar = modal.querySelector('#ms-modal-bar');
  const eta = modal.querySelector('#ms-modal-eta');
  if (bar) bar.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  if (eta) eta.textContent = `Time left: ${Math.max(0, Math.ceil(secondsLeft))}s`;
}

function createModalController(modal) {
  let timer = null;
  let endAt = 0;

  function start(msg, timeoutMs, title) {
    stop();
    endAt = Date.now() + timeoutMs;
    modalSetMessage(modal, msg, title || 'Working...');
    modalSetState(modal, 'working');
    modalSetVisible(modal, true);
    const tick = () => {
      const now = Date.now();
      const remaining = Math.max(0, endAt - now);
      const ratio = timeoutMs > 0 ? (remaining / timeoutMs) : 0;
      modalSetProgress(modal, 1 - ratio, remaining / 1000);
      if (remaining <= 0) stop(false);
    };
    tick();
    timer = setInterval(tick, 250);
  }

  function update(msg, title, state) {
    modalSetMessage(modal, msg, title);
    if (state) modalSetState(modal, state);
  }

  function stop(hide = true) {
    if (timer) clearInterval(timer);
    timer = null;
    if (hide) modalSetVisible(modal, false);
  }

  return { start, update, stop };
}

/* Operator name helper */
function operatorNameFromTuple(t) {
  if (!t) return 'Unknown operator';
  const opLong = (t[1] ?? '').toString().trim();
  const opShort = (t[2] ?? '').toString().trim();
  const plmn = (t[3] ?? '').toString().trim();
  return opLong || opShort || plmn || 'Unknown operator';
}

return view.extend({
  load: function () { return Promise.resolve(); },

  render: function () {
    const root = el('div', { id: 'mobilescan-app' }, []);
    const modalOverlay = createStatusModal();
    const modal = createModalController(modalOverlay);

    const style = el('style', {}, [`
      /* Hide Save/Apply/Reset bars */
      .cbi-page-actions, .cbi-section-actions, .cbi-map > .cbi-page-actions { display:none !important; }

      /* Modal overlay */
      #ms-modal-overlay{
        position:fixed; inset:0; z-index:9999;
        display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,0.25);
        backdrop-filter:blur(1px);
      }
      #ms-modal-overlay.ms-modal-hidden{ display:none; }
      #ms-modal{
        width:min(520px, 92vw);
        background:#fff; color:#111;
        border-radius:14px; padding:18px 20px;
        box-shadow:0 20px 50px rgba(0,0,0,0.2);
        border:1px solid rgba(0,0,0,0.08);
      }
      #ms-modal-title{
        font-weight:700; font-size:16px; margin-bottom:6px;
        display:flex; align-items:center; gap:8px;
      }
      #ms-modal-msg{ font-size:13px; line-height:1.4; white-space:pre-wrap; }
      #ms-modal-progress{
        margin-top:14px; height:8px; border-radius:6px;
        background:rgba(0,0,0,0.12); overflow:hidden;
      }
      #ms-modal-bar{
        height:100%; width:0%;
        background:linear-gradient(90deg, #16a34a, #22c55e);
        transition:width 200ms linear;
      }
      #ms-modal-eta{ margin-top:8px; font-size:12px; color:rgba(0,0,0,0.6); }

      /* Table */
      #mobilescan-app table.ms-table{ width:100%; table-layout:fixed; border-collapse:collapse; }
      #mobilescan-app table.ms-table th, #mobilescan-app table.ms-table td{
        vertical-align:middle; padding:8px 10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
      }
      #mobilescan-app .col-select{ width:110px; text-align:center; }
      #mobilescan-app .col-operator{ text-align:left; }
      #mobilescan-app .col-plmn{ width:120px; text-align:left; }
      #mobilescan-app .col-signal{ width:110px; text-align:center; }

      #mobilescan-app tr.ms-selected td{ background:rgba(0,0,0,0.06); }
      #mobilescan-app input[type="radio"]{ transform:translateY(1px); }

      /* Signal icon */
      #mobilescan-app .ms-signal{ display:inline-flex; align-items:flex-end; justify-content:center; gap:2px; height:14px; }
      #mobilescan-app .ms-bar{ width:3px; background:rgba(0,0,0,0.18); border-radius:1px; display:inline-block; }
      #mobilescan-app .ms-bar[data-b="1"]{ height:4px; }
      #mobilescan-app .ms-bar[data-b="2"]{ height:7px; }
      #mobilescan-app .ms-bar[data-b="3"]{ height:10px; }
      #mobilescan-app .ms-bar[data-b="4"]{ height:13px; }
      #mobilescan-app .ms-bar.on{ background:#3b82f6; }

      #mobilescan-app .ms-empty{ color:rgba(0,0,0,0.55); font-style:italic; }

      /* Info pills styled like buttons for better dark-mode visibility */
      #mobilescan-app .ms-info-pill{
        cursor:default; pointer-events:none;
        font-size:12px; line-height:1.2;
        padding:6px 10px; margin-left:6px;
      }
      #mobilescan-app .ms-info-pill-sig{ display:inline-flex; align-items:center; gap:6px; }
      #mobilescan-app .ms-op-spinner{
        width:12px; height:12px; margin-left:6px;
        border-radius:50%;
        border:2px solid rgba(0,0,0,0.25);
        border-top-color:#3b82f6;
        display:inline-block;
        animation: ms-spin 0.8s linear infinite;
      }
      #mobilescan-app .ms-op-spinner-hidden{ visibility:hidden; }
      #mobilescan-app .ms-modal-spinner{
        width:14px; height:14px;
        border-radius:50%;
        border:2px solid rgba(0,0,0,0.25);
        border-top-color:#3b82f6;
        display:inline-block;
        animation: ms-spin 0.8s linear infinite;
      }
      #mobilescan-app .ms-modal-icon-ok,
      #mobilescan-app .ms-modal-icon-err{
        width:28px; height:18px;
        border-radius:9px;
        display:inline-flex; align-items:center; justify-content:center;
        font-size:11px; font-weight:700;
        color:#fff; background:#16a34a;
      }
      #mobilescan-app .ms-modal-icon-err{ background:#dc2626; }
      @keyframes ms-spin { to { transform: rotate(360deg); } }
    `]);

    const scanBtn = el('button', { class: 'cbi-button cbi-button-action' }, ['Scan Network']);
    const connectBtn = el('button', { class: 'cbi-button cbi-button-positive', disabled: 'disabled', style: 'margin-left:10px;' }, ['Connect']);
    const revertBtn = el('button', { class: 'cbi-button cbi-button-neutral', style: 'margin-left:10px;' }, ['Auto Select Network']);
    const currentOpInfo = el('span', { class: 'cbi-button cbi-button-neutral ms-info-pill' }, [
      el('span', { id: 'ms-op-text' }, ['Current operator: --']),
      el('span', { id: 'ms-op-spin', class: 'ms-op-spinner ms-op-spinner-hidden' }, [''])
    ]);
    const currentSigWrap = el('span', { class: 'cbi-button cbi-button-neutral ms-info-pill ms-info-pill-sig' }, [
      el('span', {}, ['Signal:']),
      makeSignalIcon(0)
    ]);
    const spinner = el('span', { style: 'margin-left:10px; display:none;' }, ['?']);

    const tableWrap = el('div', { style: 'margin-top:15px;' }, []);
    const table = el('table', { class: 'table ms-table' }, []);
    tableWrap.appendChild(table);

    let tuples = [];
    let selectedIndex = -1;
    let selectedFirst = null;
    let selectedFourth = null; // PLMN
    let rowEls = [];
    let isScanning = false;
    let isBusyAction = false;

    function setBusyScan(state) {
      scanBtn.disabled = state;
      spinner.style.display = state ? 'inline' : 'none';
      isScanning = state;
    }

    function setBusyActionState(state) {
      isBusyAction = state;
      revertBtn.disabled = state;
      scanBtn.disabled = state || isScanning;
      if (state) connectBtn.disabled = true;
      else setConnectEnabledByRule();
    }

    function setConnectEnabledByRule() {
      if (isIntLike(selectedFirst)) {
        const v = toInt(selectedFirst);
        if (v >= 0 && v <= 2 && !isBusyAction && !isScanning)
          connectBtn.removeAttribute('disabled');
        else
          connectBtn.setAttribute('disabled', 'disabled');
      } else {
        connectBtn.setAttribute('disabled', 'disabled');
      }
    }

    function highlightRow(idx) {
      rowEls.forEach((tr, i) => tr && tr.classList.toggle('ms-selected', i === idx));
    }

    function updateSelection(idx) {
      const t = tuples[idx];
      if (!t) return;
      selectedIndex = idx;
      selectedFirst = t[0];
      selectedFourth = t[3];
      highlightRow(idx);
      setConnectEnabledByRule();
    }

    function renderTable() {
      table.innerHTML = '';
      rowEls = [];

      const thead = el('thead', {}, [
        el('tr', {}, [
          el('th', { class: 'col-select' }, ['Select']),
          el('th', { class: 'col-operator' }, ['Operator']),
          el('th', { class: 'col-plmn' }, ['PLMN']),
          el('th', { class: 'col-signal' }, ['Signal'])
        ])
      ]);

      const tbody = el('tbody');

      if (!tuples.length) {
        tbody.appendChild(el('tr', {}, [
          el('td', { colspan: '4', class: 'ms-empty' }, ['No scan results yet. Click "Scan Network".'])
        ]));
      } else {
        tuples.forEach((t, i) => {
          const plmn = t[3] ?? '';
          const signal = t[4];
          const name = operatorNameFromTuple(t);

          const radio = el('input', { type: 'radio', name: 'mobnet_choice', value: String(i) });
          if (i === selectedIndex) radio.checked = true;

          const tr = el('tr', { style: 'cursor:pointer;' }, [
            el('td', { class: 'col-select' }, [radio]),
            el('td', { class: 'col-operator' }, [String(name)]),
            el('td', { class: 'col-plmn' }, [String(plmn)]),
            el('td', { class: 'col-signal' }, [makeSignalIcon(signal)])
          ]);

          rowEls[i] = tr;
          if (i === selectedIndex) tr.classList.add('ms-selected');

          tr.addEventListener('click', function () { radio.checked = true; updateSelection(i); });
          radio.addEventListener('change', function () { if (radio.checked) updateSelection(i); });

          tbody.appendChild(tr);
        });
      }

      table.appendChild(thead);
      table.appendChild(tbody);
    }

    renderTable();

    async function doScan() {
      if (isScanning || isBusyAction) {
        modal.start('Please wait... operation in progress.', REQUEST_TIMEOUT_MS, 'Busy');
        setTimeout(() => modal.stop(true), 2200);
        return;
      }

      modal.start('Scanning mobile networks... waiting for modem response', REQUEST_TIMEOUT_MS, 'Scanning');

      try {
        setBusyScan(true);

        tuples = [];
        selectedIndex = -1;
        selectedFirst = null;
        selectedFourth = null;
        highlightRow(-1);
        setConnectEnabledByRule();
        renderTable();

        const res = await request.get(luciUrl('admin/network/mobilescan/scan'), { cache: false, timeout: REQUEST_TIMEOUT_MS });
        const json = res.json();

        if (!json || json.ok !== true) {
          modal.update(`Scan failed: ${json?.error || 'unknown error'}`, 'Error', 'error');
          setTimeout(() => modal.stop(true), 4500);
          return;
        }

        const responseText = extractModemResponse(json);
        tuples = parseCopsResponse(responseText);

        renderTable();

        if (!tuples.length) {
          modal.update('Scan finished but no networks were found (or parse failed).', 'Error', 'error');
          setTimeout(() => modal.stop(true), 4500);
          return;
        }

        modal.update(`Scan complete: found ${tuples.length} network(s).`, 'Done', 'ok');
        setTimeout(() => modal.stop(true), 2800);
      } catch (e) {
        modal.update(`Scan error: ${prettyError(e)}`, 'Error', 'error');
        setTimeout(() => modal.stop(true), 4500);
      } finally {
        setBusyScan(false);
        setConnectEnabledByRule();
      }
    }

    async function doConnect() {
      if (isBusyAction || isScanning) {
        modal.start('Please wait... another operation is running.', REQUEST_TIMEOUT_MS, 'Busy');
        setTimeout(() => modal.stop(true), 2200);
        return;
      }

      if (connectBtn.hasAttribute('disabled')) {
        modal.start('Connect is disabled (selection rule).', REQUEST_TIMEOUT_MS, 'Info');
        setTimeout(() => modal.stop(true), 2500);
        return;
      }

      const plmn = String(selectedFourth ?? '').trim();
      if (!plmn) {
        modal.start('No operator selected.', REQUEST_TIMEOUT_MS, 'Error');
        setTimeout(() => modal.stop(true), 3200);
        return;
      }

      const selectedTuple = tuples[selectedIndex];
      const opName = operatorNameFromTuple(selectedTuple);

      modal.start(`Connecting to ${opName}... waiting for OK`, REQUEST_TIMEOUT_MS, 'Connecting');

      try {
        setBusyActionState(true);

        // 1) Connect
        const url = luciUrl('admin/network/mobilescan/connect') + '?plmn=' + encodeURIComponent(plmn);
        const res = await request.get(url, { cache: false, timeout: REQUEST_TIMEOUT_MS });
        const json = res.json();

        if (!json || json.ok !== true) {
          modal.update(`Connect failed (${opName}): ${json?.error || 'unknown error'}`, 'Error', 'error');
          setTimeout(() => modal.stop(true), 5200);
          return;
        }

        const resp1 = extractModemResponse(json);
        if (!responseHasOK(resp1)) {
          modal.update(`Connect did not return OK (${opName}). Auto-connect NOT enabled.`, 'Error', 'error');
          setTimeout(() => modal.stop(true), 5200);
          return;
        }

        // 2) Auto-connect (only after OK)
        modal.update(`Connected to ${opName}. Enabling auto-connect... waiting for reply`, 'Auto-connect', 'working');

        const res2 = await request.get(luciUrl('admin/network/mobilescan/set_auto_connect'), { cache: false, timeout: REQUEST_TIMEOUT_MS });
        const json2 = res2.json();

        if (!json2 || json2.ok !== true) {
          modal.update(`Auto-connect failed (${opName}): ${json2?.error || 'unknown error'}`, 'Error', 'error');
          setTimeout(() => modal.stop(true), 5200);
          return;
        }

        const resp2 = extractModemResponse(json2);
        if (resp2 && !responseHasOK(resp2)) {
          modal.update(`Auto-connect reply not OK (${opName}).`, 'Error', 'error');
          setTimeout(() => modal.stop(true), 5200);
          return;
        }

        modal.update(`Connected to ${opName} and auto-connect enabled.`, 'Done', 'ok');
        setTimeout(() => modal.stop(true), 3200);
      } catch (e) {
        modal.update(`Connect error (${opName}): ${prettyError(e)}`, 'Error', 'error');
        setTimeout(() => modal.stop(true), 5200);
      } finally {
        setBusyActionState(false);
        setConnectEnabledByRule();
      }
    }

    async function doAutoSelectNetwork() {
      if (isBusyAction || isScanning) {
        modal.start('Please wait... another operation is running.', REQUEST_TIMEOUT_MS, 'Busy');
        setTimeout(() => modal.stop(true), 2200);
        return;
      }

      modal.start('Auto select network: starting...', REQUEST_TIMEOUT_MS, 'Auto Select');

      try {
        setBusyActionState(true);

        const cmds = ['AT+COPS=0', 'AT+CFUN=0', 'AT+CFUN=1'];

        for (let i = 0; i < cmds.length; i++) {
          const cmd = cmds[i];
          modal.update(`Sending ${cmd}\nWaiting for OK...`, 'Auto Select');

          const url = luciUrl('admin/network/mobilescan/at') + '?cmd=' + encodeURIComponent(cmd);
          const res = await request.get(url, { cache: false, timeout: REQUEST_TIMEOUT_MS });
          const json = res.json();

          if (!json || json.ok !== true) {
          modal.update(`Failed: ${cmd}\n${json?.error || 'unknown error'}`, 'Error', 'error');
          setTimeout(() => modal.stop(true), 6000);
          return;
          }

          const resp = extractModemResponse(json);
          if (!responseHasOK(resp)) {
          modal.update(`No OK reply for: ${cmd}\nStopping to avoid errors.`, 'Error', 'error');
          setTimeout(() => modal.stop(true), 6500);
          return;
          }
        }

        // 2) Auto-connect (after OKs)
        modal.update('Auto select complete. Enabling auto-connect...', 'Auto-connect', 'working');
        const res2 = await request.get(luciUrl('admin/network/mobilescan/set_auto_connect'), { cache: false, timeout: REQUEST_TIMEOUT_MS });
        const json2 = res2.json();
        if (!json2 || json2.ok !== true) {
          modal.update(`Auto-connect failed: ${json2?.error || 'unknown error'}`, 'Error', 'error');
          setTimeout(() => modal.stop(true), 5200);
          return;
        }
        const resp2 = extractModemResponse(json2);
        if (resp2 && !responseHasOK(resp2)) {
          modal.update('Auto-connect reply not OK.', 'Error', 'error');
          setTimeout(() => modal.stop(true), 5200);
          return;
        }

        modal.update('Auto select network complete (all commands returned OK).', 'Done', 'ok');
        await refreshCurrentOperator();
        setTimeout(() => modal.stop(true), 3400);
      } catch (e) {
        modal.update(`Auto select error: ${prettyError(e)}`, 'Error', 'error');
        setTimeout(() => modal.stop(true), 5200);
      } finally {
        setBusyActionState(false);
        setConnectEnabledByRule();
      }
    }

    let lastOpName = 'Current operator: --';
    let lastSigIcon = makeSignalIcon(0);

    function setInfoLoading(isLoading) {
      const spin = currentOpInfo.querySelector('#ms-op-spin');
      if (spin) spin.classList.toggle('ms-op-spinner-hidden', !isLoading);
    }

    async function refreshCurrentOperator() {
      if (isScanning || isBusyAction) return;
      setInfoLoading(true);
      try {
        const url = luciUrl('admin/network/mobilescan/at') + '?cmd=' + encodeURIComponent('AT+COPS?');
        const res = await request.get(url, { cache: false, timeout: REQUEST_TIMEOUT_MS });
        const json = res.json();
        if (!json || json.ok !== true) {
          currentOpInfo.textContent = 'Current operator: error';
          return;
        }
        const resp = extractModemResponse(json);
        const name = parseCopsCurrentOperator(resp);
        lastOpName = 'Current operator: ' + (name || 'unknown');
        const opText = currentOpInfo.querySelector('#ms-op-text');
        if (opText) opText.textContent = lastOpName;

        const urlSig = luciUrl('admin/network/mobilescan/at') + '?cmd=' + encodeURIComponent('AT+CSQ');
        const resSig = await request.get(urlSig, { cache: false, timeout: REQUEST_TIMEOUT_MS });
        const jsonSig = resSig.json();
        if (!jsonSig || jsonSig.ok !== true) {
          return;
        }
        const respSig = extractModemResponse(jsonSig);
        const sig = parseCopsSignal(respSig);
        if (sig !== null) {
          lastSigIcon = makeSignalIcon(sig);
          currentSigWrap.replaceChildren(
            el('span', {}, ['Signal:']),
            lastSigIcon
          );
        }
      } catch (e) {
        currentOpInfo.textContent = 'Current operator: error';
      } finally {
        setInfoLoading(false);
      }
    }

    scanBtn.addEventListener('click', doScan);
    connectBtn.addEventListener('click', doConnect);
    revertBtn.addEventListener('click', doAutoSelectNetwork);

    root.appendChild(style);
    root.appendChild(modalOverlay);
    root.appendChild(el('div', { style: 'margin-top:10px; display:flex; align-items:center; flex-wrap:wrap; gap:8px;' }, [
      scanBtn,
      connectBtn,
      revertBtn,
      spinner,
      currentOpInfo,
      currentSigWrap
    ]));
    root.appendChild(tableWrap);

    refreshCurrentOperator();
    setInterval(refreshCurrentOperator, 30000);

    return root;
  }
});
