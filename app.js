/* Desk app. STEP 8 UI. Live data from a secret gist (or local /d/ fixtures).
   Opens as {URL}#d={id}[/route]; the id is kept in localStorage and is never
   embedded in this file. Settings are read-only on plan B. No web push. */
(function () {
  "use strict";

  const POLL_MS = 60 * 1000;
  const LS_D = "desk.d";
  const TAB_ROUTES = { home: 1, agents: 1, activity: 1, account: 1 };
  try { history.scrollRestoration = "manual"; } catch (e) {}
  document.documentElement.setAttribute("lang", "en");
  const $app = document.getElementById("app");
  let DATA = "";
  let route = "home";
  let coinMint = null;
  let auditMint = null;
  let state = null;
  let activity = { items: [] };
  let chart = { ranges: {}, marks: [] };
  let coins = {}; // mint -> body
  let coin = null;
  let error = null;
  let lastGoodAt = null;
  let retryIn = 0;
  let timer = null;
  let countdownTimer = null;
  let chartRange = "LIVE";
  let lastBalance = null;
  let searchOpen = false;
  let searchQ = "";
  let bellOpen = false;
  let unread = false;
  let seenActivityId = 0;

  if (location.search.indexOf("shot=1") !== -1) {
    document.documentElement.classList.add("shot");
  }

  function isLocalHost() {
    const h = location.hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  }

  function applyRoute(rest) {
    rest = (rest || "").replace(/\/+$/, "");
    coinMint = null;
    auditMint = null;
    if (!rest || rest === "home") route = "home";
    else if (rest === "agents") route = "agents";
    else if (rest === "activity") route = "activity";
    else if (rest === "account") route = "account";
    else if (rest === "auditor" || rest.startsWith("auditor/")) {
      route = "auditor";
      if (rest.startsWith("auditor/")) auditMint = rest.slice(8);
    } else if (rest.startsWith("coin/")) {
      route = "coin";
      coinMint = rest.slice(5);
    } else route = "home";
  }

  function parseHash() {
    const h = (location.hash || "").replace(/^#/, "");
    const m = h.match(/^d=([^/]+)(?:\/(.*))?$/);
    if (m) {
      DATA = decodeURIComponent(m[1]);
      try { localStorage.setItem(LS_D, DATA); } catch (e) {}
      applyRoute(m[2]);
      return true;
    }
    try {
      const stored = localStorage.getItem(LS_D);
      if (stored) {
        DATA = stored;
        // Empty hash (standalone start_url) keeps the current tab.
        // A fresh launch starts on home because route defaults to "home".
        return true;
      }
    } catch (e) {}
    DATA = "";
    // Leave `route` alone so tabs stay tappable on the setup screen
    // (forcing home here undid every tab click on the next render).
    return false;
  }

  function hashPath(r, mint) {
    let path = "d=" + encodeURIComponent(DATA);
    if (r === "coin" && mint) path += "/coin/" + mint;
    else if (r === "auditor" && mint) path += "/auditor/" + mint;
    else if (r && r !== "home") path += "/" + r;
    return path;
  }
  function go(r, mint) {
    // Tabs must stay tappable before a desk key is saved.
    if (!DATA) {
      applyRoute(!r || r === "home" ? "" : (r === "auditor" || r === "coin") ? "" : r);
      window.scrollTo(0, 0);
      render();
      return;
    }
    const path = hashPath(r, mint);
    const hash = "#" + path;
    const url = location.pathname + location.search + hash;
    const isTab = !!(TAB_ROUTES[r || "home"] && !mint);
    // Top-level tabs replace history so Safari does not show a back
    // chevron or treat the tab as a pushed page. Coin / Auditor push.
    if (isTab) {
      if (location.hash !== hash) {
        try { history.replaceState({ tab: true, route: r || "home" }, "", url); }
        catch (e) { location.hash = path; }
      }
    } else if (location.hash !== hash) {
      try { history.pushState({ tab: false, route: r, mint: mint || null }, "", url); }
      catch (e) { location.hash = path; }
    }
    parseHash();
    window.scrollTo(0, 0);
    render(); // paint from already-loaded data (or skeletons if none)
    // Refresh coin/auditor payloads in the background; never blank first.
    if (!isTab) loadAll().then(render);
  }

  function gistFileName(rel) {
    if (rel.startsWith("coin/") && rel.endsWith(".json")) return "coin_" + rel.slice(5);
    if (rel.startsWith("audit/") && rel.endsWith(".json")) return "audit_" + rel.slice(6);
    return rel;
  }

  async function fetchLocalJSON(rel) {
    const url = "d/" + encodeURIComponent(DATA) + "/" + rel + "?t=" + Date.now();
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw Object.assign(new Error("http"), { status: r.status });
    return r.json();
  }

  async function fetchGistBundle() {
    const url = "https://api.github.com/gists/" + encodeURIComponent(DATA) + "?t=" + Date.now();
    const r = await fetch(url, { cache: "no-store" });
    if (r.status === 403 || r.status === 429) {
      throw Object.assign(new Error("rate"), { status: r.status });
    }
    if (!r.ok) throw Object.assign(new Error("http"), { status: r.status });
    const body = await r.json();
    const files = body && body.files ? body.files : {};
    const out = {};
    Object.keys(files).forEach(function (name) {
      const f = files[name];
      if (!f || f.content == null || f.truncated) return;
      try { out[name] = JSON.parse(f.content); } catch (e) {}
    });
    return out;
  }

  function extractDeskId(raw) {
    raw = String(raw || "").trim().replace(/^\s+|\s+$/g, "");
    if (!raw) return "";
    var m = raw.match(/#d=([^/\s?#&]+)/i);
    if (m) {
      try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    }
    m = raw.match(/[?&]d=([^/\s?#&]+)/i);
    if (m) {
      try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    }
    m = raw.match(/gist\.github(?:usercontent)?\.com\/(?:[^/]+\/)?([a-zA-Z0-9]+)/i);
    if (m) return m[1];
    m = raw.match(/api\.github\.com\/gists\/([a-zA-Z0-9]+)/i);
    if (m) return m[1];
    // Bare id: no URL punctuation.
    if (/^[a-zA-Z0-9_-]+$/.test(raw) && raw.length >= 8 && raw.length <= 128) return raw;
    return "";
  }

  let setupError = "";
  let setupDraft = "";
  let setupBusy = false;

  async function probeDesk(id) {
    if (isLocalHost()) {
      const r = await fetch("d/" + encodeURIComponent(id) + "/state.json?t=" + Date.now(), { cache: "no-store" });
      return { ok: r.ok, status: r.status };
    }
    const r = await fetch("https://api.github.com/gists/" + encodeURIComponent(id) + "?t=" + Date.now(), { cache: "no-store" });
    return { ok: r.status === 200, status: r.status };
  }

  async function tryAdoptLink(raw) {
    const id = extractDeskId(raw);
    if (!id) {
      setupError = "Paste the full private desk link (the one with #d=), or just the id.";
      return false;
    }
    try {
      const res = await probeDesk(id);
      if (!res.ok) {
        if (res.status === 403 || res.status === 429) {
          setupError = "The desk is busy. Try again in a moment.";
        } else {
          setupError = "That link didn't work. Check it and try again.";
        }
        return false;
      }
    } catch (e) {
      setupError = "Couldn't reach the desk. Check your connection and try again.";
      return false;
    }
    DATA = id;
    try { localStorage.setItem(LS_D, DATA); } catch (e) {}
    setupError = "";
    setupDraft = "";
    error = null;
    try {
      const path = "d=" + encodeURIComponent(DATA);
      history.replaceState({ tab: true, route: "home" }, "", location.pathname + location.search + "#" + path);
    } catch (e) {}
    applyRoute("home");
    await loadAll();
    render();
    return true;
  }

  async function saveDeskLink() {
    const input = document.getElementById("desk-link");
    const raw = input ? input.value : setupDraft;
    setupDraft = raw;
    setupError = "";
    setupBusy = true;
    renderSetup();
    const ok = await tryAdoptLink(raw);
    setupBusy = false;
    if (!ok) renderSetup();
  }

  async function pasteDeskLink() {
    setupError = "";
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      setupError = "Couldn't read the clipboard. Paste it into the field instead.";
      renderSetup();
      return;
    }
    try {
      const raw = await navigator.clipboard.readText();
      const text = String(raw || "").trim();
      if (!text) {
        setupError = "The clipboard is empty. Paste the link into the field instead.";
        renderSetup();
        return;
      }
      const input = document.getElementById("desk-link");
      if (input) input.value = text;
      setupDraft = text;
      await saveDeskLink();
    } catch (e) {
      setupError = "Couldn't read the clipboard. Paste it into the field instead.";
      renderSetup();
    }
  }

  async function loadAll() {
    if (!DATA) {
      error = "missing";
      return;
    }
    try {
      let bundle = null;
      if (isLocalHost()) {
        const [s, a, c] = await Promise.all([
          fetchLocalJSON("state.json"),
          fetchLocalJSON("activity.json").catch(function () { return { items: [] }; }),
          fetchLocalJSON("chart.json").catch(function () { return { ranges: {}, marks: [] }; }),
        ]);
        state = s;
        activity = a || { items: [] };
        chart = c || { ranges: {}, marks: [] };
        error = s && s.error ? "desk" : null;
        if (route === "coin" && coinMint) {
          try { coin = await fetchLocalJSON("coin/" + coinMint + ".json"); }
          catch (e) { coin = null; }
        } else if (route === "auditor" && auditMint) {
          try { coin = await fetchLocalJSON("coin/" + auditMint + ".json"); }
          catch (e) { coin = coins[auditMint] || null; }
        }
      } else {
        bundle = await fetchGistBundle();
        state = bundle["state.json"];
        if (!state) throw new Error("no state");
        activity = bundle["activity.json"] || { items: [] };
        chart = bundle["chart.json"] || { ranges: {}, marks: [] };
        coins = {};
        Object.keys(bundle).forEach(function (n) {
          if (n.startsWith("coin_") && n.endsWith(".json")) {
            coins[n.slice(5, -5)] = bundle[n];
          }
        });
        error = state && state.error ? "desk" : null;
        if (route === "coin" && coinMint) coin = coins[coinMint] || null;
        else if (route === "auditor" && auditMint) coin = coins[auditMint] || null;
      }
      if (!error) {
        lastGoodAt = (state && state.ts) || new Date().toISOString();
        retryIn = 0;
        const items = (activity && activity.items) || [];
        if (items.length && items[0].id && items[0].id > seenActivityId) {
          if (seenActivityId) unread = true;
          // don't bump seen until they open the bell / activity
        }
      }
    } catch (e) {
      error = "fetch";
      retryIn = Math.round(POLL_MS / 1000);
    }
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function money(n, digits) {
    if (n == null || n === "") return "—";
    n = Number(n);
    if (!isFinite(n)) return "—";
    const sign = n < 0 ? "-" : "";
    const d = digits == null ? 2 : digits;
    return sign + "$" + Math.abs(n).toLocaleString("en-US", {
      minimumFractionDigits: d, maximumFractionDigits: d,
    });
  }
  function priceFmt(n) {
    n = Number(n);
    if (!isFinite(n)) return "—";
    if (Math.abs(n) >= 1) return money(n, 2);
    const d = Math.abs(n) >= 0.01 ? 4 : Math.abs(n) >= 0.0001 ? 6 : 8;
    let s = Math.abs(n).toFixed(d).replace(/0+$/, "").replace(/\.$/, "");
    return (n < 0 ? "-$" : "$") + s;
  }
  function pctFmt(n, signed) {
    n = Number(n);
    if (!isFinite(n)) return "—";
    const sign = n > 0 && signed !== false ? "+" : "";
    return sign + n.toFixed(2) + "%";
  }

  /* Always '.' decimals, independent of the browser locale (cs-CZ uses ','). */
  function plainNum(n) {
    n = Number(n);
    if (!isFinite(n)) return "";
    if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
    const s2 = n.toFixed(2);
    if (Math.abs(n - Number(s2)) < 1e-12) return s2;
    return n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  }
  function midEllip(s, max) {
    s = String(s ?? "");
    max = max || 23;
    if (s.length <= max) return s;
    const inner = max - 1;
    const front = 12;
    const back = Math.max(4, inner - front);
    return s.slice(0, front) + "…" + s.slice(s.length - back);
  }

  function pragueTime(ts, fmt) {
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d)) return "";
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Prague", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(d);
    return parts;
  }

  function agentsOf() {
    const a = (state && state.agents) || {};
    // support both dict and array
    if (Array.isArray(a)) {
      const o = {};
      a.forEach(function (x) { o[(x.name || "").toLowerCase()] = x; });
      return o;
    }
    return a;
  }
  function agent(name) { return agentsOf()[name] || {}; }

  function items() { return (activity && activity.items) || []; }

  function valUp(s) {
    const t = String(s || "");
    if (t.charAt(0) === "+") return "up";
    if (t.charAt(0) === "-") return "down";
    return "";
  }

  /* ---------- chrome ---------- */
  function tabbar() {
    const on = function (r) { return route === r || (r === "home" && route === "home") ? " on" : ""; };
    return (
      '<nav class="tabbar" aria-label="Main">' +
        tabBtn("home", "Home", on("home"), iconHome()) +
        tabBtn("agents", "Agents", on("agents"), iconAgents()) +
        tabBtn("activity", "Activity", on("activity"), iconActivity()) +
        tabBtn("account", "Account", on("account"), iconAccount()) +
      "</nav>"
    );
  }
  function tabBtn(r, label, on, svg) {
    return '<button class="tab' + on + '" data-go="' + r + '">' + svg + "<span>" + label + "</span></button>";
  }
  function iconHome() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z"/></svg>';
  }
  function iconAgents() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="9" r="2.4"/><circle cx="16" cy="9" r="2.4"/><circle cx="12" cy="15.5" r="2.4"/><path d="M4.5 19c.6-2 2.2-3 3.6-3h.8M19.5 19c-.6-2-2.2-3-3.6-3h-.8M9.6 18.8c.6-1.5 1.6-2.3 2.4-2.3s1.8.8 2.4 2.3"/></svg>';
  }
  function iconActivity() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 12h3l2.5-6 3 12 2.5-6H20"/></svg>';
  }
  function iconAccount() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8.5" r="3"/><path d="M5 19.5c.8-3.2 3.2-5 7-5s6.2 1.8 7 5"/></svg>';
  }
  function iconSearch() {
    return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="6.5"/><path d="M16 16.5 20 20.5"/></svg>';
  }
  function iconBell() {
    return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16z"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>';
  }

  function settingByKey(key) {
    const g = state && state.settings;
    if (!g) return "";
    if (g[key] != null && typeof g[key] !== "object") return String(g[key]);
    const names = Object.keys(g);
    for (let i = 0; i < names.length; i++) {
      const items = Array.isArray(g[names[i]]) ? g[names[i]] : null;
      if (!items) continue;
      for (let j = 0; j < items.length; j++) {
        const s = items[j];
        if (s && (s.key === key || s.key === "desk." + key)) {
          if (s.value != null) return String(s.value);
          if (s.display != null) return String(s.display);
        }
      }
    }
    return "";
  }
  function fomoHandle() {
    let raw = "";
    if (state) {
      raw = state.fomoHandle
        || (state.settings && state.settings.fomo_handle)
        || settingByKey("fomo_handle")
        || settingByKey("desk.fomo_handle")
        || "";
      if (raw && typeof raw === "object") raw = raw.value || raw.display || "";
    }
    raw = String(raw || "").trim();
    if (!raw) raw = "beready";
    if (raw.charAt(0) !== "@") raw = "@" + raw;
    return raw;
  }
  function profileUrlFor(handle) {
    // Must match links.py profile_url exactly.
    if (state && state.profileUrl) return String(state.profileUrl);
    const h = String(handle || "beready").replace(/^@+/, "");
    return "https://fomo.family/profile/" + h + "?source=share_link&r=savipww";
  }
  function avatarLetter() {
    const h = fomoHandle().replace(/^@+/, "");
    return ((h && h.charAt(0)) || "B").toUpperCase();
  }

  function navbar(opts) {
    opts = opts || {};
    const handle = fomoHandle();
    const letter = avatarLetter();
    const back = opts.back
      ? '<button class="back" data-go="' + esc(opts.back) + '">‹ Back</button>'
      : '<button class="avatar" data-go="account" aria-label="Account"><span class="avatar-disc">' + esc(letter) + "</span></button>";
    const title = opts.title != null ? opts.title : handle;
    const trail = opts.hideTools ? "" : (
      '<button class="icon-btn" data-act="search" aria-label="Search">' + iconSearch() + "</button>" +
      '<button class="icon-btn" data-act="bell" aria-label="Notifications">' + iconBell() +
        (unread ? '<span class="bell-dot"></span>' : "") +
      "</button>"
    );
    let titleHtml;
    if (opts.title == null || opts.linkProfile) {
      const url = profileUrlFor(handle);
      titleHtml = '<a class="title" href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(title) + "</a>";
    } else {
      titleHtml = '<div class="title">' + esc(title) + "</div>";
    }
    return '<header class="navbar">' + back + titleHtml + trail + "</header>";
  }

  function scannerQuietText() {
    // Wall clock vs the last scanner heartbeat in the gist. During a
    // desk freeze the gist itself is stale, but Date.now() still moves,
    // so this note appears once the heartbeat is older than 5 minutes.
    const a = agent("scanner");
    const ts = a && a.heartbeat;
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    const min = Math.floor((Date.now() - d.getTime()) / 60000);
    if (min < 5) return "";
    return "Scanner quiet for " + min + " min";
  }

  function errorRow() {
    if (!error || error === "desk") {
      if (!(state && state.error)) return "";
    }
    if (!error && !(state && state.error)) return "";
    if (error === "missing") return "";
    const n = retryIn || Math.round(POLL_MS / 1000);
    const t = lastGoodAt ? pragueTime(lastGoodAt) : "—";
    return '<div class="error-row">Desk offline · retrying in ' + n + "s · last update " + esc(t) + "</div>";
  }

  /* ---------- odometer ---------- */
  function odometerHTML(value) {
    // Plain tabular number. Digit wheels are used only when rolling a change
    // (rollOdometer); first paint and screenshots stay razor-sharp.
    return '<span class="odo-plain">' + esc(money(value, 2)) + "</span>";
  }
  function rollOdometer(root, from, to) {
    if (!root || from == null || from === to || (window.Charts && Charts.reduced())) return;
    const el = root.querySelector(".odo-plain") || root;
    // Brief slide-up of the whole value; per-digit wheels are too fragile
    // on fallback fonts (metrics differ from 1em).
    el.style.transition = "none";
    el.style.opacity = "0.55";
    el.style.transform = "translateY(0.25em)";
    requestAnimationFrame(function () {
      el.style.transition = "transform 600ms cubic-bezier(0.16, 1, 0.3, 1), opacity 400ms ease";
      el.style.opacity = "1";
      el.style.transform = "translateY(0)";
    });
  }

  function renderHome() {
    if (!state) return renderLoading("home");
    const bal = state.balance != null ? state.balance : state.balanceUsd;
    const today = Number(state.todayPct);
    const mult = Number(state.multiplier);
    const paper = (state.mode || "").toUpperCase() === "PAPER";
    const warn = state.ticketWarning && (state.ticketWarning.message || state.ticketWarning);
    const ag = agentsOf();
    const last5 = items().slice(0, 5);
    const emptyChart = !((chart.marks || []).length) && !(state.positions || []).length && !items().some(function (x) {
      return /bought|sold|stopped/i.test(x.kind || "");
    });

    let h = navbar() + errorRow();
    h += '<div class="balance-block"><div class="balance-row">';
    h += '<div class="odometer" id="odo">' + odometerHTML(bal) + "</div>";
    if (paper) h += '<span class="paper-pill">PAPER</span>';
    h += "</div><div class=\"today-row\">";
    const up = isFinite(today) && today >= 0;
    h += '<span class="today-pct ' + (up ? "up" : "down") + ' num">' +
      (isFinite(today) ? pctFmt(today, true) : "—") + "</span>";
    const mx = isFinite(mult) ? (mult >= 10 ? mult.toFixed(1) : mult.toFixed(2)) : "—";
    h += '<span class="mult">' + esc(mx) + "×</span>";
    h += "</div>";
    if (warn && typeof warn === "string") h += '<div class="warn">' + esc(warn) + "</div>";
    else if (warn && warn.message) h += '<div class="warn">' + esc(warn.message) + "</div>";
    const quiet = scannerQuietText();
    if (quiet) h += '<div class="warn">' + esc(quiet) + "</div>";
    h += "</div>";

    h += '<div class="chart-wrap"><canvas id="home-chart"></canvas></div>';
    h += '<div class="ranges" id="ranges">';
    ["LIVE", "1H", "4H", "1D", "1W", "ALL"].forEach(function (r) {
      h += '<button data-range="' + r + '" class="' + (chartRange === r ? "on" : "") + '">' + r + "</button>";
    });
    h += "</div>";

    const running = ["scanner", "auditor", "analyst", "executor", "risk"].filter(function (k) {
      return ag[k] && !ag[k].paused;
    }).length;
    h += '<section class="section"><div class="section-head"><h2>Agents · ' + running + ' running</h2></div>';
    h += '<div class="carousel">';
    h += cardScanner(ag.scanner) + cardAuditor(ag.auditor) + cardAnalyst(ag.analyst) +
         cardExecutor(ag.executor) + cardRisk(ag.risk);
    h += "</div></section>";

    h += '<section class="section"><div class="section-head"><h2>Activity</h2>' +
      '<button class="see" data-go="activity">See all</button></div>';
    if (!last5.length) h += '<div class="empty-note">Nothing yet tonight</div>';
    else h += '<div class="list">' + last5.map(activityRow).join("") + "</div>";
    h += "</section>";
    h += tabbar();
    $app.innerHTML = h;
    rollOdometer(document.getElementById("odo"), lastBalance, bal);
    lastBalance = bal;
    drawHomeChart(emptyChart);
    animateExecBar();
  }

  function drawHomeChart(empty) {
    const c = document.getElementById("home-chart");
    if (!c || !window.Charts) return;
    const pack = (chart.ranges && chart.ranges[chartRange]) || {};
    const points = pack.points || [];
    const start = pack.start != null ? pack.start : (chart.start != null ? chart.start : (state && (state.nightStartBalance || state.paperStartStack)));
    const marks = empty ? [] : (chart.marks || []);
    Charts.line(c, {
      points: points,
      start: start,
      marks: marks,
      empty: empty || points.length < 2,
      emptyText: "Waiting for the first trade",
    });
  }

  function cardScanner(a) {
    a = a || {};
    const card = a.card || {};
    const title = card.title || ((a.pools != null ? a.pools : 0) + " pools");
    const feed = a.feed || [];
    let body;
    if (!feed.length) body = '<div class="card-empty">Listening for graduations</div>';
    else {
      body = '<div class="feed">' + feed.slice(0, 6).map(function (f) {
        if (f.verdict === "pass" || f.verdict === "passed") {
          return '<div class="row"><span>' + esc(f.name || f.line) + '</span><span class="pass">→ auditor</span></div>';
        }
        return '<div class="row"><span class="killed">' + esc(f.name || "") + '</span><span class="reason">' +
          esc(f.reason || "") + "</span></div>";
      }).join("") + "</div>";
    }
    return '<article class="agent-card scanner" data-go="agents"><div class="kicker">Scanner</div><h3>' +
      esc(title) + "</h3>" + body + "</article>";
  }
  function cardAuditor(a) {
    a = a || {};
    const card = a.card || {};
    const title = card.title || ((a.taken != null ? a.taken : 0) + " taken apart");
    const strips = a.strips || (a.current && a.current.layers) || [];
    const phase = card.phase || card.subtitle || "";
    let stripH = '<div class="strips">';
    for (let i = 0; i < 8; i++) {
      const L = strips[i] || {};
      const cls = L.pass === true ? "ok" : L.pass === false ? "no" : (L.pass == null && L.value && L.value !== "not checked" ? "run" : "");
      stripH += '<div class="strip ' + cls + '"></div>';
    }
    stripH += "</div>";
    const sub = esc(phase || (card.rejected != null ? card.rejected + " rejected" : ""));
    const rejected = a.rejected != null ? a.rejected : (card.rejected != null ? card.rejected : 0);
    return '<article class="agent-card auditor" data-go="auditor"><div class="kicker">Auditor</div><h3>' +
      esc(title) + "</h3>" + stripH + '<div class="card-empty">' + sub +
      (rejected ? '<div style="margin-top:6px">' + rejected + " rejected</div>" : "") +
      "</div></article>";
  }
  function cardAnalyst(a) {
    a = a || {};
    const card = a.card || {};
    return '<article class="agent-card analyst" data-go="agents"><div class="kicker">Analyst</div><h3>Scoring</h3>' +
      '<div class="ring-wrap"><canvas id="score-ring" width="96" height="96"></canvas>' +
      (card.score != null ? '<div>Score ' + esc(String(card.score)) + (card.passed ? " · passed" : card.passed === false ? " · rejected" : "") + "</div>" : '<div class="card-empty">Waiting for a coin</div>') +
      "</div></article>";
  }
  function cardExecutor(a) {
    a = a || {};
    const card = a.card || {};
    const title = card.title || ((a.trades != null ? a.trades : 0) + " trades");
    const size = card.size || "";
    const bar = card.bar;
    let barH = "";
    if (bar) {
      barH = '<div class="exec-bar" data-pct="' + esc(String(bar.pct == null ? 100 : bar.pct)) + '"><div class="fill"></div><div class="lbl">' +
        esc(bar.label || "✓ Filled") + "</div></div>";
    }
    return '<article class="agent-card executor" data-go="agents"><div class="kicker">Executor</div><h3>' +
      esc(title) + "</h3>" + (size ? '<div class="num" style="font-size:15px;margin-bottom:12px">' + esc(size) + "</div>" : "") +
      barH + "</article>";
  }
  function cardRisk(a) {
    a = a || {};
    const card = a.card || {};
    const title = card.title || "Guarding";
    const pills = card.pills || {};
    return '<article class="agent-card risk" data-go="agents"><div class="kicker">Risk</div><h3>' +
      esc(title) + "</h3>" +
      (card.lastExit && title !== card.lastExit ? '<div class="card-empty">' + esc(card.lastExit) + "</div>" : "") +
      '<div class="pills"><span class="pill stop">' + esc(pills.stop || "stop") +
      '</span><span class="pill trail">' + esc(pills.trail || "trail") + "</span></div></article>";
  }
  function animateExecBar() {
    const el = document.querySelector(".exec-bar");
    if (!el) return;
    const fill = el.querySelector(".fill");
    const pct = Number(el.getAttribute("data-pct") || 100);
    if (Charts.reduced()) { fill.style.width = pct + "%"; return; }
    fill.style.width = "0%";
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { fill.style.width = pct + "%"; });
    });
  }

  function activityRow(it) {
    const mint = it.mint || "";
    const kind = (it.kind || "").toLowerCase();
    const go = (kind === "rejected" || kind === "skipped") ? "auditor" : "coin";
    const sub = it.subtitle || ((it.agent || "") + (it.detail ? " · " + it.detail : ""));
    const val = it.value || it.amount || "";
    return '<button class="row-card" data-go="' + go + '" data-mint="' + esc(mint) + '">' +
      '<div class="mid"><div class="ttl">' + esc(it.title || "") + '</div><div class="sub">' + esc(sub) +
      "</div></div><div class=\"val " + valUp(val) + '">' + esc(val) + "</div></button>";
  }

  function renderAgents() {
    if (!state) return renderLoading("agents");
    const ag = agentsOf();
    const order = ["scanner", "auditor", "analyst", "executor", "risk"];
    let h = navbar({ title: "Agents" }) + errorRow() + '<div class="page-pad">';
    const any = order.some(function (k) { return ag[k]; });
    if (!any) {
      h += '<div class="empty-note">Listening for graduations</div>';
    } else {
      order.forEach(function (k) { h += fullAgent(k, ag[k] || { name: k }); });
    }
    h += "</div>" + tabbar();
    $app.innerHTML = h;
    const ring = document.getElementById("score-ring-tab");
    if (ring && window.Charts) {
      Charts.scoreRing(ring, (ag.analyst && ag.analyst.card && ag.analyst.card.score), { min: 70, size: 72 });
    }
  }
  function fullAgent(key, a) {
    a = a || {};
    const card = a.card || {};
    const name = a.name || (key.charAt(0).toUpperCase() + key.slice(1));
    const paused = !!a.paused;
    const running = !paused && (a.status === "ok" || a.status === "running" || a.status);
    const count = card.title || "";
    const locked = key === "risk" && ((state.positions || []).some(function (p) { return p.status === "open"; }));
    const decisions = a.decisions || [];
    let h = '<article class="full-card"><div class="top">';
    h += '<span class="dot' + (paused ? " paused" : running ? "" : " off") + '"></span>';
    h += "<h3>" + esc(name) + "</h3>";
    h += '<span class="count">' + esc(count) + "</span>";
    h += '<button class="switch' + (paused ? "" : " on") + '" disabled title="Change via Telegram: /pause ' + esc(name) + '"></button>';
    h += "</div>";
    if (locked) h += '<div class="note">Risk is locked while a position is open.</div>';
    if (key === "analyst") {
      h += '<canvas id="score-ring-tab" width="72" height="72" style="width:72px;height:72px;margin:8px 0"></canvas>';
    }
    if (decisions.length) {
      h += '<div class="decisions">';
      decisions.slice(0, 20).forEach(function (d) {
        h += '<div class="d"><span>' + esc(d.time || "") + '</span><a class="coin" href="' +
          esc(d.url || "#") + '" target="_blank" rel="noopener">' + esc(d.coin || "") +
          "</a><span>" + esc((d.verdict || "") + (d.reason ? " · " + d.reason : "")) + "</span></div>";
      });
      h += "</div>";
    }
    h += '<button class="settings-link" data-go="account" data-group="' + esc(key) + '">Settings</button>';
    h += "</article>";
    return h;
  }

  function renderActivity() {
    if (!state) return renderLoading("activity");
    const list = items();
    let h = navbar({ title: "Activity" }) + errorRow();
    if (!list.length) h += '<div class="empty-note">Nothing yet tonight</div>';
    else h += '<div class="list">' + list.map(activityRow).join("") + "</div>";
    h += tabbar();
    $app.innerHTML = h;
    unread = false;
    if (list.length && list[0].id) seenActivityId = list[0].id;
  }

  function renderAccount() {
    if (!state) return renderLoading("account");
    const paper = (state.mode || "").toUpperCase() === "PAPER";
    const handle = state.fomoHandle || "";
    const profile = state.profileUrl || "";
    const invite = state.inviteUrl || state.signupUrl || "";
    let h = navbar({ title: "Account" }) + errorRow();
    h += '<div class="page-pad">';
    h += '<div class="group">Mode</div><div class="mode-switch">';
    h += '<button class="' + (paper ? "on paper" : "") + '">PAPER</button>';
    h += '<button class="' + (paper ? "" : "on") + '">LIVE</button></div>';
    h += '<div class="note">' + esc(state.settingsNote || "Change mode and settings with Telegram commands.") + "</div>";
    h += '<div class="setting"><label>Stack</label><input type="text" class="num-input" lang="en" disabled value="' +
      esc(money(state.stackUsd != null ? state.stackUsd : state.paperStartStack, 2)) + '"></div>';

    h += '<button class="link-row" data-act="open" data-url="' + esc(profile) + '"><span>Your FOMO profile' +
      (handle ? " · @" + esc(handle) : "") + '</span><span class="chev">›</span></button>';
    h += '<button class="link-row" data-act="share" data-url="' + esc(invite) +
      '"><span>Invite a friend</span><span class="chev">›</span></button>';
    h += '<div class="note" id="copy-note" hidden>Link copied</div>';

    const grouped = state.settings || {};
    const keys = Object.keys(grouped);
    keys.forEach(function (g) {
      h += '<div class="group" id="g-' + esc(g) + '">' + esc(labelGroup(g)) + "</div>";
      const items = Array.isArray(grouped[g]) ? grouped[g] : objectSettings(grouped[g]);
      items.forEach(function (s) {
        h += settingRow(s);
      });
    });

    h += '<div class="group">Telegram</div>';
    const bot = state.botUsername ? "@" + state.botUsername : "connected";
    h += '<div class="setting"><label>Telegram</label><span class="num">' +
      esc(state.notifier === "telegram" ? bot : "not connected") + "</span></div>";
    h += '<div class="note">Send a test push from the bot with any command, or type /status.</div>';
    h += '<div class="group">Notifications</div>';
    h += '<div class="note">' + esc(state.webPushNote || "Pushes go to Telegram. Web push is not available on this host.") + "</div>";
    h += "</div>" + tabbar();
    $app.innerHTML = h;
  }
  function labelGroup(g) {
    const m = { scanner: "Scanner", auditor: "Auditor", analyst: "Analyst", executor: "Executor", risk: "Risk", desk: "Desk", fees: "Fees" };
    return m[g] || g;
  }
  function objectSettings(obj) {
    if (!obj || typeof obj !== "object") return [];
    if (obj.key && obj.value != null) return [obj];
    return Object.keys(obj).map(function (k) {
      const v = obj[k];
      if (v && typeof v === "object" && ("value" in v || "v" in v)) {
        return { key: v.key || k, name: v.name || v.label || k, value: v.value != null ? v.value : v.v, min: v.min, max: v.max, unit: v.unit };
      }
      return { key: k, name: k, value: v };
    });
  }
  function settingRow(s) {
    if (!s) return "";
    const name = s.name || s.label || s.short || shortKey(s.key);
    const val = s.value != null ? s.value : s.v;
    const min = s.min != null ? s.min : s.lo, max = s.max != null ? s.max : s.hi;
    const numeric = typeof val === "number";
    const bool = typeof val === "boolean";
    const key = String(s.key || name || "");
    let ctrl = "";
    if (bool) {
      ctrl = '<button class="switch' + (val ? " on" : "") + '" disabled></button>';
    } else if (numeric && min != null && max != null) {
      const shown = plainNum(val);
      ctrl = '<input type="range" disabled min="' + esc(String(min)) + '" max="' + esc(String(max)) +
        '" step="any" value="' + esc(String(val)) + '">' +
        '<input type="text" class="num-input" inputmode="decimal" lang="en" disabled value="' + esc(shown) + '">';
    } else if (numeric) {
      ctrl = '<input type="text" class="num-input" inputmode="decimal" lang="en" disabled value="' +
        esc(plainNum(val)) + '">';
    } else {
      const text = val == null ? "" : String(val);
      const long = text.length > 18 || /^https?:\/\//.test(text) || /url|rpc/i.test(key);
      if (long) {
        ctrl = '<button type="button" class="val-long" data-act="reveal" data-full="' + esc(text) +
          '" aria-label="' + esc(name) + ': ' + esc(text) + '">' +
          '<span class="val-full">' + esc(text) + "</span></button>";
      } else {
        ctrl = '<input type="text" class="num-input" lang="en" disabled value="' + esc(text) + '">';
      }
    }
    return '<div class="setting"><label>' + esc(name) + "</label>" + ctrl + "</div>";
  }
  function shortKey(k) {
    if (!k) return "";
    const i = String(k).lastIndexOf(".");
    return i >= 0 ? k.slice(i + 1).replace(/_/g, " ") : String(k).replace(/_/g, " ");
  }

  function renderAuditor() {
    if (!state && error) return renderLoading("auditor");
    const ag = agentsOf().auditor || {};
    let cur = ag.current || null;
    if (auditMint && coin && coin.audit) {
      cur = {
        mint: coin.mint || auditMint,
        name: coin.name,
        url: coin.url || coin.coinUrl,
        layers: coin.audit.layers || [],
        passed: coin.audit.passed,
        reason: coin.audit.reason,
        holders: coin.holders,
      };
    }
    if (auditMint && !cur && coin) {
      cur = { mint: auditMint, name: coin.name, url: coin.url, layers: (coin.audit && coin.audit.layers) || [], passed: coin.audit && coin.audit.passed, reason: coin.audit && coin.audit.reason };
    }
    let h = navbar({ title: (cur && cur.name) || "Auditor", back: "home" }) + errorRow();
    if (!cur || !(cur.layers && cur.layers.length)) {
      h += '<div class="empty-note">No coin taken apart yet</div>' + tabbar();
      $app.innerHTML = h;
      return;
    }
    const layers = cur.layers;
    h += '<div class="discs" id="discs">';
    h += '<div class="beam" id="beam"></div>';
    layers.forEach(function (L, i) {
      h += '<div class="disc" data-i="' + i + '" data-pass="' +
        (L.pass === true ? "1" : L.pass === false ? "0" : "") + '"><span class="n">' +
        esc(String(L.n || i + 1)) + "</span></div>";
    });
    h += "</div>";
    h += '<div class="layers">';
    layers.forEach(function (L) {
      h += '<div class="layer"><span class="vn">' + esc(L.name || "") + '</span><span class="vv">' +
        esc(L.value || L.value_text || "") + "</span></div>";
    });
    h += "</div>";
    if (cur.passed === true) {
      const size = (ag.card && ag.card.size) || "";
      h += '<div class="verdict ok">Cleared · 8/8 parts</div>';
      h += '<div class="verdict-sub">Sent to Executor' + (size ? " · " + esc(size) : "") + "</div>";
    } else if (cur.passed === false) {
      h += '<div class="verdict no">Rejected · ' + esc(cur.reason || "failed") + "</div>";
      h += '<div class="verdict-sub">Grok Bot won\'t buy ' + esc(cur.name || "X") + "</div>";
    }
    const enabled = settingValue("auditor.enabled");
    h += '<div class="toggle-row"><span>Take apart before buying</span>' +
      '<button class="switch' + (enabled === false ? "" : " on") + '" disabled title="Change via Telegram"></button></div>';
    if (cur.url) {
      h += '<a class="cta" href="' + esc(cur.url) + '" target="_blank" rel="noopener">Open on FOMO</a>';
    }
    h += tabbar();
    $app.innerHTML = h;
    runBeam(layers);
  }
  function settingValue(key) {
    const g = (state && state.settings) || {};
    // grouped arrays or objects
    let found;
    Object.keys(g).forEach(function (k) {
      const arr = Array.isArray(g[k]) ? g[k] : objectSettings(g[k]);
      arr.forEach(function (s) {
        if ((s.key === key || s.name === key) && found === undefined) found = s.value;
      });
    });
    return found;
  }
  function runBeam(layers) {
    const discs = document.querySelectorAll(".disc");
    const beam = document.getElementById("beam");
    if (!discs.length) return;
    const reduce = window.Charts && Charts.reduced();
    function paint(i, final) {
      const el = discs[i];
      if (!el) return;
      const p = el.getAttribute("data-pass");
      if (p === "1") {
        el.classList.add("ok");
        el.innerHTML = '<span class="mark">✓</span>';
      } else if (p === "0") {
        el.classList.add("no");
        el.innerHTML = '<span class="mark">×</span>';
      }
    }
    if (reduce) {
      layers.forEach(function (_, i) { paint(i, true); });
      if (beam) beam.style.display = "none";
      return;
    }
    // Never show a result the server didn't send — data-pass is already only set for sent results.
    let i = 0;
    const discH = discs[0].offsetHeight || 56;
    const gap = 8;
    function step() {
      if (!beam || !discs[i]) return;
      const top = discs[i].offsetTop;
      beam.style.transition = "top 350ms ease, height 350ms ease";
      beam.style.top = top + "px";
      beam.style.height = discH + "px";
      const pass = discs[i].getAttribute("data-pass");
      // If the server has not sent this layer yet, wait (next poll will re-render).
      if (pass === "" && i > 0) {
        // stay on this layer
        return;
      }
      setTimeout(function (idx) {
        return function () {
          paint(idx, true);
          i++;
          if (i < discs.length) setTimeout(step, 150);
          else if (beam) {
            setTimeout(function () { beam.style.opacity = "0"; }, 200);
          }
        };
      }(i), pass === "" ? 350 : 150);
    }
    step();
  }

  function renderCoin() {
    if (!state && error) return renderLoading("coin");
    const c = coin;
    const paper = state && (state.mode || "").toUpperCase() === "PAPER";
    if (!c) {
      let h = navbar({ title: "Coin", back: "home" }) + errorRow();
      h += '<div class="empty-note">No position, and this coin is not on the desk tonight.</div>' + tabbar();
      $app.innerHTML = h;
      return;
    }
    const pos = c.position;
    const hasPos = pos && (pos.status === "open" || pos.status === "exiting");
    let h = navbar({
      title: (c.name || "Coin") + (paper ? "" : ""),
      back: "home",
    }) + errorRow();
    h += '<div class="coin-head">';
    h += '<div style="display:flex;align-items:center;gap:8px"><div class="coin-meta">' +
      esc((c.symbol || c.name || "") + " · " + (c.chain || "Solana") + (c.age ? " · " + c.age : "")) +
      "</div>";
    if (c.shield) h += '<span class="shield">' + esc(c.shield) + "</span>";
    if (paper) h += '<span class="paper-pill" style="margin:0 0 0 auto">PAPER</span>';
    h += "</div>";
    h += '<div class="price-lg num">' + priceFmt(c.price) + "</div>";
    if (c.changeSinceEntry != null && hasPos) {
      const up = Number(c.changeSinceEntry) >= 0;
      h += '<div class="since ' + (up ? "up" : "down") + '">' +
        (up ? "▲ " : "▼ ") + esc(pctFmt(c.changeSinceEntry, true)) + " since entry</div>";
    }
    h += "</div>";
    h += '<div class="candle-wrap"><canvas id="coin-candles"></canvas></div>';
    const st = c.stats || {};
    h += '<div class="stats">';
    h += stat("Market cap", st.marketCap != null ? money(st.marketCap, 0) : "n/a");
    h += stat("Liquidity", st.liquidity != null ? money(st.liquidity, 0) : "n/a");
    h += stat("24h volume", st.volume24h != null ? money(st.volume24h, 0) : "n/a");
    const hold = st.holders != null ? st.holders : c.holders;
    h += stat("Holders", hold != null ? String(hold) : "n/a");
    h += "</div>";
    if (hasPos) {
      h += '<div class="pos-card"><h4>Your position · ' + money(pos.sizeUsd, 2) + " in · Executor</h4>";
      h += '<div class="stat-v">Entry ' + priceFmt(pos.entryPrice) +
        (pos.stopLabel ? " · stop " + esc(pos.stopLabel) : "") + "</div></div>";
      const rl = c.riskLine || c.exits || {};
      h += '<div class="exit-card"><h4>Exit</h4>';
      if (rl.stopLine != null) h += '<div>Stop line · ' + priceFmt(rl.stopLine) + "</div>";
      if (rl.trailLine != null) h += '<div>Trail line · ' + priceFmt(rl.trailLine) + "</div>";
      const left = pos.timeoutLeft || c.timeoutLeft;
      if (left) h += "<div>Time left to timeout · " + esc(left) + "</div>";
      h += "</div>";
    }
    const url = c.coinUrl || c.url;
    if (url) {
      const label = hasPos ? "Sell on FOMO" : "Buy on FOMO";
      h += '<a class="cta' + (hasPos ? " sell" : "") + '" href="' + esc(url) + '" target="_blank" rel="noopener">' + label + "</a>";
    }
    h += tabbar();
    $app.innerHTML = h;
    const cv = document.getElementById("coin-candles");
    if (cv && window.Charts) {
      const rl = c.riskLine || c.exits || {};
      Charts.candles(cv, {
        candles: c.candles || [],
        exitLine: rl.price != null ? rl.price : (rl.trailLine != null ? rl.trailLine : rl.stopLine),
        exitLabel: rl.label || (rl.trailLine ? "Risk trailing stop" : "Risk stop"),
      });
    }
  }
  function stat(k, v) {
    return '<div><div class="stat-k">' + esc(k) + '</div><div class="stat-v">' + esc(v) + "</div></div>";
  }

  function skelRow() {
    return '<div class="row-card skel-row">' +
      '<div class="mid"><div class="skel" style="height:17px;width:58%;margin-bottom:8px;border-radius:6px"></div>' +
      '<div class="skel" style="height:13px;width:38%;border-radius:6px"></div></div>' +
      '<div class="skel" style="height:17px;width:72px;border-radius:6px"></div></div>';
  }
  function renderLoading(which) {
    which = which || route || "home";
    let h = navbar(which === "home" ? { linkProfile: true } : { title: titleFor(which) }) + errorRow();
    if (which === "activity") {
      h += '<div class="list">' + [0,1,2,3,4,5].map(skelRow).join("") + "</div>";
    } else if (which === "account") {
      h += '<div class="page-pad">';
      h += '<div class="skel" style="height:18px;width:72px;margin:10px 0 8px;border-radius:6px"></div>';
      h += '<div class="skel" style="height:42px;margin-bottom:16px;border-radius:10px"></div>';
      h += '<div class="skel" style="height:44px;margin-bottom:8px;border-radius:8px"></div>';
      h += '<div class="skel" style="height:44px;margin-bottom:8px;border-radius:8px"></div>';
      h += '<div class="skel" style="height:18px;width:90px;margin:16px 0 8px;border-radius:6px"></div>';
      for (let i = 0; i < 6; i++) {
        h += '<div class="skel" style="height:56px;margin-bottom:8px;border-radius:8px"></div>';
      }
      h += "</div>";
    } else if (which === "agents") {
      h += '<div class="page-pad">';
      for (let i = 0; i < 5; i++) {
        h += '<div class="skel" style="height:160px;margin-bottom:12px;border-radius:18px"></div>';
      }
      h += "</div>";
    } else {
      // Home (and fallback): odometer, chart, cards — final layout.
      h += '<div class="page-pad">';
      h += '<div class="skel" style="height:72px;width:70%;margin-bottom:10px;border-radius:12px"></div>';
      h += '<div class="skel" style="height:22px;width:40%;margin-bottom:16px;border-radius:8px"></div>';
      h += '<div class="skel" style="height:210px;margin-bottom:16px;border-radius:16px"></div>';
      h += '<div class="skel" style="height:220px;border-radius:42px"></div>';
      h += "</div>";
    }
    h += tabbar();
    $app.innerHTML = h;
  }
  function titleFor(r) {
    return ({ agents: "Agents", activity: "Activity", account: "Account", auditor: "Auditor", coin: "Coin" })[r] || fomoHandle();
  }

  function renderSearch() {
    // overlay on top of current
    const box = document.createElement("div");
    box.className = "overlay";
    box.innerHTML = '<div class="sheet"><input class="search-input" id="q" placeholder="Name, symbol or mint" value="' +
      esc(searchQ) + '" autofocus><div id="hits"></div></div>';
    $app.appendChild(box);
    const input = box.querySelector("#q");
    const hits = box.querySelector("#hits");
    function run() {
      searchQ = input.value.trim();
      hits.innerHTML = searchHits(searchQ);
    }
    input.addEventListener("input", run);
    box.addEventListener("click", function (e) {
      if (e.target === box) { searchOpen = false; box.remove(); }
    });
    run();
    setTimeout(function () { input.focus(); }, 30);
  }
  function searchHits(q) {
    if (!q) return '<div class="empty-note">Type a name, symbol or mint.</div>';
    const ql = q.toLowerCase();
    const seen = {};
    const out = [];
    function add(mint, name, url, where) {
      if (!mint || seen[mint]) return;
      const n = (name || "") + " " + mint;
      if (n.toLowerCase().indexOf(ql) === -1) return;
      seen[mint] = true;
      out.push({ mint: mint, name: name || mint.slice(0, 8), url: url, where: where });
    }
    items().forEach(function (it) { add(it.mint, it.name, it.url, it.kind); });
    (state && state.positions || []).forEach(function (p) { add(p.mint, p.name, p.url, "position"); });
    const feed = (agent("scanner").feed || []);
    feed.forEach(function (f) { add(f.mint, f.name, f.url, f.verdict); });
    Object.keys(coins).forEach(function (m) { add(m, coins[m].name, coins[m].url, "coin"); });
    if (!out.length) return '<div class="empty-note">No matches.</div>';
    return out.map(function (x) {
      return '<button class="search-hit" data-go="coin" data-mint="' + esc(x.mint) + '">' +
        esc(x.name) + '<div class="sub" style="color:var(--secondary);font-size:13px">' + esc(x.mint) + "</div></button>";
    }).join("");
  }

  function renderBell() {
    unread = false;
    const box = document.createElement("div");
    box.className = "overlay";
    const list = items().slice(0, 12);
    if (list.length && list[0].id) seenActivityId = Math.max(seenActivityId, list[0].id);
    box.innerHTML = '<div class="sheet"><div style="font-weight:650;margin-bottom:8px">Grok Bot · now</div>' +
      (list.length ? list.map(function (it) {
        return '<button class="search-hit" data-go="' +
          (((it.kind || "").toLowerCase() === "rejected") ? "auditor" : "coin") +
          '" data-mint="' + esc(it.mint || "") + '">' + esc(it.title || "") +
          '<div class="sub" style="color:var(--secondary);font-size:13px">' +
          esc((it.subtitle || it.detail || "") + (it.value ? " · " + it.value : "")) +
          "</div></button>";
      }).join("") : '<div class="empty-note">No pushes tonight.</div>') + "</div>";
    $app.appendChild(box);
    box.addEventListener("click", function (e) {
      if (e.target === box) { bellOpen = false; box.remove(); }
    });
  }

  function renderSetup() {
    const prev = document.getElementById("desk-link");
    const keep = prev ? prev.value : (setupDraft || "");
    const focused = document.activeElement === prev;
    const sel = (prev && focused) ? [prev.selectionStart, prev.selectionEnd] : null;
    setupDraft = keep;
    let h = navbar({ title: titleFor(route) }) + '<div class="page-pad">';
    h += '<div class="setup-card">';
    h += "<h2>Open your desk</h2>";
    h += "<p>This copy of the app doesn't have your private link yet. Paste it below — the one that has #d= in it.</p>";
    h += '<form class="setup-form" action="#" novalidate>';
    h += '<label class="setup-label" for="desk-link">Paste your private desk link</label>';
    h += '<input id="desk-link" class="setup-input" type="url" inputmode="url" enterkeyhint="go" ';
    h += 'autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" ';
    h += 'placeholder="https://…#d=… or the id" value="' + esc(keep) + '"' + (setupBusy ? " disabled" : "") + ">";
    h += '<button type="button" class="setup-paste" data-act="paste-desk"' + (setupBusy ? " disabled" : "") + ">";
    h += "Paste from clipboard";
    h += "</button>";
    h += '<button type="submit" class="setup-save"' + (setupBusy ? " disabled" : "") + ">";
    h += setupBusy ? "Checking…" : "Save";
    h += "</button></form>";
    if (setupError) h += '<div class="setup-err" role="alert">' + esc(setupError) + "</div>";
    h += "</div></div>" + tabbar();
    $app.innerHTML = h;
    const input = document.getElementById("desk-link");
    const form = $app.querySelector(".setup-form");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        saveDeskLink();
      });
    }
    if (input) {
      input.value = keep;
      input.addEventListener("input", function () { setupDraft = input.value; });
      if (focused) {
        input.focus();
        if (sel) {
          try { input.setSelectionRange(sel[0], sel[1]); } catch (e) {}
        }
      }
    }
  }

  let paintedKey = null;
  function render() {
    parseHash();
    if (!DATA) {
      renderSetup();
      paintedKey = "setup:" + route;
      bind();
      return;
    }
    const key = route + ":" + (coinMint || auditMint || "");
    const shouldTop = paintedKey !== key;
    if (route === "home") renderHome();
    else if (route === "agents") renderAgents();
    else if (route === "activity") renderActivity();
    else if (route === "account") renderAccount();
    else if (route === "auditor") renderAuditor();
    else if (route === "coin") renderCoin();
    else renderHome();
    if (shouldTop) window.scrollTo(0, 0);
    paintedKey = key;

    // Analyst ring on home after paint
    const ring = document.getElementById("score-ring");
    if (ring && window.Charts) {
      const a = agent("analyst");
      Charts.scoreRing(ring, a.card && a.card.score, { min: (a.card && a.card.minScore) || 70, size: 96 });
    }
    bind();
  }

  function bind() {
    const ranges = document.getElementById("ranges");
    if (ranges) {
      ranges.addEventListener("click", function (e) {
        const b = e.target.closest("[data-range]");
        if (!b) return;
        chartRange = b.getAttribute("data-range");
        ranges.querySelectorAll("button").forEach(function (x) {
          x.classList.toggle("on", x === b);
        });
        const empty = !((chart.marks || []).length);
        drawHomeChart(empty && chartRange === "LIVE" && !(state.positions || []).length);
      });
    }
  }
  // Use one delegated listener on document to avoid stacking
  let bound = false;
  function onClick(e) {
    // Never hijack taps on fields — iOS standalone will not focus an
    // <input> if a parent click handler calls preventDefault().
    if (e.target.closest("input, textarea, select, label")) return;
    if (e.target.closest("[data-act='paste-desk']")) {
      e.preventDefault();
      pasteDeskLink();
      return;
    }
    const reveal = e.target.closest("[data-act='reveal']");
    if (reveal) {
      reveal.classList.toggle("open");
      return;
    }
    const share = e.target.closest("[data-act='share']");
    if (share) {
      const url = share.getAttribute("data-url");
      if (navigator.share) {
        navigator.share({ title: "FOMO", url: url }).catch(function () { copyLink(url); });
      } else copyLink(url);
      return;
    }
    const open = e.target.closest("[data-act='open']");
    if (open) {
      const u = open.getAttribute("data-url");
      if (u) window.open(u, "_blank", "noopener");
      return;
    }
    if (e.target.closest("[data-act='search']")) { searchOpen = true; renderSearch(); return; }
    if (e.target.closest("[data-act='bell']")) { bellOpen = true; renderBell(); return; }
    const hit = e.target.closest("[data-go]");
    if (!hit) return;
    // don't hijack real FOMO <a> decisions
    if (hit.tagName === "A" && hit.getAttribute("href") && hit.getAttribute("href").charAt(0) !== "#") return;
    e.preventDefault();
    const r = hit.getAttribute("data-go");
    const mint = hit.getAttribute("data-mint");
    go(r, mint);
  }
  if (!bound) {
    document.addEventListener("click", onClick);
    bound = true;
  }

  function copyLink(url) {
    const done = function () {
      const n = document.getElementById("copy-note");
      if (n) { n.hidden = false; setTimeout(function () { n.hidden = true; }, 1600); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(done);
    } else done();
  }

  async function tick() {
    const prev = route;
    parseHash();
    await loadAll();
    // countdown for error banner
    if (error === "fetch") retryIn = Math.round(POLL_MS / 1000);
    render();
  }

  window.addEventListener("hashchange", function () {
    parseHash();
    window.scrollTo(0, 0);
    render();
    loadAll().then(render);
  });
  window.addEventListener("popstate", function () {
    parseHash();
    window.scrollTo(0, 0);
    render();
  });
  function adoptFromHash() {
    const before = DATA;
    const found = parseHash();
    if (found && DATA && DATA !== before) {
      error = null;
      loadAll().then(render);
      return true;
    }
    return found;
  }
  window.addEventListener("pageshow", function () {
    // Re-read location.hash on every show, not only the first load
    // or a bfcache restore — iOS can populate the fragment late.
    adoptFromHash();
    window.scrollTo(0, 0);
    render();
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    if (adoptFromHash() && DATA) return;
  });

  // SW: cache the shell. No push subscription (plan B).
  // Reload once when a new worker claims the page so the installed
  // home-screen app picks up the bumped cache (desk-shell-v8).
  if ("serviceWorker" in navigator && !isLocalHost()) {
    var swRefreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (swRefreshing) return;
      swRefreshing = true;
      location.reload();
    });
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }

  parseHash();
  render(); // skeletons in the final layout immediately, before the first fetch
  tick();
  timer = setInterval(tick, POLL_MS);
  countdownTimer = setInterval(function () {
    if (error === "fetch" && retryIn > 0) {
      retryIn -= 1;
      const row = document.querySelector(".error-row");
      if (row) {
        const t = lastGoodAt ? pragueTime(lastGoodAt) : "—";
        row.textContent = "Desk offline · retrying in " + retryIn + "s · last update " + t;
      }
    }
  }, 1000);
})();
