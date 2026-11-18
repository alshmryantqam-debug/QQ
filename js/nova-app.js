/* ==========================================================================
   NOVA ROUTER MANAGER ENTERPRISE v5.0 - 100% REAL LIVE MIKROTIK WISP ENGINE
   Zero Fake Data | Separate PPPoE & Hotspot Portals | Real Live Telemetry
   ========================================================================== */

const NovaState = {
  currentPortal: 0, // 0:Home, 1:NetworkMap, 2:PPPoE, 3:Hotspot, 4:Tools, 5:Monitoring, 6:Settings
  pppoeTab: 'secrets', // secrets | active | profiles
  hotspotTab: 'users', // users | active | profiles | bindings
  routerConfig: {
    host: '',
    apiPort: '8728',
    restPort: '80',
    useHttps: false,
    user: 'admin',
    pass: '',
    wan1Iface: 'ether1',
    wan2Iface: 'ether2',
    lanIface: 'bridge',
    connected: false,
    mode: 'DISCONNECTED', // NATIVE_TCP_8728 | REST_API_V7 | DISCONNECTED
    boardName: '--',
    version: '--'
  },
  savedRouters: [],
  telemetry: {
    cpu: 0,
    ram: 0,
    temp: '--',
    voltage: '--',
    uptime: '--',
    dlMbps: 0.0,
    ulMbps: 0.0,
    wan1Mbps: 0.0,
    wan2Mbps: 0.0,
    wan1Running: false,
    wan2Running: false,
    lanRunning: false,
    historyDl: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    historyUl: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  },
  // 100% Real Router Data Arrays (Empty until fetched from MikroTik!)
  interfaces: {},
  pppSecrets: [],
  pppActive: [],
  pppProfiles: [],
  hsUsers: [],
  hsActive: [],
  hsProfiles: [],
  hsBindings: [],
  neighbors: [],
  dhcpLeases: [],
  queues: [],
  firewallRules: [],
  logs: [],
  lastBatchVouchers: [],
  commandLog: []
};

// Load saved router credentials list (no fake subscribers!)
(function initSavedRouters() {
  try {
    const savedList = localStorage.getItem('nova_v5_saved_routers');
    if (savedList) NovaState.savedRouters = JSON.parse(savedList);
    const lastCfg = localStorage.getItem('nova_v5_last_router');
    if (lastCfg) {
      const parsed = JSON.parse(lastCfg);
      Object.assign(NovaState.routerConfig, parsed, { connected: false, mode: 'DISCONNECTED' });
    }
  } catch (_) {}
})();

function saveRouterListToStorage() {
  try {
    localStorage.setItem('nova_v5_saved_routers', JSON.stringify(NovaState.savedRouters));
    localStorage.setItem('nova_v5_last_router', JSON.stringify(NovaState.routerConfig));
  } catch (_) {}
}

// ==========================================================================
// REAL MIKROTIK ROUTEROS API & REST v7 ENGINE (ZERO MOCK FALLBACK)
// ==========================================================================
const PendingRpc = {};
let rpcCounter = 1;
let browserPollTimer = null;
const browserLastRx = {};
const browserLastTx = {};
let browserLastPollTime = null;

window.onNovaNativeResponse = function(responseObj) {
  if (!responseObj || !responseObj.reqId) return;
  const resolver = PendingRpc[responseObj.reqId];
  if (resolver) {
    delete PendingRpc[responseObj.reqId];
    resolver(responseObj);
  }
};

async function executeRouterOS(apiWords, restSpec = null) {
  const cmdString = apiWords.join(' ');
  const timestamp = new Date().toLocaleTimeString('en-GB');
  NovaState.commandLog.unshift(`[${timestamp}] > ${cmdString}`);
  if (NovaState.commandLog.length > 80) NovaState.commandLog.pop();

  // 1. Native Android APK TCP Socket (Port 8728)
  if (window.NovaNative && window.NovaNative.postMessage) {
    return new Promise((resolve) => {
      const reqId = 'req_' + (rpcCounter++);
      PendingRpc[reqId] = resolve;
      window.NovaNative.postMessage(JSON.stringify({
        reqId: reqId,
        action: 'EXEC_COMMAND',
        words: apiWords,
        rest: restSpec
      }));
      setTimeout(() => {
        if (PendingRpc[reqId]) {
          delete PendingRpc[reqId];
          resolve({ ok: false, error: 'انتهت مهلة الاتصال بالراوتر (Timeout)', rows: [] });
        }
      }, 6000);
    });
  }

  // 2. Direct RouterOS v7 REST API (HTTP/HTTPS)
  const cfg = NovaState.routerConfig;
  if (!cfg.host) {
    return { ok: false, error: 'الرجاء الاتصال بالراوتر أولاً', rows: [] };
  }

  try {
    const scheme = cfg.useHttps ? 'https' : 'http';
    const portPart = (cfg.restPort && cfg.restPort !== '80' && cfg.restPort !== '443') ? `:${cfg.restPort}` : '';
    let endpoint = restSpec ? restSpec.path : apiWords[0];
    let method = restSpec ? restSpec.method : 'GET';
    let bodyObj = restSpec ? restSpec.body : null;

    if (!restSpec) {
      if (endpoint.endsWith('/print')) {
        endpoint = endpoint.replace('/print', '');
        method = 'GET';
      } else {
        method = 'POST';
        bodyObj = {};
        for (let i = 1; i < apiWords.length; i++) {
          const w = apiWords[i];
          if (w.startsWith('=')) {
            const eq = w.indexOf('=', 1);
            if (eq !== -1) bodyObj[w.substring(1, eq)] = w.substring(eq + 1);
          }
        }
      }
    }

    const auth = btoa(`${cfg.user}:${cfg.pass}`);
    const fetchOpts = {
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    };
    if (bodyObj && method !== 'GET') fetchOpts.body = JSON.stringify(bodyObj);

    const res = await fetch(`${scheme}://${cfg.host}${portPart}/rest${endpoint}`, fetchOpts);
    if (res.ok) {
      const data = await res.json().catch(() => []);
      const rows = Array.isArray(data) ? data : [data];
      return { ok: true, mode: 'REST_API_V7', rows: rows };
    } else {
      const errTxt = await res.text().catch(() => `HTTP ${res.status}`);
      return { ok: false, error: `خطأ من الراوتر (${res.status}): ${errTxt}`, rows: [] };
    }
  } catch (err) {
    return { ok: false, error: `تعذر الوصول للراوتر (${cfg.host}): تأكد من الاتصال بالشبكة وتفعيل API/REST`, rows: [] };
  }
}

// ==========================================================================
// ROUTER LOGIN GATE & CONNECTION LIFECYCLE
// ==========================================================================
function openLoginGate() {
  const gate = document.getElementById('loginGateOverlay');
  if (gate) gate.classList.remove('hidden');
  renderSavedRoutersList();
}

function closeLoginGate() {
  const gate = document.getElementById('loginGateOverlay');
  if (gate) gate.classList.add('hidden');
}

function renderSavedRoutersList() {
  const box = document.getElementById('savedRoutersContainer');
  if (!box) return;
  if (!NovaState.savedRouters.length) {
    box.innerHTML = '<div style="font-size:11.5px;color:#8da4c8;text-align:center;padding:6px;">لا توجد راوترات محفوظة بعد — أدخل بيانات الراوتر بالأسفل للاتصال</div>';
    return;
  }
  box.innerHTML = NovaState.savedRouters.map((r, idx) => `
    <div class="saved-router-item" onclick="fillSavedRouter(${idx})">
      <div>
        <div style="font-size:13px;font-weight:800;color:#fff;">${r.title || r.host}</div>
        <div style="font-size:11px;color:#00e5ff;font-family:Inter;">${r.user}@${r.host}:${r.apiPort}</div>
      </div>
      <div style="display:flex;gap:6px;">
        <button class="mini-act-btn" onclick="event.stopPropagation();fillSavedRouter(${idx});connectToRealMikroTik();">اتصال</button>
        <button class="mini-act-btn danger" onclick="event.stopPropagation();deleteSavedRouter(${idx});">✕</button>
      </div>
    </div>
  `).join('');
}

function fillSavedRouter(idx) {
  const r = NovaState.savedRouters[idx];
  if (!r) return;
  document.getElementById('loginHost').value = r.host || '';
  document.getElementById('loginApiPort').value = r.apiPort || '8728';
  document.getElementById('loginRestPort').value = r.restPort || '80';
  document.getElementById('loginUser').value = r.user || 'admin';
  document.getElementById('loginPass').value = r.pass || '';
  document.getElementById('loginWan1').value = r.wan1Iface || 'ether1';
  document.getElementById('loginWan2').value = r.wan2Iface || 'ether2';
  document.getElementById('loginLan').value = r.lanIface || 'bridge';
}

function deleteSavedRouter(idx) {
  NovaState.savedRouters.splice(idx, 1);
  saveRouterListToStorage();
  renderSavedRoutersList();
}

async function connectToRealMikroTik() {
  const host = document.getElementById('loginHost').value.trim();
  const apiPort = document.getElementById('loginApiPort').value.trim() || '8728';
  const restPort = document.getElementById('loginRestPort').value.trim() || '80';
  const user = document.getElementById('loginUser').value.trim() || 'admin';
  const pass = document.getElementById('loginPass').value;
  const wan1 = document.getElementById('loginWan1').value.trim() || 'ether1';
  const wan2 = document.getElementById('loginWan2').value.trim() || 'ether2';
  const lan = document.getElementById('loginLan').value.trim() || 'bridge';
  const msgEl = document.getElementById('loginStatusMsg');

  if (!host) {
    if (msgEl) {
      msgEl.style.display = 'block';
      msgEl.style.color = '#ff5277';
      msgEl.textContent = '⚠️ الرجاء إدخال عنوان IP الراوتر أولاً (مثال: 192.168.88.1)';
    }
    return;
  }

  Object.assign(NovaState.routerConfig, {
    host, apiPort, restPort, user, pass,
    wan1Iface: wan1, wan2Iface: wan2, lanIface: lan
  });

  if (msgEl) {
    msgEl.style.display = 'block';
    msgEl.style.color = '#00e5ff';
    msgEl.textContent = `⏳ جاري الاتصال الحقيقي براوتر MikroTik (${host}:${apiPort})...`;
  }

  let connected = false;

  // 1. Try Native TCP 8728 if running in Android APK
  if (window.NovaNative && window.NovaNative.postMessage) {
    const nativeRes = await new Promise((resolve) => {
      const reqId = 'conn_' + (rpcCounter++);
      PendingRpc[reqId] = resolve;
      window.NovaNative.postMessage(JSON.stringify({
        reqId,
        action: 'CONNECT_MIKROTIK',
        host,
        port: parseInt(apiPort, 10) || 8728,
        restPort: parseInt(restPort, 10) || 80,
        user,
        pass
      }));
      setTimeout(() => {
        if (PendingRpc[reqId]) {
          delete PendingRpc[reqId];
          resolve({ ok: false, error: 'Timeout' });
        }
      }, 6000);
    });
    if (nativeRes && nativeRes.ok) {
      connected = true;
      NovaState.routerConfig.mode = 'NATIVE_TCP_8728';
    }
  }

  // 2. If not connected via Native TCP, try REST API (/rest/system/resource)
  if (!connected) {
    const restRes = await executeRouterOS(['/system/resource/print']);
    if (restRes && restRes.ok && restRes.rows && restRes.rows.length > 0) {
      connected = true;
      NovaState.routerConfig.mode = 'REST_API_V7';
      startBrowserLivePolling();
    } else {
      if (msgEl) {
        msgEl.style.color = '#ff5277';
        msgEl.textContent = `❌ فشل الاتصال بالراوتر (${host}): ${restRes.error || 'تأكد من عنوان IP وكلمة المرور وتفعيل خدمة API 8728 أو www'}`;
      }
      return;
    }
  }

  NovaState.routerConfig.connected = true;

  // Save router in savedRouters list
  const existingIdx = NovaState.savedRouters.findIndex(r => r.host === host && r.user === user);
  const entry = { title: `MikroTik (${host})`, host, apiPort, restPort, user, pass, wan1Iface: wan1, wan2Iface: wan2, lanIface: lan };
  if (existingIdx >= 0) NovaState.savedRouters[existingIdx] = entry;
  else NovaState.savedRouters.unshift(entry);
  saveRouterListToStorage();

  if (msgEl) {
    msgEl.style.color = '#00e676';
    msgEl.textContent = `✓ تم الاتصال الفعلي براوتر ${host} بنجاح! جاري سحب البيانات الحية...`;
  }

  updateConnectionHeaderUI();
  closeLoginGate();
  await syncAllRealRouterData();
}

async function disconnectFromRouter() {
  if (browserPollTimer) clearInterval(browserPollTimer);
  if (window.NovaNative && window.NovaNative.postMessage) {
    window.NovaNative.postMessage(JSON.stringify({ action: 'DISCONNECT_MIKROTIK' }));
  }
  NovaState.routerConfig.connected = false;
  NovaState.routerConfig.mode = 'DISCONNECTED';
  NovaState.pppSecrets = [];
  NovaState.pppActive = [];
  NovaState.hsUsers = [];
  NovaState.hsActive = [];
  updateConnectionHeaderUI();
  openLoginGate();
}

function startBrowserLivePolling() {
  if (browserPollTimer) clearInterval(browserPollTimer);
  browserPollTimer = setInterval(async () => {
    if (!NovaState.routerConfig.connected) return;
    const now = Date.now();
    const elapsedSec = browserLastPollTime ? ((now - browserLastPollTime) / 1000.0) : 2.0;
    browserLastPollTime = now;

    const sys = await executeRouterOS(['/system/resource/print']);
    const hlth = await executeRouterOS(['/system/health/print']);
    const ifaces = await executeRouterOS(['/interface/print']);

    if (sys.ok && sys.rows.length) {
      const r = sys.rows[0];
      const freeMem = parseFloat(r['free-memory'] || 0);
      const totalMem = parseFloat(r['total-memory'] || 1);
      const ramPct = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0;

      let temp = '--';
      let volt = '--';
      if (hlth.ok && hlth.rows.length) {
        hlth.rows.forEach(h => {
          const n = (h.name || '').toLowerCase();
          if (n.includes('temp')) temp = h.value;
          if (n.includes('volt')) volt = h.value;
          if (h['temperature']) temp = h['temperature'];
          if (h['voltage']) volt = h['voltage'];
        });
      }

      const ifaceMap = {};
      if (ifaces.ok && ifaces.rows.length) {
        ifaces.rows.forEach(f => {
          const name = f.name;
          if (!name) return;
          const rxB = parseInt(f['rx-byte'] || 0, 10);
          const txB = parseInt(f['tx-byte'] || 0, 10);
          let rxMbps = 0;
          let txMbps = 0;
          if (browserLastRx[name] !== undefined && elapsedSec > 0.2) {
            const dRx = rxB - browserLastRx[name];
            const dTx = txB - browserLastTx[name];
            if (dRx >= 0) rxMbps = (dRx * 8.0) / (elapsedSec * 1000000.0);
            if (dTx >= 0) txMbps = (dTx * 8.0) / (elapsedSec * 1000000.0);
          }
          browserLastRx[name] = rxB;
          browserLastTx[name] = txB;
          ifaceMap[name] = {
            name,
            type: f.type || '',
            running: f.running === 'true' || f.running === true,
            disabled: f.disabled === 'true' || f.disabled === true,
            rxMbps: parseFloat(rxMbps.toFixed(1)),
            txMbps: parseFloat(txMbps.toFixed(1)),
            rxBytes: rxB,
            txBytes: txB
          };
        });
      }

      window.onMikroTikLiveTelemetry({
        cpu: r['cpu-load'] || 0,
        ram: ramPct,
        uptime: r['uptime'] || '--',
        boardName: r['board-name'] || 'MikroTik',
        version: r['version'] || '',
        temp,
        voltage: volt,
        interfaces: ifaceMap
      });
    }
  }, 2000);
}

// ==========================================================================
// LIVE TELEMETRY STREAM HANDLER (UPDATES ALL UI GAUGES, CARDS & GRAPHS)
// ==========================================================================
window.onMikroTikLiveTelemetry = function(data) {
  if (!data) return;
  NovaState.routerConfig.connected = true;
  if (data.boardName) NovaState.routerConfig.boardName = data.boardName;
  if (data.version) NovaState.routerConfig.version = data.version;

  const t = NovaState.telemetry;
  if (data.cpu !== undefined) t.cpu = parseInt(data.cpu, 10) || 0;
  if (data.ram !== undefined) t.ram = parseInt(data.ram, 10) || 0;
  if (data.temp !== undefined) t.temp = data.temp;
  if (data.voltage !== undefined) t.voltage = data.voltage;
  if (data.uptime !== undefined) t.uptime = data.uptime;

  if (data.interfaces) {
    NovaState.interfaces = data.interfaces;
    const cfg = NovaState.routerConfig;
    const w1 = data.interfaces[cfg.wan1Iface];
    const w2 = data.interfaces[cfg.wan2Iface];
    const lan = data.interfaces[cfg.lanIface];

    t.wan1Mbps = w1 ? parseFloat((w1.rxMbps + w1.txMbps).toFixed(1)) : 0.0;
    t.wan1Running = w1 ? w1.running : false;

    t.wan2Mbps = w2 ? parseFloat((w2.rxMbps + w2.txMbps).toFixed(1)) : 0.0;
    t.wan2Running = w2 ? w2.running : false;

    if (lan) {
      // On LAN interface, TX is traffic going to subscribers (Download) and RX is Upload from subscribers
      t.dlMbps = lan.txMbps;
      t.ulMbps = lan.rxMbps;
      t.lanRunning = lan.running;
    } else {
      t.dlMbps = parseFloat(((w1 ? w1.rxMbps : 0) + (w2 ? w2.rxMbps : 0)).toFixed(1));
      t.ulMbps = parseFloat(((w1 ? w1.txMbps : 0) + (w2 ? w2.txMbps : 0)).toFixed(1));
    }

    t.historyDl.push(t.dlMbps);
    t.historyUl.push(t.ulMbps);
    if (t.historyDl.length > 12) t.historyDl.shift();
    if (t.historyUl.length > 12) t.historyUl.shift();
  }

  updateLiveDashboardDOM();
};

function updateConnectionHeaderUI() {
  const isConn = NovaState.routerConfig.connected;
  const pill = document.getElementById('homeConnPill');
  const dot = document.getElementById('homeConnDot');
  const txt = document.getElementById('homeConnText');
  if (txt) {
    txt.textContent = isConn
      ? `متصل: ${NovaState.routerConfig.host} (${NovaState.routerConfig.boardName})`
      : 'غير متصل بالراوتر — اضغط للاتصال';
  }
  if (dot) {
    dot.className = isConn ? 'live-badge-pulse' : 'live-badge-pulse offline';
  }
  if (pill) {
    pill.style.borderColor = isConn ? 'rgba(0, 230, 118, 0.85)' : 'rgba(255, 42, 84, 0.85)';
  }
}

function updateLiveDashboardDOM() {
  updateConnectionHeaderUI();
  const t = NovaState.telemetry;
  const cfg = NovaState.routerConfig;

  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt('cpuVal1', t.cpu + '%');
  setTxt('ramVal1', t.ram + '%');
  setTxt('tempVal1', t.temp !== '--' ? (t.temp + '°C') : '--');
  setTxt('voltVal1', t.voltage !== '--' ? (t.voltage + 'V') : '--');

  setTxt('dlSpeed1', t.dlMbps.toFixed(1));
  setTxt('ulSpeed1', t.ulMbps.toFixed(1));

  // Provider cards on Screen 1 & Topology Map on Screen 2
  setTxt('wan1Name1', cfg.wan1Iface);
  setTxt('wan1Status1', t.wan1Running ? 'متصل' : 'مفصول');
  setTxt('wan1Speed1', t.wan1Mbps.toFixed(1) + ' Mbps');

  setTxt('wan2Name1', cfg.wan2Iface);
  setTxt('wan2Status1', t.wan2Running ? 'متصل' : 'مفصول');
  setTxt('wan2Speed1', t.wan2Mbps.toFixed(1) + ' Mbps');

  setTxt('lanName1', cfg.lanIface);
  setTxt('lanStatus1', t.lanRunning ? 'نشط' : '--');

  // Topology Map labels
  setTxt('topoWan1Name', cfg.wan1Iface);
  setTxt('topoWan1Speed', t.wan1Mbps.toFixed(1) + ' Mbps');
  setTxt('topoWan2Name', cfg.wan2Iface);
  setTxt('topoWan2Speed', t.wan2Mbps.toFixed(1) + ' Mbps');
  setTxt('topoRouterModel', cfg.boardName !== '--' ? cfg.boardName : 'MikroTik');

  // Monitoring Screen 5 gauges
  setTxt('monCpuVal', t.cpu + '%');
  setTxt('monRamVal', t.ram + '%');
  setTxt('monTempVal', t.temp !== '--' ? (t.temp + '°C') : '--');
  setTxt('monActiveTotal', (NovaState.pppActive.length + NovaState.hsActive.length).toString());
}

// ==========================================================================
// SYNC ALL REAL DATA FROM MIKROTIK (PPPoE, HOTSPOT, NEIGHBORS, QUEUES, LOGS)
// ==========================================================================
async function syncAllRealRouterData() {
  if (!NovaState.routerConfig.connected) return;

  const [pppSec, pppAct, pppProf, hsUsr, hsAct, hsProf, hsBind] = await Promise.all([
    executeRouterOS(['/ppp/secret/print']),
    executeRouterOS(['/ppp/active/print']),
    executeRouterOS(['/ppp/profile/print']),
    executeRouterOS(['/ip/hotspot/user/print']),
    executeRouterOS(['/ip/hotspot/active/print']),
    executeRouterOS(['/ip/hotspot/user/profile/print']),
    executeRouterOS(['/ip/hotspot/ip-binding/print'])
  ]);

  if (pppSec.ok) NovaState.pppSecrets = pppSec.rows.filter(r => r.name);
  if (pppAct.ok) NovaState.pppActive = pppAct.rows.filter(r => r.name);
  if (pppProf.ok) NovaState.pppProfiles = pppProf.rows.filter(r => r.name);

  if (hsUsr.ok) NovaState.hsUsers = hsUsr.rows.filter(r => r.name);
  if (hsAct.ok) NovaState.hsActive = hsAct.rows.filter(r => r.user || r.name);
  if (hsProf.ok) NovaState.hsProfiles = hsProf.rows.filter(r => r.name);
  if (hsBind.ok) NovaState.hsBindings = hsBind.rows.filter(r => r['mac-address'] || r.address);

  renderPPPoEPortal();
  renderHotspotPortal();
  updateLiveDashboardDOM();
}

// ==========================================================================
// PORTAL 2: DEDICATED BROADBAND (PPPoE) PORTAL (البرودباند مستقل بالكامل)
// ==========================================================================
function switchPPPoETab(tab, btnEl) {
  NovaState.pppoeTab = tab;
  if (btnEl) {
    btnEl.parentElement.querySelectorAll('.action-chip').forEach(b => b.classList.remove('active'));
    btnEl.classList.add('active');
  }
  renderPPPoEPortal();
}

function renderPPPoEPortal(searchQuery = '', statusFilter = '') {
  const listEl = document.getElementById('pppoeListContainer');
  if (!listEl) return;

  // Update real counters
  const activeMap = {};
  NovaState.pppActive.forEach(a => { activeMap[a.name] = a; });

  const totalSecrets = NovaState.pppSecrets.length;
  const onlineCount = NovaState.pppActive.length;
  const disabledCount = NovaState.pppSecrets.filter(s => s.disabled === 'true' || s.disabled === true).length;
  const profilesCount = NovaState.pppProfiles.length;

  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt('pppCntActive', onlineCount);
  setTxt('pppCntTotal', totalSecrets);
  setTxt('pppCntDisabled', disabledCount);
  setTxt('pppCntProfiles', profilesCount);

  if (!NovaState.routerConfig.connected) {
    listEl.innerHTML = `
      <div class="empty-live-state">
        ⚠️ غير متصل بالراوتر حالياً.<br>اضغط على زر الاتصال لإدخال IP الراوتر وسحب حسابات البرودباند PPPoE الحقيقية.
        <br><button class="btn-neon-blue" style="margin:10px auto 0;width:80%;" onclick="openLoginGate()">اتصال بالراوتر الآن</button>
      </div>`;
    return;
  }

  const q = searchQuery.trim().toLowerCase();

  if (NovaState.pppoeTab === 'profiles') {
    if (!NovaState.pppProfiles.length) {
      listEl.innerHTML = '<div class="empty-live-state">لا توجد باقات PPPoE في الراوتر حالياً.</div>';
      return;
    }
    listEl.innerHTML = NovaState.pppProfiles.map(p => `
      <div class="sub-item-card" onclick="openEditPPPoEProfile('${p.name}')">
        <div>
          <div class="sub-name">${p.name}</div>
          <div style="font-size:11px;color:#8da4c8;font-family:Inter;">Local: ${p['local-address'] || 'auto'} | Pool: ${p['remote-address'] || 'auto'}</div>
        </div>
        <div style="text-align:left;">
          <span class="status-mini-pill green" style="font-family:Inter;">${p['rate-limit'] || 'Unlimited'}</span>
        </div>
      </div>
    `).join('');
    return;
  }

  if (NovaState.pppoeTab === 'active') {
    if (!NovaState.pppActive.length) {
      listEl.innerHTML = '<div class="empty-live-state">لا توجد جلسات PPPoE نشطة حالياً في /ppp/active</div>';
      return;
    }
    listEl.innerHTML = NovaState.pppActive.filter(a => !q || (a.name && a.name.toLowerCase().includes(q)) || (a.address && a.address.includes(q))).map(a => {
      const ifaceName = `<pppoe-${a.name}>`;
      const ifaceStats = NovaState.interfaces[ifaceName] || { rxMbps: 0.0, txMbps: 0.0 };
      return `
        <div class="sub-item-card">
          <div>
            <div class="sub-name">${a.name}</div>
            <div style="font-size:11px;color:#00e5ff;font-family:Inter;">IP: ${a.address || '--'} | MAC: ${a['caller-id'] || '--'}</div>
            <div style="font-size:10.5px;color:#8da4c8;font-family:Inter;">Uptime: ${a.uptime || '0s'}</div>
          </div>
          <div style="text-align:left;">
            <div style="font-family:Inter;font-size:11.5px;color:#00e676;">↓ ${ifaceStats.txMbps}M / ↑ ${ifaceStats.rxMbps}M</div>
            <button class="mini-act-btn danger" style="margin-top:4px;" onclick="kickRealPPPoE('${a['.id'] || a.name}')">طرد الجلسة</button>
          </div>
        </div>
      `;
    }).join('');
    return;
  }

  // Default: 'secrets' tab
  const filtered = NovaState.pppSecrets.filter(s => {
    const isOnline = !!activeMap[s.name];
    const isDis = s.disabled === 'true' || s.disabled === true;
    if (statusFilter === 'active' && !isOnline) return false;
    if (statusFilter === 'disabled' && !isDis) return false;
    if (!q) return true;
    return (s.name && s.name.toLowerCase().includes(q)) ||
           (s.comment && s.comment.toLowerCase().includes(q)) ||
           (s['caller-id'] && s['caller-id'].toLowerCase().includes(q));
  });

  if (!filtered.length) {
    listEl.innerHTML = '<div class="empty-live-state">لا توجد حسابات مطابقة في /ppp/secret</div>';
    return;
  }

  listEl.innerHTML = filtered.map(s => {
    const act = activeMap[s.name];
    const isDis = s.disabled === 'true' || s.disabled === true;
    const stLabel = isDis ? 'معطل' : (act ? 'متصل الآن' : 'غير متصل');
    const stClass = isDis ? 'red' : (act ? 'green' : 'amber');
    const avClass = isDis ? 'red' : (act ? 'blue' : 'amber');
    const ifaceStats = NovaState.interfaces[`<pppoe-${s.name}>`] || { rxMbps: 0.0, txMbps: 0.0 };

    return `
      <div class="sub-item-card" onclick="openRealPPPoESecretModal('${s.name}')">
        <div class="sub-left">
          <div class="avatar-circle ${avClass}">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6.5 8-6.5s8 2.5 8 6.5"/></svg>
          </div>
          <div class="sub-name-wrap" style="align-items:flex-start;">
            <div class="sub-name">${s.name}</div>
            <div style="font-size:10.5px;color:#8da4c8;">${s.profile || 'default'} ${s.comment ? ('| ' + s.comment) : ''}</div>
            <span class="status-mini-pill ${stClass}">${stLabel}</span>
          </div>
        </div>
        <div class="sub-speeds" style="text-align:left;">
          <div style="color:#00e676;">↓ ${act ? ifaceStats.txMbps : '0.0'} Mbps</div>
          <div style="color:#00e5ff;">↑ ${act ? ifaceStats.rxMbps : '0.0'} Mbps</div>
          <div style="font-size:10px;color:#c5d8f0;">${act ? (act.address || '') : (s['caller-id'] || '')}</div>
        </div>
      </div>
    `;
  }).join('');
}

async function kickRealPPPoE(idOrName) {
  await executeRouterOS(['/ppp/active/remove', `=numbers=${idOrName}`]);
  await syncAllRealRouterData();
}

function openRealPPPoESecretModal(secretName) {
  const s = NovaState.pppSecrets.find(x => x.name === secretName);
  if (!s) return;
  const act = NovaState.pppActive.find(a => a.name === secretName);
  const isDis = s.disabled === 'true' || s.disabled === true;
  const profOpts = NovaState.pppProfiles.map(p =>
    `<option value="${p.name}" ${p.name === s.profile ? 'selected' : ''}>${p.name} (${p['rate-limit'] || 'Unlimited'})</option>`
  ).join('');

  openSubPortal(`تحكم برودباند PPPoE: ${s.name}`, `
    <div class="portal-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div>
          <div style="font-size:16px;font-weight:800;color:#fff;">${s.name}</div>
          <div style="font-size:11.5px;color:#00e5ff;font-family:Inter;">IP: ${act ? act.address : (s['remote-address'] || 'Dynamic')} | Uptime: ${act ? act.uptime : 'Offline'}</div>
          <div style="font-size:11px;color:#8da4c8;font-family:Inter;">Caller-ID (MAC): ${act ? act['caller-id'] : (s['caller-id'] || 'غير مقفل')}</div>
        </div>
        <span class="status-mini-pill ${isDis ? 'red' : (act ? 'green' : 'amber')}">${isDis ? 'معطل' : (act ? 'متصل' : 'غير متصل')}</span>
      </div>

      <div class="action-chip-row">
        ${act ? `<button class="action-chip" onclick="kickRealPPPoE('${act['.id'] || s.name}');closeSubPortal();">⚡ طرد الجلسة الفورية</button>` : ''}
        ${act && act['caller-id'] ? `<button class="action-chip success" onclick="document.getElementById('editPppCallerId').value='${act['caller-id']}'">🔒 نسخ الماك المتصل لقفل الحساب</button>` : ''}
        <button class="action-chip danger" onclick="deleteRealPPPoESecret('${s['.id'] || s.name}')">🗑️ حذف المشترك من الراوتر</button>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">
        <div class="portal-form-group">
          <label class="portal-label">اسم المستخدم (Name)</label>
          <input type="text" class="portal-input" id="editPppName" value="${s.name}" />
        </div>
        <div class="portal-form-group">
          <label class="portal-label">كلمة المرور (Password)</label>
          <input type="text" class="portal-input" id="editPppPass" value="${s.password || ''}" />
        </div>
      </div>

      <div class="portal-form-group">
        <label class="portal-label">باقة السرعة (/ppp/profile)</label>
        <select class="portal-select" id="editPppProfile">${profOpts || `<option value="${s.profile || 'default'}">${s.profile || 'default'}</option>`}</select>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div class="portal-form-group">
          <label class="portal-label">قفل الماك (Caller-ID)</label>
          <input type="text" class="portal-input" id="editPppCallerId" value="${s['caller-id'] || ''}" placeholder="اتركه فارغاً لفتح الماك" />
        </div>
        <div class="portal-form-group">
          <label class="portal-label">الحالة (Disabled)</label>
          <select class="portal-select" id="editPppDisabled">
            <option value="no" ${!isDis ? 'selected' : ''}>مفعل (Enabled)</option>
            <option value="yes" ${isDis ? 'selected' : ''}>معطل / مفصول (Disabled)</option>
          </select>
        </div>
      </div>

      <div class="portal-form-group">
        <label class="portal-label">ملاحظات / تاريخ الانتهاء (Comment)</label>
        <input type="text" class="portal-input" id="editPppComment" value="${s.comment || ''}" placeholder="مثال: exp:2026-12-31 | هاتف: 09..." />
      </div>

      <button class="btn-green-neon" style="width:100%;margin-top:8px;" onclick="saveRealPPPoESecret('${s['.id'] || s.name}')">
        حفظ التعديلات في الراوتر (/ppp/secret/set)
      </button>
    </div>
  `);
}

async function saveRealPPPoESecret(idOrName) {
  const name = document.getElementById('editPppName').value.trim();
  const pass = document.getElementById('editPppPass').value;
  const prof = document.getElementById('editPppProfile').value;
  const caller = document.getElementById('editPppCallerId').value.trim();
  const dis = document.getElementById('editPppDisabled').value;
  const comment = document.getElementById('editPppComment').value.trim();

  await executeRouterOS([
    '/ppp/secret/set',
    `=numbers=${idOrName}`,
    `=name=${name}`,
    `=password=${pass}`,
    `=profile=${prof}`,
    `=caller-id=${caller}`,
    `=disabled=${dis}`,
    `=comment=${comment}`
  ]);
  closeSubPortal();
  await syncAllRealRouterData();
}

async function deleteRealPPPoESecret(idOrName) {
  await executeRouterOS(['/ppp/secret/remove', `=numbers=${idOrName}`]);
  closeSubPortal();
  await syncAllRealRouterData();
}

function openAddRealPPPoESecretModal() {
  const profOpts = NovaState.pppProfiles.map(p =>
    `<option value="${p.name}">${p.name} (${p['rate-limit'] || 'Unlimited'})</option>`
  ).join('');

  openSubPortal('إضافة مشترك برودباند حقيقي (/ppp/secret/add)', `
    <div class="portal-card">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div class="portal-form-group">
          <label class="portal-label">اسم المستخدم (Username)</label>
          <input type="text" class="portal-input" id="addPppName" placeholder="client1" />
        </div>
        <div class="portal-form-group">
          <label class="portal-label">كلمة المرور (Password)</label>
          <input type="text" class="portal-input" id="addPppPass" placeholder="123456" />
        </div>
      </div>
      <div class="portal-form-group">
        <label class="portal-label">باقة السرعة (Profile)</label>
        <select class="portal-select" id="addPppProfile">${profOpts || '<option value="default">default</option>'}</select>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div class="portal-form-group">
          <label class="portal-label">قفل الماك (Caller-ID اختياري)</label>
          <input type="text" class="portal-input" id="addPppCaller" placeholder="XX:XX:XX:XX:XX:XX" />
        </div>
        <div class="portal-form-group">
          <label class="portal-label">تاريخ الانتهاء / الاسم (Comment)</label>
          <input type="text" class="portal-input" id="addPppComment" placeholder="exp:2026-12-30" />
        </div>
      </div>
      <button class="btn-green-neon" style="width:100%;margin-top:8px;" onclick="submitAddRealPPPoESecret()">
        + إنشاء حساب PPPoE في الراوتر الآن
      </button>
    </div>
  `);
}

async function submitAddRealPPPoESecret() {
  const name = document.getElementById('addPppName').value.trim();
  const pass = document.getElementById('addPppPass').value;
  const prof = document.getElementById('addPppProfile').value;
  const caller = document.getElementById('addPppCaller').value.trim();
  const comment = document.getElementById('addPppComment').value.trim();
  if (!name) return;

  const words = [
    '/ppp/secret/add',
    `=name=${name}`,
    `=password=${pass}`,
    '=service=pppoe',
    `=profile=${prof}`,
    `=comment=${comment}`
  ];
  if (caller) words.push(`=caller-id=${caller}`);

  await executeRouterOS(words);
  closeSubPortal();
  await syncAllRealRouterData();
}

function openAddRealPPPoEProfileModal() {
  openSubPortal('إنشاء باقة سرعة برودباند (/ppp/profile/add)', `
    <div class="portal-card">
      <div class="portal-form-group">
        <label class="portal-label">اسم الباقة (Profile Name)</label>
        <input type="text" class="portal-input" id="newPppProfName" placeholder="مثال: 15M-Unlimited" />
      </div>
      <div class="portal-form-group">
        <label class="portal-label">تحديد السرعة (Rate-Limit: RX/TX)</label>
        <input type="text" class="portal-input" id="newPppProfRate" placeholder="15M/15M" value="15M/15M" />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div class="portal-form-group">
          <label class="portal-label">Local Address</label>
          <input type="text" class="portal-input" id="newPppProfLocal" value="10.10.12.1" />
        </div>
        <div class="portal-form-group">
          <label class="portal-label">Remote Address (Pool)</label>
          <input type="text" class="portal-input" id="newPppProfRemote" placeholder="pool-pppoe" />
        </div>
      </div>
      <button class="btn-neon-blue" style="width:100%;margin-top:8px;" onclick="submitNewRealPPPoEProfile()">
        + حفظ الباقة في الراوتر
      </button>
    </div>
  `);
}

async function submitNewRealPPPoEProfile() {
  const name = document.getElementById('newPppProfName').value.trim();
  const rate = document.getElementById('newPppProfRate').value.trim();
  const local = document.getElementById('newPppProfLocal').value.trim();
  const remote = document.getElementById('newPppProfRemote').value.trim();
  if (!name) return;
  const cmd = ['/ppp/profile/add', `=name=${name}`, `=rate-limit=${rate}`];
  if (local) cmd.push(`=local-address=${local}`);
  if (remote) cmd.push(`=remote-address=${remote}`);
  await executeRouterOS(cmd);
  closeSubPortal();
  await syncAllRealRouterData();
}

// ==========================================================================
// PORTAL 3: DEDICATED HOTSPOT & VOUCHERS PORTAL (الهوتسبوت مستقل بالكامل)
// ==========================================================================
function switchHotspotTab(tab, btnEl) {
  NovaState.hotspotTab = tab;
  if (btnEl) {
    btnEl.parentElement.querySelectorAll('.action-chip').forEach(b => b.classList.remove('active'));
    btnEl.classList.add('active');
  }
  renderHotspotPortal();
}

function renderHotspotPortal(searchQuery = '') {
  const listEl = document.getElementById('hotspotListContainer');
  if (!listEl) return;

  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt('hsCntActive', NovaState.hsActive.length);
  setTxt('hsCntTotal', NovaState.hsUsers.length);
  const expiredUsers = NovaState.hsUsers.filter(u =>
    (u['limit-uptime'] && u.uptime === u['limit-uptime']) || u.disabled === 'true' || u.disabled === true
  ).length;
  setTxt('hsCntExpired', expiredUsers);
  setTxt('hsCntProfiles', NovaState.hsProfiles.length);

  if (!NovaState.routerConfig.connected) {
    listEl.innerHTML = `
      <div class="empty-live-state">
        ⚠️ غير متصل بالراوتر حالياً.<br>اضغط للاتصال بالراوتر وسحب كروت الهوتسبوت والنشطين والبروفايلات الحقيقية.
        <br><button class="btn-neon-blue" style="margin:10px auto 0;width:80%;" onclick="openLoginGate()">اتصال بالراوتر الآن</button>
      </div>`;
    return;
  }

  const q = searchQuery.trim().toLowerCase();

  if (NovaState.hotspotTab === 'active') {
    if (!NovaState.hsActive.length) {
      listEl.innerHTML = '<div class="empty-live-state">لا يوجد مستخدمون نشطون حالياً في /ip/hotspot/active</div>';
      return;
    }
    listEl.innerHTML = NovaState.hsActive.filter(a => {
      const u = (a.user || a.name || '').toLowerCase();
      return !q || u.includes(q) || (a.address && a.address.includes(q));
    }).map(a => {
      const rxMb = ((parseInt(a['bytes-out'] || 0, 10)) / (1024 * 1024)).toFixed(1);
      const txMb = ((parseInt(a['bytes-in'] || 0, 10)) / (1024 * 1024)).toFixed(1);
      return `
        <div class="sub-item-card">
          <div>
            <div class="sub-name">كارت: ${a.user || a.name}</div>
            <div style="font-size:11px;color:#00e5ff;font-family:Inter;">IP: ${a.address || '--'} | MAC: ${a['mac-address'] || '--'}</div>
            <div style="font-size:10.5px;color:#8da4c8;font-family:Inter;">Uptime: ${a.uptime || '0s'} | سحب: ${rxMb} MB</div>
          </div>
          <div>
            <button class="mini-act-btn danger" onclick="kickRealHotspotActive('${a['.id']}')">طرد</button>
          </div>
        </div>
      `;
    }).join('');
    return;
  }

  if (NovaState.hotspotTab === 'profiles') {
    listEl.innerHTML = NovaState.hsProfiles.map(p => `
      <div class="sub-item-card">
        <div>
          <div class="sub-name">${p.name}</div>
          <div style="font-size:11px;color:#8da4c8;font-family:Inter;">الأجهزة المشتركة (Shared-Users): ${p['shared-users'] || '1'}</div>
        </div>
        <span class="status-mini-pill green" style="font-family:Inter;">${p['rate-limit'] || 'Unlimited'}</span>
      </div>
    `).join('') + `
      <button class="btn-purple-neon" style="width:100%;margin-top:8px;" onclick="openAddRealHotspotProfileModal()">+ إضافة بروفايل هوتسبوت جديد</button>
    `;
    return;
  }

  if (NovaState.hotspotTab === 'bindings') {
    listEl.innerHTML = (NovaState.hsBindings.map(b => `
      <div class="sub-item-card">
        <div>
          <div class="sub-name">${b.comment || b['mac-address'] || 'Device'}</div>
          <div style="font-size:11px;color:#00e5ff;font-family:Inter;">MAC: ${b['mac-address'] || '--'} | IP: ${b.address || 'any'}</div>
        </div>
        <span class="status-mini-pill ${b.type === 'bypassed' ? 'green' : (b.type === 'blocked' ? 'red' : 'amber')}">${b.type || 'regular'}</span>
      </div>
    `).join('')) + `
      <button class="btn-neon-blue" style="width:100%;margin-top:8px;" onclick="openAddIpBindingModal()">+ تخطي أو حظر جهاز بالماك (IP-Binding)</button>
    `;
    return;
  }

  // Default: 'users' tab (/ip/hotspot/user)
  const activeUsersSet = new Set(NovaState.hsActive.map(a => a.user || a.name));
  const filtered = NovaState.hsUsers.filter(u => !q || (u.name && u.name.toLowerCase().includes(q)) || (u.comment && u.comment.toLowerCase().includes(q)));

  if (!filtered.length) {
    listEl.innerHTML = '<div class="empty-live-state">لا توجد كروت/حسابات في /ip/hotspot/user حالياً</div>';
    return;
  }

  listEl.innerHTML = filtered.map(u => {
    const isAct = activeUsersSet.has(u.name);
    const isDis = u.disabled === 'true' || u.disabled === true;
    const dlMb = ((parseInt(u['bytes-out'] || 0, 10)) / (1024 * 1024)).toFixed(1);
    return `
      <div class="sub-item-card" onclick="openRealHotspotUserModal('${u.name}')">
        <div class="sub-left">
          <div class="avatar-circle ${isDis ? 'red' : (isAct ? 'blue' : 'amber')}">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1.5"/></svg>
          </div>
          <div class="sub-name-wrap" style="align-items:flex-start;">
            <div class="sub-name">${u.name}</div>
            <div style="font-size:10.5px;color:#8da4c8;">${u.profile || 'default'} | استهلاك: ${dlMb} MB</div>
            <span class="status-mini-pill ${isDis ? 'red' : (isAct ? 'green' : 'amber')}">${isDis ? 'معطل' : (isAct ? 'نشط الآن' : 'جاهز')}</span>
          </div>
        </div>
        <div style="text-align:left;font-family:Inter;font-size:11px;color:#c5d8f0;">
          <div>الوقت: ${u.uptime || '0s'}</div>
          <div style="color:#00e5ff;">الحد: ${u['limit-uptime'] || 'مفتوح'}</div>
        </div>
      </div>
    `;
  }).join('');
}

async function kickRealHotspotActive(id) {
  await executeRouterOS(['/ip/hotspot/active/remove', `=numbers=${id}`]);
  await syncAllRealRouterData();
}

function openRealHotspotUserModal(userName) {
  const u = NovaState.hsUsers.find(x => x.name === userName);
  if (!u) return;
  const isDis = u.disabled === 'true' || u.disabled === true;
  openSubPortal(`إدارة كارت هوتسبوت: ${u.name}`, `
    <div class="portal-card">
      <div style="font-size:14px;font-weight:800;color:#00e5ff;margin-bottom:6px;">الكارت / المستخدم: ${u.name}</div>
      <div style="font-size:12px;color:#d0e4ff;margin-bottom:10px;">
        البروفايل: ${u.profile || 'default'} | الوقت المستهلك: ${u.uptime || '0s'} | الحد: ${u['limit-uptime'] || 'غير محدد'}
      </div>
      <div class="action-chip-row">
        <button class="action-chip success" onclick="executeRouterOS(['/ip/hotspot/user/reset-counters', '=numbers=${u['.id'] || u.name}']);closeSubPortal();syncAllRealRouterData();">🔄 تصفير عدادات الكارت</button>
        <button class="action-chip warn" onclick="executeRouterOS(['/ip/hotspot/user/set', '=numbers=${u['.id'] || u.name}', '=disabled=${isDis ? 'no' : 'yes'}']);closeSubPortal();syncAllRealRouterData();">${isDis ? '✓ تفعيل الكارت' : '⏸️ إيقاف الكارت'}</button>
        <button class="action-chip danger" onclick="executeRouterOS(['/ip/hotspot/user/remove', '=numbers=${u['.id'] || u.name}']);closeSubPortal();syncAllRealRouterData();">🗑️ حذف الكارت</button>
      </div>
    </div>
  `);
}

// Mikhmon-Style Batch Voucher Generator directly into /ip/hotspot/user/add
function openQuickCardsPortal() {
  const hsOpts = NovaState.hsProfiles.map(p => `<option value="${p.name}">${p.name} (${p['rate-limit'] || 'Unlimited'})</option>`).join('');
  const vouchersHtml = NovaState.lastBatchVouchers.map(v => `
    <div class="qr-voucher-card">
      <div style="font-family:Orbitron;font-size:11px;color:#00e5ff;font-weight:800;">NOVA HOTSPOT</div>
      <div style="font-size:10px;color:#d0e4ff;">${v.profile}</div>
      <div style="font-family:Inter;font-size:14px;font-weight:900;color:#00e676;margin:4px 0;">User: ${v.code}</div>
      <div style="font-family:Inter;font-size:12px;color:#80f8ff;">Pass: ${v.pass}</div>
      <div style="font-size:10px;color:#b8cde8;margin-top:2px;">الوقت: ${v.uptime || 'مفتوح'} | الكوتا: ${v.quotaGb ? (v.quotaGb + ' GB') : 'مفتوح'}</div>
    </div>
  `).join('');

  openSubPortal('مولد كروت الهوتسبوت الاحترافي (Mikhmon Style)', `
    <div class="portal-card">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div class="portal-form-group">
          <label class="portal-label">العدد (Quantity)</label>
          <input type="number" class="portal-input" id="vchCount" value="10" min="1" max="200" />
        </div>
        <div class="portal-form-group">
          <label class="portal-label">البادئة (Prefix اختياري)</label>
          <input type="text" class="portal-input" id="vchPrefix" placeholder="مثال: N-" />
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div class="portal-form-group">
          <label class="portal-label">نوع الكارت</label>
          <select class="portal-select" id="vchMode">
            <option value="same">اسم المستخدم = كلمة المرور (كود واحد)</option>
            <option value="diff">اسم مستخدم + كلمة مرور مختلفة</option>
          </select>
        </div>
        <div class="portal-form-group">
          <label class="portal-label">البروفايل (/ip/hotspot/user/profile)</label>
          <select class="portal-select" id="vchProfile">${hsOpts || '<option value="default">default</option>'}</select>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div class="portal-form-group">
          <label class="portal-label">مدة الصلاحية (Limit-Uptime)</label>
          <input type="text" class="portal-input" id="vchUptime" placeholder="مثال: 1d أو 30d 00:00:00" value="30d" />
        </div>
        <div class="portal-form-group">
          <label class="portal-label">الجيجات المسموحة (GB اختياري)</label>
          <input type="number" class="portal-input" id="vchQuotaGb" placeholder="اتركه فارغاً للمفتوح" />
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
        <button class="btn-purple-neon" onclick="generateRealBatchVouchers()">⚡ توليد وإرسال للراوتر</button>
        <button class="btn-neon-blue" onclick="window.print()">🖨️ طباعة الكروت</button>
      </div>
      <div id="vchGenStatus" style="font-size:12px;color:#00e676;margin-bottom:8px;"></div>
      <div class="qr-voucher-grid">${vouchersHtml}</div>
    </div>
  `);
}

async function generateRealBatchVouchers() {
  const count = parseInt(document.getElementById('vchCount').value, 10) || 10;
  const prefix = document.getElementById('vchPrefix').value.trim();
  const mode = document.getElementById('vchMode').value;
  const profile = document.getElementById('vchProfile').value;
  const uptime = document.getElementById('vchUptime').value.trim();
  const quotaGb = parseFloat(document.getElementById('vchQuotaGb').value || '0');
  const statusEl = document.getElementById('vchGenStatus');

  if (statusEl) statusEl.textContent = `⏳ جاري إنشاء ${count} كارت في الراوتر...`;
  NovaState.lastBatchVouchers = [];
  const batchComment = `batch-${new Date().toISOString().slice(0, 10)}`;

  for (let i = 0; i < count; i++) {
    const randCode = prefix + String(Math.floor(100000 + Math.random() * 899999));
    const randPass = mode === 'same' ? randCode : String(Math.floor(1000 + Math.random() * 8999));
    const cmd = [
      '/ip/hotspot/user/add',
      `=name=${randCode}`,
      `=password=${randPass}`,
      `=profile=${profile}`,
      `=comment=${batchComment}`
    ];
    if (uptime) cmd.push(`=limit-uptime=${uptime}`);
    if (quotaGb > 0) {
      const bytesTotal = Math.round(quotaGb * 1073741824);
      cmd.push(`=limit-bytes-total=${bytesTotal}`);
    }
    await executeRouterOS(cmd);
    NovaState.lastBatchVouchers.push({ code: randCode, pass: randPass, profile, uptime, quotaGb });
  }

  await syncAllRealRouterData();
  openQuickCardsPortal();
}

function openAddSingleHotspotUserModal() {
  const hsOpts = NovaState.hsProfiles.map(p => `<option value="${p.name}">${p.name}</option>`).join('');
  openSubPortal('إضافة كارت / مستخدم هوتسبوت مفرد', `
    <div class="portal-card">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div class="portal-form-group">
          <label class="portal-label">اسم الكارت / المستخدم</label>
          <input type="text" class="portal-input" id="singleHsUser" />
        </div>
        <div class="portal-form-group">
          <label class="portal-label">كلمة المرور</label>
          <input type="text" class="portal-input" id="singleHsPass" />
        </div>
      </div>
      <div class="portal-form-group">
        <label class="portal-label">البروفايل</label>
        <select class="portal-select" id="singleHsProf">${hsOpts || '<option value="default">default</option>'}</select>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div class="portal-form-group">
          <label class="portal-label">المدة (Limit-Uptime)</label>
          <input type="text" class="portal-input" id="singleHsUptime" placeholder="30d" />
        </div>
        <div class="portal-form-group">
          <label class="portal-label">الكوتا بالجيجا (GB)</label>
          <input type="number" class="portal-input" id="singleHsQuota" placeholder="اختياري" />
        </div>
      </div>
      <button class="btn-green-neon" style="width:100%;margin-top:8px;" onclick="submitSingleHotspotUser()">+ إضافة الكارت للراوتر</button>
    </div>
  `);
}

async function submitSingleHotspotUser() {
  const u = document.getElementById('singleHsUser').value.trim();
  const p = document.getElementById('singleHsPass').value.trim();
  const prof = document.getElementById('singleHsProf').value;
  const up = document.getElementById('singleHsUptime').value.trim();
  const qGb = parseFloat(document.getElementById('singleHsQuota').value || '0');
  if (!u) return;
  const cmd = ['/ip/hotspot/user/add', `=name=${u}`, `=password=${p}`, `=profile=${prof}`];
  if (up) cmd.push(`=limit-uptime=${up}`);
  if (qGb > 0) cmd.push(`=limit-bytes-total=${Math.round(qGb * 1073741824)}`);
  await executeRouterOS(cmd);
  closeSubPortal();
  await syncAllRealRouterData();
}

function openAddRealHotspotProfileModal() {
  openSubPortal('إنشاء بروفايل هوتسبوت (/ip/hotspot/user/profile/add)', `
    <div class="portal-c
