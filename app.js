/* Desk app. Live data comes from a secret gist.
   Opens as {URL}#d={id}[/route]; the id is kept in localStorage.
   The id is never embedded in this file. Settings are read-only. No web push.

   Unauthenticated GitHub API is 60 req/h and raw gist CDNs cache for 5
   minutes (query-string bust is ignored), so we poll the gist API once
   per minute with cache: 'no-store' and no custom headers (CORS ACAO=*,
   and a simple GET avoids a preflight). One API response carries every
   file, including flattened coin_{mint}.json. */
(function () {
  "use strict";

  // 60s: unauthenticated api.github.com limit is 60 req/h.
  const POLL_MS = 60 * 1000;
  const LS_D = "desk.d";
  const $app = document.getElementById("app");
  let DATA = "";
  let route = "home"; // home | agents | auditor | coin | account
  let coinMint = null;
  let state = null;
  let activity = { items: [] };
  let chart = { positions: [] };
  let coin = null;
  let error = null; // 'missing' | 'fetch' | 'http' | null
  let emptyForced = false;
  let timer = null;
  let gistFiles = null;

  function isLocalHost() {
    const h = location.hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  }

  function applyRoute(rest) {
    rest = (rest || "").replace(/\/+$/, "");
    if (!rest || rest === "home") route = "home";
    else if (rest === "agents") route = "agents";
    else if (rest === "auditor") route = "auditor";
    else if (rest === "account") route = "account";
    else if (rest.startsWith("coin/")) {
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
        applyRoute("");
        return true;
      }
    } catch (e) {}
    DATA = "";
    route = "home";
    return false;
  }

  function go(r, mint) {
    if (!DATA) return;
    let path = "d=" + encodeURIComponent(DATA);
    if (r === "coin" && mint) path += "/coin/" + mint;
    else if (r && r !== "home") path += "/" + r;
    location.hash = path;
  }

  function gistFileName(rel) {
    if (rel.startsWith("coin/") && rel.endsWith(".json")) {
      return "coin_" + rel.slice(5);
    }
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
      try { out[name] = JSON.parse(f.content); }
      catch (e) {}
    });
    return out;
  }

  async function loadAll() {
    if (!DATA) {
      error = "missing";
      return;
    }
    try {
      if (isLocalHost()) {
        const [s, a, c] = await Promise.all([
          fetchLocalJSON("state.json"),
          fetchLocalJSON("activity.json").catch(function () { return { items: [] }; }),
          fetchLocalJSON("chart.json").catch(function () { return { positions: [] }; }),
        ]);
        state = s;
        activity = a || { items: [] };
        chart = c || { positions: [] };
        error = s && s.error ? "desk" : null;
        if (route === "coin" && coinMint) {
          try { coin = await fetchLocalJSON("coin/" + coinMint + ".json"); }
          catch (e) { coin = null; }
        }
        return;
      }
      gistFiles = await fetchGistBundle();
      state = gistFiles["state.json"];
      if (!state) throw new Error("no state");
      activity = gistFiles["activity.json"] || { items: [] };
      chart = gistFiles["chart.json"] || { positions: [] };
      error = state && state.error ? "desk" : null;
      if (route === "coin" && coinMint) {
        coin = gistFiles[gistFileName("coin/" + coinMint + ".json")] || null;
      }
    } catch (e) {
      error = "fetch";
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
    n = Math.abs(n);
    if (n >= 1e6) return sign + "$" + (n / 1e6).toFixed(1) + "M";
    if (n >= 10000) return sign + "$" + (n / 1e3).toFixed(1) + "K";
    if (digits == null) digits = n < 100 ? 2 : 0;
    return sign + "$" + n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  function pct(n, d) {
    if (n == null) return "—";
    n = Number(n);
    const s = (n >= 0 ? "+" : "") + n.toFixed(d == null ? 1 : d) + "%";
    return s;
  }
  function coinA(name, url) {
    if (!url) return esc(name);
    return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(name)}</a>`;
  }

  function nav(active) {
    const item = (id, label, glyph) =>
      `<button class="${active === id ? "on" : ""}" data-go="${id}"><span class="ico">${glyph}</span>${label}</button>`;
    return `<nav class="nav">${item("home", "Home", "D")}${item("agents", "Agents", "A")}${item("account", "Account", "·")}</nav>`;
  }

  function badge(mode) {
    return `<span class="badge ${esc(mode || "PAPER")}">${esc(mode || "PAPER")}</span>`;
  }

  /* ---------- screens ---------- */
  function renderError() {
    const missing = error === "missing";
    return `<div class="screen-error" data-screen="error">
      <div class="mark">?</div>
      <h1>${missing ? "Can't reach the desk" : "Can't reach the desk"}</h1>
      <p>${missing
        ? "This app opens as a link with #d=… on the end. That fragment is missing, so I have nothing to load."
        : "The desk files didn't answer. Check that the process is running and try again."}</p>
      <button class="btn btn-cyan" data-retry>Try again</button>
    </div>`;
  }

  function emptyBlock(title, body, glyph) {
    return `<div class="screen-empty" data-screen="empty">
      <div class="mark">${glyph || "○"}</div>
      <h1>${esc(title)}</h1>
      <p>${esc(body)}</p>
    </div>`;
  }

  function renderHome() {
    if (!state) return renderError();
    const mode = state.mode || "PAPER";
    const positions = state.positions || [];
    const items = (activity && activity.items) || [];
    const isEmpty = emptyForced || (!positions.length && !items.length && !(state.agents && state.agents.scanner && state.agents.scanner.pools));
    let body = "";
    if (isEmpty) {
      body = emptyBlock("Waiting for the first coin tonight.", "The scanner is listening for Pump.fun graduations. Activity will land here.", "○");
    } else {
      const pos = positions.length
        ? `<div class="section"><h2>Open positions</h2><div class="card pos">${positions
            .map((p) => {
              const up = (p.pct || 0) >= 0;
              return `<div class="pos-row">
                <div class="pos-name">${coinA(p.name, p.url)}
                  <div class="meta">${money(p.sizeUsd, 2)} · stop ${esc(p.stopLabel || "")}</div>
                </div>
                <div class="pnl ${up ? "up" : "down"}">${pct(p.pct)}</div>
                <a class="sell-btn" href="${esc(p.url)}" target="_blank" rel="noopener">Sell on FOMO</a>
              </div>`;
            })
            .join("")}</div></div>`
        : `<div class="section"><h2>Open positions</h2><div class="card" style="color:var(--muted);font-size:13px">None open.</div></div>`;

      const act = items.length
        ? `<div class="section"><h2>Activity</h2><div class="card act">${items
            .map((it) => {
              const title = it.url ? coinA(it.title, it.url) : esc(it.title);
              return `<div class="act-row ${esc(it.kind || "")}">
                <div class="act-title">${title}</div>
                <div class="act-amt">${esc(it.amount || "")}</div>
                <div class="act-agent">${esc(it.agent || "")}${it.detail ? " · " + esc(it.detail) : ""} · ${esc(it.time || "")}</div>
                <div class="act-mark">${esc(it.mark || "")}</div>
              </div>`;
            })
            .join("")}</div></div>`
        : `<div class="section"><h2>Activity</h2><div class="card" style="color:var(--muted);font-size:13px">Nothing yet tonight.</div></div>`;
      body = pos + act;
    }
    const warn = state.ticketWarning && state.ticketWarning.message
      ? `<div class="warn">${esc(state.ticketWarning.message)}</div>`
      : "";
    return `<header class="top"><div class="brand">Desk <small>night</small></div>${badge(mode)}</header>
      <div class="balance">
        <div class="label">${mode === "PAPER" ? "Paper balance" : "Free stack"}</div>
        <div class="fig">${money(state.balanceUsd, 2)}</div>
        <div class="sub">stack ${money(state.stackUsd, 2)}</div>
      </div>
      ${warn}
      ${body}
      ${nav("home")}`;
  }

  function strips(layers) {
    if (!layers || !layers.length) return "";
    return `<div class="strips">${layers
      .map((L) => {
        const cls = L.pass === true ? "ok" : L.pass === false ? "red" : L.pass === null && L.value !== "not checked" ? "live" : "";
        return `<div class="strip ${cls}"><div class="ln">${esc(L.n)}. ${esc(L.name)}</div><div class="vl">${esc(L.value || "")}</div></div>`;
      })
      .join("")}</div>`;
  }

  function scoreRing(score, min) {
    const s = score == null ? 0 : Number(score);
    const r = 36, c = 2 * Math.PI * r;
    const dash = (Math.max(0, Math.min(100, s)) / 100) * c;
    const hot = score != null && score >= (min || 70);
    const color = hot ? "#4dffa0" : "#3ee0d4";
    const track = "#1c2030";
    return `<div class="ring-wrap">
      <div class="ring">
        <svg viewBox="0 0 88 88">
          <circle cx="44" cy="44" r="${r}" fill="none" stroke="${track}" stroke-width="7"/>
          <circle cx="44" cy="44" r="${r}" fill="none" stroke="${color}" stroke-width="7"
            stroke-linecap="round" stroke-dasharray="${dash} ${c}"/>
        </svg>
        <div class="num ${hot ? "hot" : ""}">${score == null ? "—" : esc(score)}</div>
      </div>
      <div><div class="agent-sub">Ring turns green from ${esc(min || 70)}.</div></div>
    </div>`;
  }

  function renderAgents() {
    if (!state) return renderError();
    const A = state.agents || {};
    const cards = [
      scannerCard(A.scanner),
      auditorCard(A.auditor),
      analystCard(A.analyst),
      executorCard(A.executor),
      riskCard(A.risk),
    ].join("");
    return `<div class="row-top"><h1>Agents</h1>${badge(state.mode)}</div>
      <div class="agents">${cards}</div>
      ${nav("agents")}`;
  }

  function statusLab(ag) {
    if (!ag) return "";
    const s = ag.paused ? "paused" : ag.status || "";
    return `<span class="agent-status ${ag.paused ? "paused" : ""}">${esc(s)}</span>`;
  }

  function scannerCard(ag) {
    ag = ag || {};
    const c = ag.card || {};
    const feed = (ag.feed || [])
      .slice(0, 8)
      .map((f) => {
        const cls = f.verdict === "kill" ? "kill" : "pass";
        const why = f.verdict === "kill" ? f.reason : "→ auditor";
        return `<div class="feed-row ${cls}"><span class="nm">${coinA(f.name, f.url)}</span><span class="why">${esc(why || "")}</span></div>`;
      })
      .join("");
    return `<div class="agent-card ok" data-go="agents">
      <div class="agent-head"><span class="agent-name">Scanner</span>${statusLab(ag)}</div>
      <div class="agent-title">${esc(c.title || "0 pools")}</div>
      <div class="agent-sub">${esc(c.subtitle || "")}</div>
      ${feed ? `<div class="feed">${feed}</div>` : ""}
    </div>`;
  }

  function auditorCard(ag) {
    ag = ag || {};
    const c = ag.card || {};
    return `<div class="agent-card ok" data-go="auditor">
      <div class="agent-head"><span class="agent-name">Auditor</span>${statusLab(ag)}</div>
      <div class="agent-title">${esc(c.title || "0 taken apart")}</div>
      <div class="agent-sub">${esc(c.phase === "taking apart..." ? "taking apart..." : c.subtitle || "")}</div>
      ${strips(ag.strips || (ag.current && ag.current.layers) || [])}
    </div>`;
  }

  function analystCard(ag) {
    ag = ag || {};
    const c = ag.card || {};
    return `<div class="agent-card ${c.passed ? "hot" : "ok"}">
      <div class="agent-head"><span class="agent-name">Analyst</span>${statusLab(ag)}</div>
      <div class="agent-title">${esc(c.title || "Scoring")}</div>
      ${scoreRing(c.score, c.minScore)}
      <div class="agent-sub" style="margin-top:6px">${c.model === "rules" ? "Analyst (rules)" : esc(c.model || "")}</div>
    </div>`;
  }

  function executorCard(ag) {
    ag = ag || {};
    const c = ag.card || {};
    const bar = c.bar || {};
    const pctW = bar.pct == null ? 0 : bar.pct;
    return `<div class="agent-card ok">
      <div class="agent-head"><span class="agent-name">Executor</span>${statusLab(ag)}</div>
      <div class="agent-title">${esc(c.title || "0 trades")}</div>
      <div class="agent-sub">${esc(c.size || "")}</div>
      ${bar.label ? `<div class="bar"><i style="width:${pctW}%"></i></div><div class="bar-lab">${esc(bar.label)}</div>` : ""}
    </div>`;
  }

  function riskCard(ag) {
    ag = ag || {};
    const c = ag.card || {};
    const pills = c.pills || {};
    return `<div class="agent-card ${c.open ? "hot" : "ok"}">
      <div class="agent-head"><span class="agent-name">Risk</span>${statusLab(ag)}</div>
      <div class="agent-title">${esc(c.title || "Risk")}</div>
      ${c.lastExit ? `<div class="agent-sub">${esc(c.lastExit)}</div>` : ""}
      <div class="pills">
        ${pills.stop ? `<span class="pill stop">${esc(pills.stop)}</span>` : ""}
        ${pills.trail ? `<span class="pill trail">${esc(pills.trail)}</span>` : ""}
      </div>
    </div>`;
  }

  function renderAuditor() {
    if (!state) return renderError();
    const ag = (state.agents || {}).auditor || {};
    const cur = ag.current;
    if (!cur || !(cur.layers && cur.layers.length)) {
      return `<div class="row-top"><button class="back" data-go="agents">← Agents</button><h1>Auditor</h1></div>
        ${emptyBlock("No coin on the disc.", "When the Auditor takes a coin apart, the eight layers light up here.", "◎")}
        ${nav("agents")}`;
    }
    const layers = cur.layers;
    const running = !!cur.running || ag.card && ag.card.phase === "taking apart...";
    const svg = discSVG(layers, running);
    const name = cur.name || "coin";
    const status = cur.passed === true ? "8/8 → Executor" : cur.passed === false ? (cur.reason || "rejected") : (running ? "taking apart..." : "");
    return `<div class="disc-screen">
      <div class="disc-head"><button class="back" data-go="agents">← Agents</button>${badge(state.mode)}</div>
      <div class="disc-wrap">${svg}
        <div class="disc-center">
          ${cur.url ? `<div class="cn">${coinA(name, cur.url)}</div>` : `<div class="cn">${esc(name)}</div>`}
          <div class="st">${esc(status)}</div>
        </div>
      </div>
      ${strips(layers)}
      ${cur.holders != null ? `<div class="agent-sub" style="margin-top:12px;text-align:center">holders ${esc(cur.holders)}</div>` : ""}
    </div>${nav("agents")}`;
  }

  function discSVG(layers, running) {
    const cx = 179, cy = 179, R = 148;
    const n = 8;
    const arc = (i, color, width, glow) => {
      const a0 = -Math.PI / 2 + (i * 2 * Math.PI) / n + 0.06;
      const a1 = -Math.PI / 2 + ((i + 1) * 2 * Math.PI) / n - 0.06;
      const x0 = cx + R * Math.cos(a0), y0 = cy + R * Math.sin(a0);
      const x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1);
      const mid = (a0 + a1) / 2;
      const lx = cx + (R + 18) * Math.cos(mid);
      const ly = cy + (R + 18) * Math.sin(mid);
      return { d: `M ${x0} ${y0} A ${R} ${R} 0 0 1 ${x1} ${y1}`, lx, ly, mid };
    };
    let liveIdx = layers.findIndex((L) => L.pass == null && L.value !== "not checked");
    if (liveIdx < 0) liveIdx = layers.findIndex((L) => L.pass == null);
    let parts = "";
    // background ring
    parts += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#1c2030" stroke-width="18"/>`;
    parts += `<circle cx="${cx}" cy="${cy}" r="108" fill="none" stroke="#161922" stroke-width="1"/>`;
    parts += `<circle cx="${cx}" cy="${cy}" r="70" fill="none" stroke="#161922" stroke-width="1"/>`;
    layers.forEach((L, i) => {
      const color = L.pass === true ? "#4dffa0" : L.pass === false ? "#ff4d6a" : i === liveIdx && running ? "#3ee0d4" : "#2a3040";
      const a = arc(i);
      const sw = i === liveIdx && running ? 20 : 14;
      const cls = i === liveIdx && running ? "beam" : "";
      parts += `<path class="${cls}" d="${a.d}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>`;
      // label just inside
      const a0 = -Math.PI / 2 + (i * 2 * Math.PI) / n + Math.PI / n;
      const lx = cx + 118 * Math.cos(a0);
      const ly = cy + 118 * Math.sin(a0);
      const mark = L.pass === true ? "✓" : L.pass === false ? "×" : String(L.n);
      parts += `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" fill="${color}" font-family="Geist Mono,monospace" font-size="11" font-weight="700">${mark}</text>`;
    });
    // cyan beam wedge on live layer
    if (running && liveIdx >= 0) {
      const a0 = -Math.PI / 2 + (liveIdx * 2 * Math.PI) / n;
      const a1 = a0 + (2 * Math.PI) / n;
      const x0 = cx + (R - 28) * Math.cos(a0), y0 = cy + (R - 28) * Math.sin(a0);
      const x1 = cx + (R - 28) * Math.cos(a1), y1 = cy + (R - 28) * Math.sin(a1);
      parts += `<path class="beam" d="M ${cx} ${cy} L ${x0} ${y0} A ${R - 28} ${R - 28} 0 0 1 ${x1} ${y1} Z" fill="rgba(62,224,212,0.12)"/>`;
    }
    return `<svg viewBox="0 0 358 358" xmlns="http://www.w3.org/2000/svg">${parts}</svg>`;
  }

  function renderCoin() {
    if (!state) return renderError();
    if (!coin) {
      return `<div class="row-top"><button class="back" data-go="home">← Home</button><h1>Coin</h1></div>
        ${emptyBlock("No coin selected.", "Open a coin from Activity or an open position.", "◌")}
        ${nav("home")}`;
    }
    const name = coin.name || coin.symbol || coin.mint;
    const pos = coin.position;
    const risk = coin.riskLine;
    const holders = coin.holders;
    const audit = coin.auditLive || coin.audit;
    return `<div class="coin-screen">
      <div class="coin-head">
        <button class="back" data-go="home">←</button>
        <div class="coin-title"><h1>${coinA(name, coin.url)}</h1><div class="sy">${esc(coin.symbol || "")}</div></div>
        <div class="coin-price">${coin.price != null ? Number(coin.price).toPrecision(5) : "—"}</div>
      </div>
      <div class="chart-box">
        ${risk ? `<div class="chart-legend"><i></i>${esc(risk.label || "Risk trailing stop")}</div>` : ""}
        <canvas id="candles" width="390" height="220"></canvas>
      </div>
      <div class="coin-meta">
        <div class="stat"><div class="k">Holders</div><div class="v">${holders != null ? esc(holders) : "—"}</div></div>
        <div class="stat"><div class="k">${pos ? "Size" : "Pool"}</div><div class="v">${pos ? money(pos.sizeUsd, 2) : (coin.pool ? esc(coin.pool.slice(0, 4) + "…" + coin.pool.slice(-4)) : "—")}</div></div>
        <div class="stat"><div class="k">${pos ? "Stop" : "Audit"}</div><div class="v">${pos ? esc(pos.stopLabel) : audit ? (audit.passed ? "8/8" : esc(audit.reason || "—")) : "—"}</div></div>
      </div>
      <div class="coin-actions">
        <a class="buy" href="${esc(coin.url)}" target="_blank" rel="noopener">Buy on FOMO</a>
        ${pos ? `<a class="sell" href="${esc(coin.url)}" target="_blank" rel="noopener">Sell on FOMO</a>` : ""}
      </div>
      ${audit && audit.layers ? `<div class="section"><h2>Auditor</h2><div class="card">${strips(audit.layers)}</div></div>` : ""}
      ${coin.analysis ? `<div class="section"><h2>Analyst ${coin.analysis.model === "rules" ? "(rules)" : ""}</h2>
        <div class="card">${scoreRing(coin.analysis.score, (state.settings && state.settings.analyst && 70) || 70)}
        ${coin.analysis.failed && coin.analysis.failed.length ? `<div class="agent-sub">${esc(coin.analysis.failed[0])}</div>` : ""}</div></div>` : ""}
    </div>${nav("home")}`;
  }

  function drawChart() {
    const cvs = document.getElementById("candles");
    if (!cvs || !coin) return;
    const ctx = cvs.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const W = cvs.clientWidth || 390, H = cvs.clientHeight || 220;
    cvs.width = W * dpr; cvs.height = H * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const candles = coin.candles || [];
    const prices = candles.map((c) => Number(c.price)).filter((x) => isFinite(x) && x > 0);
    if (prices.length < 1) {
      ctx.fillStyle = "#7a8299";
      ctx.font = "12px 'Geist Mono', monospace";
      ctx.fillText("No candles yet — prices land once the scanner sees the pool.", 16, H / 2);
      return;
    }
    const risk = coin.riskLine;
    let lo = Math.min.apply(null, prices), hi = Math.max.apply(null, prices);
    if (risk && risk.price) {
      lo = Math.min(lo, risk.price);
      hi = Math.max(hi, risk.price);
    }
    if (coin.position && coin.position.entryPrice) {
      lo = Math.min(lo, coin.position.entryPrice);
      hi = Math.max(hi, coin.position.entryPrice);
    }
    const pad = (hi - lo) * 0.12 || lo * 0.02 || 1e-9;
    lo -= pad; hi += pad;
    const y = (p) => H - 16 - ((p - lo) / (hi - lo)) * (H - 32);
    const n = prices.length;
    const w = Math.max(1.5, (W - 24) / n - 1);
    // volume bars
    const vols = candles.map((c) => Number(c.volume_m5 || c.volumeM5 || 0));
    const vmax = Math.max.apply(null, vols.concat([1]));
    prices.forEach((p, i) => {
      const x = 12 + (i + 0.5) * ((W - 24) / n);
      const v = vols[i] || 0;
      const vh = (v / vmax) * 40;
      ctx.fillStyle = "rgba(62,224,212,0.12)";
      ctx.fillRect(x - w / 2, H - 8 - vh, w, vh);
    });
    // line + thin candles
    ctx.beginPath();
    ctx.strokeStyle = "#3ee0d4";
    ctx.lineWidth = 1.4;
    prices.forEach((p, i) => {
      const x = 12 + (i + 0.5) * ((W - 24) / n);
      const yy = y(p);
      if (i === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    });
    ctx.stroke();
    prices.forEach((p, i) => {
      const x = 12 + (i + 0.5) * ((W - 24) / n);
      const yy = y(p);
      const prev = i ? prices[i - 1] : p;
      ctx.fillStyle = p >= prev ? "#4dffa0" : "#ff4d6a";
      ctx.fillRect(x - w / 2, yy - 1, w, 3);
    });
    // entry
    if (coin.position && coin.position.entryPrice) {
      const yy = y(coin.position.entryPrice);
      ctx.strokeStyle = "rgba(232,235,244,0.3)";
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(W, yy); ctx.stroke();
      ctx.setLineDash([]);
    }
    // orange dashed risk trailing stop
    if (risk && risk.price) {
      const yy = y(risk.price);
      ctx.strokeStyle = "#ff8f3d";
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(W, yy); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function renderAccount() {
    if (!state) return renderError();
    const groups = state.settings || {};
    const order = ["desk", "scanner", "auditor", "analyst", "executor", "risk"];
    const labels = { desk: "Desk", scanner: "Scanner", auditor: "Auditor", analyst: "Analyst (rules)", executor: "Executor", risk: "Risk" };
    let gs = "";
    order.forEach((g) => {
      const rows = groups[g] || [];
      if (!rows.length) return;
      gs += `<div class="group"><h2>${esc(labels[g] || g)} <span class="ro">read-only</span></h2>${rows
        .map((r) => `<div class="set-row"><span class="lab">${esc(r.label)}</span><span class="val">${esc(r.display)}</span></div>`)
        .join("")}</div>`;
    });
    return `<div class="row-top"><h1>Account</h1>${badge(state.mode)}</div>
      <div class="acct">
        <div class="acct-hero">
          <div class="hdl">${esc(state.fomoHandle || "—")}</div>
          <div class="note">FOMO handle · joined before this desk was built.</div>
        </div>
        <div class="note-box">${state.webPushNote ? esc(state.webPushNote) : "<strong>Web push is not available on this host (plan B).</strong> Pushes go to Telegram."}</div>
        <div class="note-box">${esc(state.settingsNote || "Plan B: change settings with Telegram commands. This tab is read-only.")}</div>
        <a class="invite" href="${esc(state.signupUrl || state.inviteUrl)}" target="_blank" rel="noopener">
          <span class="k">New to FOMO?</span>
          ${esc(state.signupUrl || state.inviteUrl || "")}
        </a>
        ${gs}
        <div class="py">Python ${esc(state.python || "3.13")} · notifier ${esc(state.notifier || "telegram")}</div>
      </div>
      ${nav("account")}`;
  }

  function render() {
    let html;
    if (error === "missing" || error === "fetch") html = renderError();
    else if (route === "agents") html = renderAgents();
    else if (route === "auditor") html = renderAuditor();
    else if (route === "coin") html = renderCoin();
    else if (route === "account") html = renderAccount();
    else html = renderHome();
    $app.innerHTML = html;
    $app.querySelectorAll("[data-go]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        const r = el.getAttribute("data-go");
        go(r);
      });
    });
    $app.querySelectorAll("[data-retry]").forEach((el) => {
      el.addEventListener("click", () => { error = null; tick(); });
    });
    // Coin rows on home: tap name area already is a FOMO link. Long-press? Add
    // a data-coin for in-app coin screen on activity rows.
    $app.querySelectorAll(".act-row, .pos-row").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
      });
    });
    if (route === "coin") requestAnimationFrame(drawChart);
  }

  async function tick() {
    if (!parseHash()) {
      error = "missing";
      render();
      return;
    }
    await loadAll();
    render();
  }

  window.addEventListener("hashchange", () => { tick(); });
  // Force empty / error via query for screenshots: ?empty=1  (hash still needed)
  if (/\bempty=1\b/.test(location.search)) emptyForced = true;
  if (/\bshot=1\b/.test(location.search)) document.documentElement.classList.add("shot");
  tick();
  timer = setInterval(tick, POLL_MS);
})();
