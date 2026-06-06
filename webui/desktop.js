/* ============================================================
   Zamolxis desktop shell — vanilla JS, no build step.
   Window manager + taskbar + Start menu + apps.
   Apps ARE agents. Zamolxis is the default app and hosts the
   main chat. "Has a chat window" is a per-app setting.
   Talks to the existing backend: WS /?cid=..&token=.. and /api/*.
   ============================================================ */
(function () {
  'use strict';

  // ---------- icons ----------
  var ICON = {
    zamolxis: "<svg viewBox='0 0 32 32'><polygon points='16,2 29,9 29,23 16,30 3,23 3,9' fill='#b8893f'/><polygon points='16,2 29,9 29,23 16,30 3,23 3,9' fill='none' stroke='#e8c87a' stroke-width='1'/><text x='16' y='22' font-size='15' text-anchor='middle' fill='#1a150d' font-family='Segoe UI,Arial' font-weight='700'>Z</text></svg>",
    settings: "<svg viewBox='0 0 24 24' fill='none' stroke='#3a3a3a' stroke-width='1.6'><circle cx='12' cy='12' r='3.2'/><path d='M19.4 13a7.8 7.8 0 0 0 0-2l2-1.5-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1l-.4-2.6H9.1l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4L2.6 11a7.8 7.8 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.6h4.9l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4z'/></svg>",
    agent: "<svg viewBox='0 0 24 24' fill='none' stroke='#2b6fd6' stroke-width='1.6'><rect x='4' y='8' width='16' height='12' rx='2.5'/><circle cx='9' cy='14' r='1.4' fill='#2b6fd6' stroke='none'/><circle cx='15' cy='14' r='1.4' fill='#2b6fd6' stroke='none'/><path d='M12 4v4M8 20v1.5M16 20v1.5'/></svg>",
    newagent: "<svg viewBox='0 0 24 24' fill='none' stroke='#2e9e3f' stroke-width='1.7'><circle cx='12' cy='12' r='9'/><path d='M12 8v8M8 12h8'/></svg>"
  };

  // Per-agent app icon: a colored rounded tile with the agent's initial (deterministic from the name).
  function hashHue(s) { var h = 0; for (var i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
  function agentIconSvg(name) {
    var ch = ((name || '?').trim().charAt(0) || '?').toUpperCase();
    var hue = hashHue(name || 'a'), hue2 = (hue + 40) % 360, gid = 'ag' + hue + '_' + ch.charCodeAt(0);
    return "<svg viewBox='0 0 24 24'><defs><linearGradient id='" + gid + "' x1='0' y1='0' x2='1' y2='1'>" +
      "<stop offset='0' stop-color='hsl(" + hue + ",68%,56%)'/><stop offset='1' stop-color='hsl(" + hue2 + ",68%,44%)'/></linearGradient></defs>" +
      "<rect x='2' y='2' width='20' height='20' rx='5.5' fill='url(#" + gid + ")'/>" +
      "<text x='12' y='16.5' font-size='12' font-weight='700' text-anchor='middle' fill='#fff' font-family='Segoe UI,Arial'>" + ch + "</text></svg>";
  }

  // ---------- helpers ----------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function api(path, opts) { return fetch(path, opts).then(function (r) { return r.json(); }); }
  function uuid() { return (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'c' + Date.now() + Math.random().toString(16).slice(2); }
  var AGENT_NAME = (document.title || 'Zamolxis').trim() || 'Zamolxis';

  // ---------- OS theme ----------
  function detectOS() {
    var p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '').toLowerCase();
    if (p.indexOf('mac') !== -1 || p.indexOf('iphone') !== -1 || p.indexOf('ipad') !== -1) return 'mac';
    if (p.indexOf('linux') !== -1 || p.indexOf('ubuntu') !== -1 || p.indexOf('x11') !== -1) return 'ubuntu';
    return 'win';
  }
  function themeChoice() { return localStorage.getItem('zx_os') || 'auto'; }
  function applyTheme() {
    var choice = themeChoice();
    var eff = choice === 'auto' ? detectOS() : choice;
    document.body.dataset.os = eff;
    return { choice: choice, effective: eff };
  }
  function setTheme(choice) { localStorage.setItem('zx_os', choice); applyTheme(); rerenderSettings(); }

  // light/dark mode (auto follows the OS via prefers-color-scheme)
  function modeChoice() { return localStorage.getItem('zx_mode') || 'auto'; }
  function resolveMode(c) { if (c === 'light') return 'light'; if (c === 'dark') return 'dark'; return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'; }
  function applyMode() { var c = modeChoice(); document.body.dataset.mode = resolveMode(c); return c; }
  function setMode(c) { localStorage.setItem('zx_mode', c); applyMode(); rerenderSettings(); }

  // ============================================================
  // Window Manager
  // ============================================================
  var winLayer = $('#windows');
  var zTop = 100;
  var wins = {};            // instanceId -> win
  var openByApp = {};       // appId -> instanceId (for singletons)
  var seq = 0;

  function focusWin(w) {
    Object.keys(wins).forEach(function (k) { wins[k].root.classList.remove('focused'); });
    w.root.classList.add('focused');
    w.root.style.zIndex = ++zTop;
    w.minimized = false; w.root.classList.remove('minimized');
    var nm = document.getElementById('tb-appname'); if (nm) nm.textContent = w._appTitle || w.titleEl.textContent || 'Desktop';
    syncTaskbar();
    saveSession();
  }

  function makeWindow(spec) {
    // spec: {appId, title, iconSvg, w, h, onMount(body,win), onClose(win)}
    var id = 'w' + (++seq);
    var root = el('div', 'window');
    root.style.width = (spec.w || 720) + 'px';
    root.style.height = (spec.h || 520) + 'px';
    var offset = (Object.keys(wins).length % 6) * 28;
    root.style.left = Math.max(20, (window.innerWidth - (spec.w || 720)) / 2 + offset) + 'px';
    root.style.top = Math.max(20, (window.innerHeight - (spec.h || 520)) / 2 - 30 + offset) + 'px';

    var bar = el('div', 'titlebar');
    var ticon = el('div', 't-icon', spec.iconSvg || '');
    var title = el('div', 't-title', spec.title || 'App');
    var ctrls = el('div', 'win-controls');
    var bMin = el('button', 'min', "<span class='g'></span>"); bMin.title = 'Minimize';
    var bMax = el('button', 'max', "<span class='g'></span>"); bMax.title = 'Maximize';
    var bClose = el('button', 'close', "<span class='g'></span>"); bClose.title = 'Close';
    ctrls.appendChild(bMin); ctrls.appendChild(bMax); ctrls.appendChild(bClose);
    bar.appendChild(ticon); bar.appendChild(title); bar.appendChild(ctrls);

    var body = el('div', 'win-body');
    root.appendChild(bar); root.appendChild(body);
    ['n','s','e','w','ne','nw','se','sw'].forEach(function (d) { root.appendChild(el('div', 'rsz ' + d)); });

    var w = { id: id, appId: spec.appId, root: root, body: body, titleEl: title, minimized: false, maximized: false, prev: null, onClose: spec.onClose, cleanup: [] };
    wins[id] = w;
    winLayer.appendChild(root);

    root.addEventListener('mousedown', function () { focusWin(w); });
    bMin.addEventListener('click', function (e) { e.stopPropagation(); w.minimized = true; root.classList.add('minimized'); syncTaskbar(); saveSession(); });
    bMax.addEventListener('click', function (e) { e.stopPropagation(); toggleMax(w); });
    bClose.addEventListener('click', function (e) { e.stopPropagation(); closeWin(w); });
    bar.addEventListener('dblclick', function () { toggleMax(w); });
    enableDrag(w, bar);
    enableResize(w);

    if (spec.onMount) spec.onMount(body, w);
    focusWin(w);
    syncTaskbar();
    return w;
  }

  function toggleMax(w) {
    if (w.maximized) {
      w.root.classList.remove('maximized');
      if (w.prev) { w.root.style.left = w.prev.l; w.root.style.top = w.prev.t; w.root.style.width = w.prev.w; w.root.style.height = w.prev.h; }
      w.maximized = false;
    } else {
      w.prev = { l: w.root.style.left, t: w.root.style.top, w: w.root.style.width, h: w.root.style.height };
      w.root.classList.add('maximized');
      var os = document.body.dataset.os;
      var tb = os === 'ubuntu' ? 28 : (os === 'mac' ? 26 : 0);
      var bb = os === 'win' ? 48 : (os === 'mac' ? 88 : 0);
      var lb = os === 'ubuntu' ? 64 : 0;
      w.root.style.left = lb + 'px'; w.root.style.top = tb + 'px';
      w.root.style.width = (window.innerWidth - lb) + 'px';
      w.root.style.height = (window.innerHeight - tb - bb) + 'px';
      w.maximized = true;
    }
    saveSession();
  }

  function closeWin(w) {
    try { if (w.onClose) w.onClose(w); } catch (e) {}
    w.cleanup.forEach(function (fn) { try { fn(); } catch (e) {} });
    w.root.remove();
    delete wins[w.id];
    Object.keys(openByApp).forEach(function (a) { if (openByApp[a] === w.id) delete openByApp[a]; });
    syncTaskbar();
    saveSession();
  }

  function enableDrag(w, handle) {
    handle.addEventListener('mousedown', function (e) {
      if (e.target.closest('.win-controls')) return;
      if (w.maximized) return;
      e.preventDefault();
      var sx = e.clientX, sy = e.clientY;
      var sl = parseInt(w.root.style.left, 10), st = parseInt(w.root.style.top, 10);
      function mv(ev) {
        w.root.style.left = Math.max(-40, sl + (ev.clientX - sx)) + 'px';
        w.root.style.top = Math.max(0, st + (ev.clientY - sy)) + 'px';
      }
      function up() { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); saveSession(); }
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
  }

  function enableResize(w) {
    Array.prototype.forEach.call(w.root.querySelectorAll('.rsz'), function (h) {
      h.addEventListener('mousedown', function (e) {
        if (w.maximized) return;
        e.preventDefault(); e.stopPropagation();
        var dir = h.className.replace('rsz ', '');
        var sx = e.clientX, sy = e.clientY;
        var sl = parseInt(w.root.style.left, 10), st = parseInt(w.root.style.top, 10);
        var sw = w.root.offsetWidth, sh = w.root.offsetHeight;
        function mv(ev) {
          var dx = ev.clientX - sx, dy = ev.clientY - sy;
          if (dir.indexOf('e') !== -1) w.root.style.width = Math.max(320, sw + dx) + 'px';
          if (dir.indexOf('s') !== -1) w.root.style.height = Math.max(200, sh + dy) + 'px';
          if (dir.indexOf('w') !== -1) { var nw = Math.max(320, sw - dx); w.root.style.width = nw + 'px'; w.root.style.left = (sl + (sw - nw)) + 'px'; }
          if (dir.indexOf('n') !== -1) { var nh = Math.max(200, sh - dy); w.root.style.height = nh + 'px'; w.root.style.top = (st + (sh - nh)) + 'px'; }
        }
        function up() { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); saveSession(); }
        document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
      });
    });
  }

  // ============================================================
  // Taskbar + Start menu
  // ============================================================
  var taskApps = $('#taskbar-apps');
  function syncTaskbar() {
    taskApps.innerHTML = '';
    // pinned: Zamolxis always; plus any running window not already pinned
    var shown = {};
    var order = [];
    order.push({ appId: 'zamolxis', iconSvg: ICON.zamolxis, title: AGENT_NAME });
    shown.zamolxis = true;
    Object.keys(wins).forEach(function (k) {
      var w = wins[k];
      if (!shown[w.appId]) { shown[w.appId] = true; order.push({ appId: w.appId, iconSvg: w._iconSvg || ICON.agent, title: w._appTitle || w.titleEl.textContent }); }
    });
    order.forEach(function (o) {
      var btn = el('button', 'tb-app', o.iconSvg);
      btn.title = o.title;
      var running = Object.keys(wins).some(function (k) { return wins[k].appId === o.appId; });
      var focused = Object.keys(wins).some(function (k) { return wins[k].appId === o.appId && wins[k].root.classList.contains('focused') && !wins[k].minimized; });
      if (focused) btn.classList.add('active'); else if (running) btn.classList.add('running');
      btn.addEventListener('click', function () { taskbarClick(o.appId); });
      taskApps.appendChild(btn);
    });
  }
  function taskbarClick(appId) {
    var inst = Object.keys(wins).filter(function (k) { return wins[k].appId === appId; });
    if (!inst.length) { launchApp(appId); return; }
    var w = wins[inst[0]];
    if (w.root.classList.contains('focused') && !w.minimized) { w.minimized = true; w.root.classList.add('minimized'); syncTaskbar(); }
    else focusWin(w);
  }

  var startMenu = $('#startmenu');
  function toggleStart() { startMenu.classList.toggle('hidden'); if (!startMenu.classList.contains('hidden')) { renderStart(); $('#start-search-input').value = ''; $('#start-search-input').focus(); } }
  function closeStart() { startMenu.classList.add('hidden'); }
  function renderStart(filter) {
    var wrap = $('#startmenu-apps'); wrap.innerHTML = '';
    var list = appList();
    if (filter) { var f = filter.toLowerCase(); list = list.filter(function (a) { return a.name.toLowerCase().indexOf(f) !== -1; }); }
    list.forEach(function (a) {
      var item = el('div', 'sm-app');
      item.appendChild(el('div', 'ico', a.iconSvg));
      item.appendChild(el('div', 'label', a.name));
      item.addEventListener('click', function () { closeStart(); launchApp(a.id); });
      wrap.appendChild(item);
    });
    if (!list.length) wrap.appendChild(el('div', 'empty', 'No apps match.'));
  }

  // ============================================================
  // App registry (Zamolxis default + Settings + New Agent + agents)
  // ============================================================
  var agents = []; // from /api/agents

  function builtinApps() {
    return [
      { id: 'zamolxis', name: AGENT_NAME, iconSvg: ICON.zamolxis, kind: 'builtin' },
      { id: 'settings', name: 'Settings', iconSvg: ICON.settings, kind: 'builtin' },
      { id: 'newagent', name: 'New Agent', iconSvg: ICON.newagent, kind: 'builtin' }
    ];
  }
  function appList() {
    var out = builtinApps();
    agents.forEach(function (a) {
      out.push({ id: 'agent:' + a.name, name: a.label || a.name, iconSvg: agentIconSvg(a.label || a.name), kind: 'agent', agent: a });
    });
    return out;
  }
  function appById(id) { var l = appList(); for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }

  // ---------- session persistence (open windows + geometry + state) ----------
  function saveSession() {
    try {
      var arr = Object.keys(wins).map(function (k) {
        var w = wins[k];
        var g = (w.maximized && w.prev) ? w.prev : { l: w.root.style.left, t: w.root.style.top, w: w.root.style.width, h: w.root.style.height };
        return { appId: w.appId, left: g.l, top: g.t, width: g.w, height: g.h, max: !!w.maximized, min: !!w.minimized, z: parseInt(w.root.style.zIndex, 10) || 100 };
      });
      arr.sort(function (a, b) { return a.z - b.z; });
      localStorage.setItem('zx_session', JSON.stringify(arr));
    } catch (e) {}
  }
  function restoreSession() {
    var arr = [];
    try { arr = JSON.parse(localStorage.getItem('zx_session') || '[]'); } catch (e) {}
    if (!arr.length) return false;
    arr.forEach(function (g) { launchApp(g.appId, g); });
    return Object.keys(wins).length > 0;
  }

  function launchApp(appId, geom) {
    var app = appById(appId);
    if (!app) return null;
    // singleton: focus if already open
    if (openByApp[appId] && wins[openByApp[appId]]) { focusWin(wins[openByApp[appId]]); return wins[openByApp[appId]]; }
    var spec;
    if (appId === 'zamolxis') spec = { appId: appId, title: AGENT_NAME, iconSvg: ICON.zamolxis, w: 460, h: 620, onMount: mountChat };
    else if (appId === 'settings') spec = { appId: appId, title: 'Settings', iconSvg: ICON.settings, w: 620, h: 520, onMount: mountSettings };
    else if (appId === 'newagent') spec = { appId: appId, title: 'New Agent', iconSvg: ICON.newagent, w: 460, h: 480, onMount: mountNewAgent };
    else if (app.kind === 'agent') spec = { appId: appId, title: app.name, iconSvg: app.iconSvg || agentIconSvg(app.name), w: 520, h: 560, onMount: function (b, w) { mountAgent(b, w, app.agent); } };
    if (!spec) return null;
    var w = makeWindow(spec);
    w._iconSvg = spec.iconSvg; w._appTitle = spec.title;
    openByApp[appId] = w.id;
    if (geom) {
      if (geom.left) w.root.style.left = geom.left;
      if (geom.top) w.root.style.top = geom.top;
      if (geom.width) w.root.style.width = geom.width;
      if (geom.height) w.root.style.height = geom.height;
      if (geom.max) toggleMax(w);
      if (geom.min) { w.minimized = true; w.root.classList.add('minimized'); }
    }
    syncTaskbar();
    saveSession();
    return w;
  }

  // ---------- chat transcript persistence (survives reload / interface switch) ----------
  function loadChatLog(key) { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return []; } }
  function pushChatLog(key, rec) { try { var a = loadChatLog(key); a.push(rec); if (a.length > 300) a = a.slice(a.length - 300); localStorage.setItem(key, JSON.stringify(a)); } catch (e) {} }

  // ---------- App: Chat (Zamolxis main chat) ----------
  function mountChat(body, win) {
    var cid = localStorage.getItem('zx_cid_main');
    if (!cid) { cid = uuid(); localStorage.setItem('zx_cid_main', cid); }
    buildChat(body, win, cid, { route: true });
  }

  function buildChat(body, win, cid, opts) {
    body.style.padding = '0';
    var logKey = 'zx_log_' + cid;
    var wrap = el('div', 'chat');
    var bar = el('div', 'chat-bar');
    bar.innerHTML = "<span>Route</span>";
    var sel = el('select');
    [['auto', 'Auto'], ['claude', 'Claude'], ['local', 'Local'], ['freecloud', 'Free cloud']].forEach(function (o) {
      var op = el('option'); op.value = o[0]; op.textContent = o[1]; sel.appendChild(op);
    });
    sel.value = localStorage.getItem('zx_route_' + cid) || 'auto';
    sel.addEventListener('change', function () { localStorage.setItem('zx_route_' + cid, sel.value); });
    var stat = el('span'); stat.style.marginLeft = 'auto'; stat.textContent = 'connecting...';
    if (opts && opts.route) bar.appendChild(sel);
    bar.appendChild(stat);

    var log = el('div', 'chat-log');
    var inputRow = el('div', 'chat-input');
    var ta = el('textarea'); ta.placeholder = 'Message ' + AGENT_NAME + '...';
    var send = el('button'); send.textContent = 'Send';
    inputRow.appendChild(ta); inputRow.appendChild(send);
    wrap.appendChild(bar); wrap.appendChild(log); wrap.appendChild(inputRow);
    body.appendChild(wrap);

    function addMsg(who, text, cls, via, persist) {
      var m = el('div', 'msg ' + cls);
      m.appendChild(el('div', 'who', who + (via ? ' · via ' + via : '')));
      var c = el('div'); c.textContent = text; m.appendChild(c);
      log.appendChild(m); log.scrollTop = log.scrollHeight;
      if (persist !== false) pushChatLog(logKey, { who: who, text: text, cls: cls, via: via });
      return c;
    }
    // restore the saved transcript for this conversation
    loadChatLog(logKey).forEach(function (r) { addMsg(r.who, r.text, r.cls, r.via, false); });

    // WebSocket
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    var sock, streamEl = null;
    function connect() {
      sock = new WebSocket(proto + '://' + location.host + '/?cid=' + encodeURIComponent(cid) + '&token=');
      sock.onopen = function () { stat.textContent = '● connected'; stat.style.color = '#2e9e3f'; };
      sock.onclose = function () { stat.textContent = '● reconnecting'; stat.style.color = '#d13438'; setTimeout(function () { if (!win.closed) connect(); }, 2500); };
      sock.onerror = function () { stat.textContent = '● error'; stat.style.color = '#d13438'; };
      sock.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'status') return;
        if (m.type === 'chunk') { if (!streamEl) streamEl = addMsg(AGENT_NAME, '', 'bot', null, false); streamEl.textContent += m.text; log.scrollTop = log.scrollHeight; return; }
        if (m.type === 'reply') { if (streamEl) { streamEl.textContent = m.text; streamEl = null; pushChatLog(logKey, { who: AGENT_NAME, text: m.text, cls: 'bot' }); } else { addMsg(AGENT_NAME, m.text, 'bot'); } stat.textContent = '● connected'; }
      };
    }
    connect();
    win.cleanup.push(function () { win.closed = true; try { sock.close(); } catch (e) {} });

    function doSend() {
      var t = ta.value.trim(); if (!t || !sock || sock.readyState !== WebSocket.OPEN) return;
      addMsg('You', t, 'user'); ta.value = ''; streamEl = null; stat.textContent = 'thinking...';
      var payload = { text: t, route: sel.value };
      sock.send(JSON.stringify(payload));
    }
    send.addEventListener('click', doSend);
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
    setTimeout(function () { ta.focus(); }, 50);
  }

  // ---------- App: Settings (tabbed, wired to the real backend) ----------
  function osName(o) { return o === 'mac' ? 'macOS' : (o === 'ubuntu' ? 'Ubuntu' : 'Windows'); }
  function postSettings(patch) { return api('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }); }
  function restartZam(btn, status) { if (btn) btn.disabled = true; if (status) status.textContent = 'Restarting...'; api('/api/restart', { method: 'POST' }).then(function () { setTimeout(function () { location.reload(); }, 4500); }).catch(function () { if (btn) btn.disabled = false; if (status) status.textContent = 'Failed.'; }); }
  function fld(labelTxt, node, hint) { var f = el('div', 'field'); f.appendChild(el('label', null, labelTxt)); if (hint) f.appendChild(el('div', 'hint', hint)); f.appendChild(node); return f; }
  function inp(val) { var i = el('input', 'inp'); i.style.width = '100%'; i.value = (val == null ? '' : val); return i; }

  var settingsRender = null;
  function mountSettings(body, win) {
    body.style.padding = '0';
    var state = { tab: 'appearance' };
    var wrap = el('div', 'settings-wrap');
    var nav = el('div', 'set-nav');
    var pane = el('div', 'set-pane');
    wrap.appendChild(nav); wrap.appendChild(pane); body.appendChild(wrap);
    var tabs = [['appearance', 'Appearance'], ['engine', 'Engine'], ['providers', 'Providers'], ['skills', 'Skills'], ['system', 'System']];
    function renderNav() { nav.innerHTML = ''; tabs.forEach(function (t) { var b = el('button', state.tab === t[0] ? 'active' : null, t[1]); b.addEventListener('click', function () { state.tab = t[0]; renderNav(); renderTab(); }); nav.appendChild(b); }); }
    function renderTab() {
      pane.innerHTML = '';
      if (state.tab === 'appearance') tabAppearance(pane);
      else if (state.tab === 'engine') tabEngine(pane);
      else if (state.tab === 'providers') tabProviders(pane);
      else if (state.tab === 'skills') tabSkills(pane);
      else tabSystem(pane);
    }
    settingsRender = function () { renderTab(); };
    win.cleanup.push(function () { settingsRender = null; });
    renderNav(); renderTab();
  }
  function rerenderSettings() { if (settingsRender) settingsRender(); }

  function tabAppearance(pane) {
    var t = applyTheme();
    var f = el('div', 'field');
    f.appendChild(el('label', null, 'Desktop style'));
    f.appendChild(el('div', 'hint', 'Auto follows your OS (detected: ' + osName(t.effective) + '). Override below.'));
    var seg = el('div', 'seg');
    [['auto', 'Auto'], ['win', 'Windows 11'], ['mac', 'macOS'], ['ubuntu', 'Ubuntu'], ['classic', 'Classic']].forEach(function (o) {
      var b = el('button', t.choice === o[0] ? 'active' : null, o[1]);
      b.addEventListener('click', function () { if (o[0] === 'classic') { location.href = '/classic'; } else { setTheme(o[0]); } });
      seg.appendChild(b);
    });
    f.appendChild(seg); pane.appendChild(f);
    pane.appendChild(el('div', 'hint', '"Classic" opens the previous stable Zamolxis interface (the last stable version), kept as a fourth option.'));

    var mc = modeChoice();
    var f2 = el('div', 'field');
    f2.appendChild(el('label', null, 'Appearance mode'));
    f2.appendChild(el('div', 'hint', 'Auto follows your system light/dark preference (now: ' + resolveMode(mc) + ').'));
    var seg2 = el('div', 'seg');
    [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].forEach(function (o) {
      var b = el('button', mc === o[0] ? 'active' : null, o[1]);
      b.addEventListener('click', function () { setMode(o[0]); });
      seg2.appendChild(b);
    });
    f2.appendChild(seg2); pane.appendChild(f2);
  }

  function tabEngine(pane) {
    pane.appendChild(el('div', 'hint', 'Loading...'));
    api('/api/settings').then(function (s) {
      pane.innerHTML = '';
      var live = s.live || {};
      var name = inp(live.agentName);
      var dl = el('datalist'); dl.id = 'zx-models'; ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'opus', 'sonnet', 'haiku'].forEach(function (m) { var o = el('option'); o.value = m; dl.appendChild(o); }); pane.appendChild(dl);
      var model = inp(live.model); model.setAttribute('list', 'zx-models');
      var fast = inp(live.fastModel);
      var perm = el('select', 'inp'); perm.style.width = '100%';
      ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk'].forEach(function (m) { var o = el('option'); o.value = m; o.textContent = m; if (live.permissionMode === m) o.selected = true; perm.appendChild(o); });
      var turns = inp(live.maxTurns); turns.type = 'number';
      var conc = inp(live.maxConcurrent); conc.type = 'number';
      var tmo = inp(live.turnTimeoutSeconds); tmo.type = 'number'; tmo.min = '10';
      var routing = el('button', 'switch' + (live.localRouting !== 'off' ? ' on' : ''), "<span class='knob'></span>");
      routing.addEventListener('click', function () { routing.classList.toggle('on'); });
      var sys = el('textarea', 'inp'); sys.style.cssText = 'width:100%;height:80px'; sys.value = live.systemPromptAppend || '';

      pane.appendChild(fld('Assistant name', name));
      pane.appendChild(fld('Primary model', model, 'Claude model id or alias.'));
      pane.appendChild(fld('Fast model', fast));
      pane.appendChild(fld('Permission mode', perm));
      var row = el('div', 'row2'); var c1 = el('div'); c1.style.flex = '1'; c1.appendChild(fld('Max turns', turns)); var c2 = el('div'); c2.style.flex = '1'; c2.appendChild(fld('Max concurrent', conc)); row.appendChild(c1); row.appendChild(c2); pane.appendChild(row);
      pane.appendChild(fld('Turn timeout (seconds)', tmo, 'How long a single turn may run before it is stopped. e.g. 3600 = 1 hour, 14400 = 4 hours. Applies live.'));
      var rrow = el('div'); rrow.style.cssText = 'display:flex;align-items:center;gap:8px'; rrow.appendChild(routing); rrow.appendChild(el('span', 'hint', 'Local-model routing (auto / off)')); pane.appendChild(fld('Routing', rrow));
      pane.appendChild(fld('System prompt append', sys));
      var status = el('span', 'hint'); var save = el('button', 'btn', 'Save');
      var sr = el('div', 'save-row'); sr.appendChild(save); sr.appendChild(status); pane.appendChild(sr);
      save.addEventListener('click', function () {
        save.disabled = true; status.textContent = 'Saving...';
        postSettings({ live: { agentName: name.value.trim(), model: model.value.trim(), fastModel: fast.value.trim(), permissionMode: perm.value, maxTurns: Number(turns.value) || undefined, maxConcurrent: Number(conc.value) || undefined, turnTimeoutSeconds: Number(tmo.value) || undefined, localRouting: routing.classList.contains('on') ? 'auto' : 'off', systemPromptAppend: sys.value } })
          .then(function (r) { save.disabled = false; status.textContent = 'Saved.' + (r && r.restartRequired ? ' Some changes need a restart (System tab).' : ''); })
          .catch(function () { save.disabled = false; status.textContent = 'Failed.'; });
      });
    }).catch(function () { pane.innerHTML = ''; pane.appendChild(el('div', 'empty', 'Could not load settings.')); });
  }

  function tabProviders(pane) {
    pane.appendChild(el('div', 'hint', 'Loading providers...'));
    api('/api/providers').then(function (d) {
      pane.innerHTML = '';
      pane.appendChild(el('div', 'hint', 'Saving a key persists it; it takes effect after a restart (System tab).'));
      (d.providers || []).forEach(function (p) {
        var card = el('div', 'prov');
        var top = el('div', 'top');
        top.appendChild(el('span', 'name', p.label || p.id));
        top.appendChild(el('span', 'tag ' + (p.kind === 'paid' ? 'paid' : 'free'), p.kind || 'free'));
        if (p.configured) top.appendChild(el('span', 'tag ok', 'configured'));
        card.appendChild(top);
        card.appendChild(el('div', 'hint', (p.model || '') + (p.note ? (' — ' + p.note) : '') + (typeof p.used === 'number' ? (' · used ' + p.used + (p.freeDaily ? ('/' + p.freeDaily) : '')) : '')));
        if (p.envKey) {
          var krow = el('div'); krow.style.cssText = 'display:flex;gap:8px;margin-top:8px';
          var key = el('input', 'inp'); key.type = 'password'; key.style.flex = '1'; key.placeholder = p.configured ? '•••• set — paste to replace' : 'Paste API key';
          var sv = el('button', 'btn', 'Save'); var st = el('div', 'hint'); st.style.marginTop = '4px';
          krow.appendChild(key); krow.appendChild(sv); card.appendChild(krow); card.appendChild(st);
          sv.addEventListener('click', function () {
            var v = key.value.trim(); if (!v) { st.textContent = 'Enter a key.'; return; }
            sv.disabled = true; st.textContent = 'Saving...'; var cred = {}; cred[p.envKey] = v;
            postSettings({ credentials: cred }).then(function () { sv.disabled = false; key.value = ''; st.textContent = 'Saved — restart to apply.'; }).catch(function () { sv.disabled = false; st.textContent = 'Failed.'; });
          });
        }
        pane.appendChild(card);
      });
    }).catch(function () { pane.innerHTML = ''; pane.appendChild(el('div', 'empty', 'Could not load providers.')); });
  }

  function tabSkills(pane) {
    pane.appendChild(el('div', 'hint', 'Loading skills...'));
    api('/api/skills').then(function (arr) {
      pane.innerHTML = '';
      var list = Array.isArray(arr) ? arr : [];
      var search = inp(''); search.placeholder = 'Search ' + list.length + ' skills'; search.style.marginBottom = '10px';
      pane.appendChild(search);
      var box = el('div'); pane.appendChild(box);
      function draw(f) {
        box.innerHTML = ''; var q = (f || '').toLowerCase();
        var shown = list.filter(function (s) { return !q || (s.name + ' ' + (s.description || '')).toLowerCase().indexOf(q) !== -1; });
        if (!shown.length) { box.appendChild(el('div', 'empty', 'No skills match.')); return; }
        shown.forEach(function (s) {
          var rowEl = el('div', 'skill');
          var meta = el('div', 'meta');
          meta.appendChild(el('div', 'sname', s.name + (s.source === 'external' ? '  ·  external' : '')));
          meta.appendChild(el('div', 'sdesc', (s.description || '').slice(0, 160)));
          rowEl.appendChild(meta);
          if (s.source === 'external') {
            var imp = el('button', 'btn ghost', 'Import'); imp.style.cssText = 'padding:5px 10px;flex:0 0 auto';
            imp.addEventListener('click', function () { imp.disabled = true; api('/api/skills', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'import', slug: s.name }) }).then(function () { s.source = 'own'; draw(search.value); }).catch(function () { imp.disabled = false; }); });
            rowEl.appendChild(imp);
          } else {
            var en = s.enabled !== false;
            var tg = el('button', 'switch' + (en ? ' on' : ''), "<span class='knob'></span>");
            tg.addEventListener('click', function () {
              var want = !tg.classList.contains('on'); tg.classList.toggle('on', want);
              api('/api/skills', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: want ? 'enable' : 'disable', slug: s.name }) }).then(function () { s.enabled = want; }).catch(function () { tg.classList.toggle('on', !want); });
            });
            rowEl.appendChild(tg);
          }
          box.appendChild(rowEl);
        });
      }
      search.addEventListener('input', function () { draw(this.value); });
      draw('');
    }).catch(function () { pane.innerHTML = ''; pane.appendChild(el('div', 'empty', 'Could not load skills.')); });
  }

  function tabSystem(pane) {
    pane.appendChild(el('div', 'hint', 'Loading...'));
    api('/api/status').then(function (s) {
      pane.innerHTML = '';
      var v = s.version || {}, m = s.models || {}, u = s.update || {};
      function kv(k, val) { var r = el('div'); r.style.cssText = 'display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f0f0f0;font-size:13px'; r.appendChild(el('span', null, k)); var b = el('span'); b.style.color = '#555'; b.textContent = val; r.appendChild(b); return r; }
      pane.appendChild(kv('Version', (v.pkg || '?') + ' · build ' + (v.build != null ? v.build : '?') + ' · ' + (v.commit || '')));
      pane.appendChild(kv('Primary model', m.primary || '?'));
      pane.appendChild(kv('Fast model', m.fast || '?'));
      pane.appendChild(kv('Local model', m.local || '(none)'));
      pane.appendChild(kv('Branch', (u.branch || '?') + (u.behind ? (' · ' + u.behind + ' behind') : ' · up to date')));
      pane.appendChild(kv('Tokens (session)', String((s.engineTokens && s.engineTokens.session) || 0)));
      var rb = el('button', 'btn', 'Restart Zamolxis');
      var cl = el('a', 'btn ghost', 'Open classic UI'); cl.href = '/classic'; cl.target = '_blank'; cl.style.cssText = 'text-decoration:none;line-height:30px';
      var st = el('span', 'hint');
      var sr = el('div', 'save-row'); sr.appendChild(rb); sr.appendChild(cl); sr.appendChild(st); pane.appendChild(sr);
      rb.addEventListener('click', function () { restartZam(rb, st); });
    }).catch(function () { pane.innerHTML = ''; pane.appendChild(el('div', 'empty', 'Could not load status.')); });
  }

  // ---------- App: New Agent ----------
  function mountNewAgent(body, win) {
    var pad = el('div', 'app-pad');
    function field(labelTxt, node, hint) { var f = el('div', 'field'); f.appendChild(el('label', null, labelTxt)); if (hint) f.appendChild(el('div', 'hint', hint)); f.appendChild(node); return f; }
    var name = el('input'); name.placeholder = 'e.g. researcher';
    var job = el('textarea'); job.rows = 4; job.placeholder = 'What should this agent do?';
    var model = el('input'); model.placeholder = '(default)';
    [name, model].forEach(function (i) { i.style.cssText = 'width:100%;height:36px;border:1px solid #d6d6d6;border-radius:8px;padding:0 10px;font:inherit'; });
    job.style.cssText = 'width:100%;border:1px solid #d6d6d6;border-radius:8px;padding:8px 10px;font:inherit;resize:vertical';
    pad.appendChild(field('Agent name', name));
    pad.appendChild(field('Instructions', job, 'This becomes the agent app. It can run with or without a chat window.'));
    pad.appendChild(field('Model', model, 'Leave blank for the default.'));
    var msg = el('div', 'hint'); msg.style.minHeight = '16px';
    var create = el('button', 'btn', 'Create app');
    create.addEventListener('click', function () {
      var n = name.value.trim(); if (!n) { msg.textContent = 'Name is required.'; return; }
      create.disabled = true; msg.textContent = 'Creating...';
      api('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', name: n, job: job.value.trim(), model: model.value.trim() || undefined }) })
        .then(function (d) {
          create.disabled = false;
          if (d && d.error) { msg.textContent = String(d.error); return; }
          msg.textContent = 'Created. Added to the desktop.';
          if (d && d.agents) agents = d.agents; else loadAgents();
          renderDesktop();
        })
        .catch(function () { create.disabled = false; msg.textContent = 'Backend unreachable.'; });
    });
    var row = el('div'); row.style.cssText = 'display:flex;gap:10px;align-items:center'; row.appendChild(create); row.appendChild(msg);
    pad.appendChild(row);
    body.appendChild(pad);
  }

  // ---------- per-app chat-window setting (the "is chat needed?" toggle) ----------
  function appChatEnabled(appId, def) { var v = localStorage.getItem('zx_chat_' + appId); return v === null ? !!def : v === '1'; }
  function setAppChat(appId, on) { localStorage.setItem('zx_chat_' + appId, on ? '1' : '0'); }

  // ---------- App: Agent (chat window optional, per the app setting) ----------
  function mountAgent(body, win, agent) {
    body.style.padding = '0';
    var wrap = el('div'); wrap.style.cssText = 'height:100%;display:flex;flex-direction:column';
    var head = el('div', 'agent-head');
    head.appendChild(el('div', 'a-name', agent.label || agent.name));
    head.appendChild(el('div', 'a-sub', 'Model: ' + (agent.model || '(default)')));
    if (agent.job) { var j = el('div', 'a-sub'); j.textContent = agent.job; head.appendChild(j); }
    var bar = el('div'); bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:10px';
    var toggle = el('button', 'switch' + (appChatEnabled(win.appId, true) ? ' on' : ''), "<span class='knob'></span>");
    toggle.title = 'Toggle chat window for this app';
    var lbl = el('span', 'hint', 'Chat window');
    var spacer = el('div'); spacer.style.flex = '1';
    var note = el('span', 'hint');
    var runBtn = el('button', 'btn ghost', 'Run job');
    var delBtn = el('button', 'btn ghost', 'Delete');
    bar.appendChild(toggle); bar.appendChild(lbl); bar.appendChild(spacer); bar.appendChild(note); bar.appendChild(runBtn); bar.appendChild(delBtn);
    head.appendChild(bar);
    wrap.appendChild(head);
    var content = el('div'); content.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column';
    wrap.appendChild(content);
    body.appendChild(wrap);

    function render() {
      if (win._consoleIv) { clearInterval(win._consoleIv); win._consoleIv = null; }
      content.innerHTML = '';
      if (appChatEnabled(win.appId, true)) buildAgentChat(content, agent);
      else buildAgentConsole(content, agent, win);
    }
    toggle.addEventListener('click', function () {
      var now = !appChatEnabled(win.appId, true);
      setAppChat(win.appId, now); toggle.classList.toggle('on', now); render();
    });
    runBtn.addEventListener('click', function () {
      runBtn.disabled = true; note.textContent = 'Running...';
      api('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'run', name: agent.name }) })
        .then(function (d) { runBtn.disabled = false; note.textContent = (d && d.error) ? String(d.error) : ('Done' + (d.via ? ' · ' + d.via : '')); })
        .catch(function () { runBtn.disabled = false; note.textContent = 'Unreachable'; });
    });
    delBtn.addEventListener('click', function () {
      if (!confirm('Delete agent "' + agent.name + '"?')) return;
      api('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', name: agent.name }) })
        .then(function (d) { if (d && d.agents) agents = d.agents; else loadAgents(); closeWin(win); renderDesktop(); })
        .catch(function () { note.textContent = 'Unreachable'; });
    });
    win.cleanup.push(function () { win.closed = true; if (win._consoleIv) clearInterval(win._consoleIv); });
    render();
  }

  // Real per-agent chat: each turn calls runAgent(name, task) over REST and shows {reply, via}.
  function buildAgentChat(content, agent) {
    var logKey = 'zx_log_a_' + agent.name;
    var chat = el('div', 'chat');
    var log = el('div', 'chat-log');
    var row = el('div', 'chat-input');
    var ta = el('textarea'); ta.placeholder = 'Message ' + (agent.label || agent.name) + '...';
    var send = el('button'); send.textContent = 'Send';
    row.appendChild(ta); row.appendChild(send);
    chat.appendChild(log); chat.appendChild(row); content.appendChild(chat);
    function addMsg(who, text, cls, via, persist) { var m = el('div', 'msg ' + cls); m.appendChild(el('div', 'who', who + (via ? ' · via ' + via : ''))); var c = el('div'); c.textContent = text; m.appendChild(c); log.appendChild(m); log.scrollTop = log.scrollHeight; if (persist !== false) pushChatLog(logKey, { who: who, text: text, cls: cls, via: via }); return m; }
    var hist = loadChatLog(logKey);
    if (hist.length) hist.forEach(function (r) { addMsg(r.who, r.text, r.cls, r.via, false); });
    else addMsg(agent.label || agent.name, 'Ask me to do something, or give me a task.', 'bot', null, false);
    function doSend() {
      var t = ta.value.trim(); if (!t) return; addMsg('You', t, 'user'); ta.value = '';
      var pend = addMsg(agent.label || agent.name, 'thinking...', 'bot', null, false); send.disabled = true;
      api('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'run', name: agent.name, task: t }) })
        .then(function (d) {
          send.disabled = false;
          var c = pend.querySelector('div:last-child'), who = pend.querySelector('.who');
          if (d && d.error) { c.textContent = '(' + d.error + ')'; return; }
          who.textContent = (agent.label || agent.name) + (d.via ? ' · via ' + d.via : '');
          c.textContent = d.reply || '(no reply)';
          pushChatLog(logKey, { who: agent.label || agent.name, text: d.reply || '(no reply)', cls: 'bot', via: d.via });
          if (d.scheduled && d.scheduled.cron) addMsg('System', 'Scheduled: ' + (d.scheduled.note || d.scheduled.cron), 'bot');
          log.scrollTop = log.scrollHeight;
        })
        .catch(function () { send.disabled = false; pend.querySelector('div:last-child').textContent = '(backend unreachable)'; });
    }
    send.addEventListener('click', doSend);
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
    setTimeout(function () { ta.focus(); }, 50);
  }

  // Headless view: no chat; run-on-demand + live activity feed.
  function buildAgentConsole(content, agent, win) {
    var pad = el('div', 'app-pad');
    pad.appendChild(el('div', 'hint', 'Chat window is off — this agent runs headless: it executes its job on demand or on schedule via the existing agent/skill mechanism. Turn the chat on above to talk to it directly.'));
    var log = el('div', 'chat-log'); log.style.borderTop = '1px solid #eee';
    var empty = el('div', 'empty', 'Recent activity will appear here.'); log.appendChild(empty);
    content.appendChild(pad); content.appendChild(log);
    var since = 0;
    function poll() {
      api('/api/agentmsgs?since=' + since).then(function (d) {
        var arr = Array.isArray(d) ? d : (d && d.messages) || [];
        arr.forEach(function (m) {
          if (m.ts) since = Math.max(since, m.ts);
          if (m.from === agent.name || m.agent === agent.name || m.to === agent.name) {
            if (empty.parentNode) empty.remove();
            var x = el('div', 'msg bot'); x.appendChild(el('div', 'who', m.from || 'agent')); var c = el('div'); c.textContent = m.text || ''; x.appendChild(c); log.appendChild(x); log.scrollTop = log.scrollHeight;
          }
        });
      }).catch(function () {});
    }
    poll(); win._consoleIv = setInterval(function () { if (!win.closed) poll(); }, 4000);
  }

  // ============================================================
  // Desktop icons
  // ============================================================
  var deskIcons = $('#desktop-icons');
  var selectedIcon = null;
  function loadIconPos() { try { return JSON.parse(localStorage.getItem('zx_icons') || '{}'); } catch (e) { return {}; } }
  function saveIconPos(p) { try { localStorage.setItem('zx_icons', JSON.stringify(p)); } catch (e) {} }

  function wireIcon(ic, a) {
    function select() { if (selectedIcon && selectedIcon !== ic) selectedIcon.classList.remove('selected'); ic.classList.add('selected'); selectedIcon = ic; }
    ic.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var sx = e.clientX, sy = e.clientY;
      var sl = parseInt(ic.style.left, 10) || 0, st = parseInt(ic.style.top, 10) || 0;
      var moved = false;
      function mv(ev) {
        var dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!moved && Math.abs(dx) + Math.abs(dy) > 4) { moved = true; ic.classList.add('dragging'); select(); }
        if (moved) { ic.style.left = Math.max(0, sl + dx) + 'px'; ic.style.top = Math.max(0, st + dy) + 'px'; }
      }
      function up() {
        document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
        if (moved) {
          ic.classList.remove('dragging');
          var pos = loadIconPos(); pos[a.id] = { x: parseInt(ic.style.left, 10), y: parseInt(ic.style.top, 10) }; saveIconPos(pos);
          ic._moved = true; setTimeout(function () { ic._moved = false; }, 0);
        }
      }
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    ic.addEventListener('click', function (e) { e.stopPropagation(); if (ic._moved) return; select(); });
    ic.addEventListener('dblclick', function () { launchApp(a.id); });
  }

  function renderDesktop() {
    deskIcons.innerHTML = '';
    var pos = loadIconPos();
    var os = document.body.dataset.os;
    var startX = os === 'ubuntu' ? 78 : 16;
    var startY = (os === 'mac' || os === 'ubuntu') ? 40 : 16;
    appList().forEach(function (a, i) {
      var ic = el('div', 'desk-icon');
      ic.appendChild(el('div', 'ico', a.iconSvg));
      ic.appendChild(el('div', 'label', a.name));
      var p = pos[a.id];
      if (p) { ic.style.left = p.x + 'px'; ic.style.top = p.y + 'px'; }
      else { ic.style.left = startX + 'px'; ic.style.top = (startY + i * 96) + 'px'; }
      wireIcon(ic, a);
      deskIcons.appendChild(ic);
    });
    if (!startMenu.classList.contains('hidden')) renderStart($('#start-search-input').value);
  }

  function loadAgents() {
    return api('/api/agents').then(function (d) { agents = Array.isArray(d) ? d : []; renderDesktop(); syncTaskbar(); }).catch(function () {});
  }

  // ============================================================
  // Clock + status + wiring
  // ============================================================
  function tickClock() {
    var d = new Date();
    var hh = d.getHours(), mm = d.getMinutes();
    var tt = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm, dd = d.toLocaleDateString();
    Array.prototype.forEach.call(document.querySelectorAll('.clock-time'), function (e) { e.textContent = tt; });
    Array.prototype.forEach.call(document.querySelectorAll('.clock-date'), function (e) { e.textContent = dd; });
  }
  function pollStatus() {
    api('/api/status').then(function () {
      ['#tray-status', '#tray-status-top'].forEach(function (s) { var t = $(s); if (t) { t.classList.add('ok'); t.title = 'Backend connected'; } });
    }).catch(function () { ['#tray-status', '#tray-status-top'].forEach(function (s) { var t = $(s); if (t) t.classList.remove('ok'); }); });
  }

  $('#start-btn').addEventListener('click', function (e) { e.stopPropagation(); toggleStart(); });
  $('#start-search-input').addEventListener('input', function () { renderStart(this.value); });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#startmenu') && !e.target.closest('#start-btn')) closeStart();
    if (!e.target.closest('.desk-icon') && selectedIcon) { selectedIcon.classList.remove('selected'); selectedIcon = null; }
  });
  $('#clock').addEventListener('click', function () { launchApp('settings'); });

  // boot
  applyTheme();
  applyMode();
  if (window.matchMedia) { try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (modeChoice() === 'auto') applyMode(); }); } catch (e) {} }
  tickClock(); setInterval(tickClock, 10000);
  pollStatus(); setInterval(pollStatus, 15000);
  renderDesktop();
  // Restore the previous window session once agents are known (agent windows need the list);
  // fall back to opening the default Zamolxis app on a fresh/empty session.
  loadAgents().then(function () { if (!restoreSession()) launchApp('zamolxis'); });
})();
