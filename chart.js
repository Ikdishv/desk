/* Hand-drawn canvas charts. No chart library. devicePixelRatio aware.
   Home line, Coin candles, Analyst score ring. */
(function (global) {
  "use strict";

  function dpr() {
    return Math.max(1, window.devicePixelRatio || 1);
  }

  function fit(canvas, cssW, cssH) {
    var r = dpr();
    var w = Math.max(1, Math.round(cssW * r));
    var h = Math.max(1, Math.round(cssH * r));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    var ctx = canvas.getContext("2d");
    ctx.setTransform(r, 0, 0, r, 0, 0);
    return ctx;
  }

  function parseT(t) {
    if (t == null) return 0;
    if (typeof t === "number") return t;
    var d = Date.parse(String(t).replace("Z", "+00:00"));
    return isFinite(d) ? d : 0;
  }

  function reduced() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  /* ---------- Home line chart ---------- */
  function line(canvas, opts) {
    opts = opts || {};
    var rect = canvas.getBoundingClientRect();
    var W = opts.width || rect.width || 358;
    var H = opts.height || rect.height || 200;
    var ctx = fit(canvas, W, H);
    ctx.clearRect(0, 0, W, H);
    canvas._deskHits = [];

    var points = (opts.points || []).map(function (p) {
      return { t: parseT(p.t), v: Number(p.v), raw: p };
    }).filter(function (p) { return isFinite(p.t) && isFinite(p.v); });
    points.sort(function (a, b) { return a.t - b.t; });

    var start = opts.start;
    if (start == null && points.length) start = points[0].v;
    start = Number(start);
    if (!isFinite(start)) start = 0;

    var padL = 8, padR = 36, padB = 18, padT = 14; // room for the end dot and trade dots
    var marks = opts.marks || [];
    var empty = opts.empty || points.length < 2;

    var vals = points.map(function (p) { return p.v; }).concat([start]);
    var minV = Math.min.apply(null, vals);
    var maxV = Math.max.apply(null, vals);
    var span = maxV - minV;
    if (span < 1e-9) {
      minV -= Math.abs(minV) * 0.02 + 1;
      maxV += Math.abs(maxV) * 0.02 + 1;
      span = maxV - minV;
    } else {
      minV -= span * 0.08;
      maxV += span * 0.16;
      span = maxV - minV;
    }

    var t0 = points.length ? points[0].t : 0;
    var t1 = points.length ? points[points.length - 1].t : 1;
    if (t1 <= t0) t1 = t0 + 1;

    function xOf(t) { return padL + ((t - t0) / (t1 - t0)) * (W - padL - padR); }
    function yOf(v) { return padT + (1 - (v - minV) / span) * (H - padT - padB); }

    // Dashed start-value line
    var yS = yOf(start);
    ctx.save();
    ctx.strokeStyle = "rgba(235,235,245,0.3)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3.5, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, yS);
    ctx.lineTo(W - padR, yS);
    ctx.stroke();
    ctx.restore();

    if (empty) {
      if (opts.emptyLabel !== false) {
        ctx.fillStyle = "rgba(235,235,245,0.6)";
        ctx.font = "13px -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(opts.emptyText || "Waiting for the first trade", W / 2, Math.min(H * 0.58, yS + 28));
      }
      canvas._deskHits = [];
      return { xOf: xOf, yOf: yOf, hits: [] };
    }

    // Line path
    ctx.beginPath();
    points.forEach(function (p, i) {
      var x = xOf(p.t), y = yOf(p.v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    var path = new Path2D();
    points.forEach(function (p, i) {
      var x = xOf(p.t), y = yOf(p.v);
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });

    // Gradient fill under the line (allowed; cards themselves have no gradients)
    var last = points[points.length - 1];
    var first = points[0];
    var fill = ctx.createLinearGradient(0, padT, 0, H - padB);
    fill.addColorStop(0, "rgba(0,211,90,0.32)");
    fill.addColorStop(1, "rgba(0,211,90,0)");
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(xOf(first.t), H - padB);
    points.forEach(function (p, i) {
      var x = xOf(p.t), y = yOf(p.v);
      if (i === 0) ctx.lineTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(xOf(last.t), H - padB);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();

    // Stroke
    ctx.save();
    ctx.strokeStyle = "#00d35a";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    points.forEach(function (p, i) {
      var x = xOf(p.t), y = yOf(p.v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();

    // End dot
    ctx.beginPath();
    ctx.fillStyle = "#00d35a";
    ctx.arc(xOf(last.t), yOf(last.v), 3.2, 0, Math.PI * 2);
    ctx.fill();

    // Trade dots on the line. No text labels (names and PnL live in Activity).
    var colorMap = { blue: "#0a84ff", green: "#00d35a", red: "#ff453a", orange: "#ff9f0a" };
    var hits = [];
    marks.forEach(function (m) {
      var t = parseT(m.t);
      if (t < t0 || t > t1) return;
      var x = xOf(t);
      var y = yOf(interpV(points, t));
      var col = colorMap[m.color] || m.color || "#0a84ff";
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.stroke();
      hits.push({ x: x, y: y, mint: m.mint, kind: m.kind });
    });
    canvas._deskHits = hits;

    return { xOf: xOf, yOf: yOf, hits: hits };
  }

  function interpV(points, t) {
    if (!points.length) return 0;
    if (t <= points[0].t) return points[0].v;
    if (t >= points[points.length - 1].t) return points[points.length - 1].v;
    for (var i = 1; i < points.length; i++) {
      if (points[i].t >= t) {
        var a = points[i - 1], b = points[i];
        var u = (t - a.t) / (b.t - a.t || 1);
        return a.v + (b.v - a.v) * u;
      }
    }
    return points[points.length - 1].v;
  }

  /* ---------- Coin candles + volume ---------- */
  function candles(canvas, opts) {
    opts = opts || {};
    var rect = canvas.getBoundingClientRect();
    var W = opts.width || rect.width || 358;
    var H = opts.height || rect.height || 260;
    var ctx = fit(canvas, W, H);
    ctx.clearRect(0, 0, W, H);

    var bars = (opts.candles || []).map(function (c) {
      return {
        t: parseT(c.t || c.ts),
        o: num(c.o != null ? c.o : c.open != null ? c.open : c.price),
        h: num(c.h != null ? c.h : c.high != null ? c.high : c.price),
        l: num(c.l != null ? c.l : c.low != null ? c.low : c.price),
        c: num(c.c != null ? c.c : c.close != null ? c.close : c.price),
        v: num(c.v != null ? c.v : 0),
      };
    }).filter(function (c) {
      return isFinite(c.t) && isFinite(c.c);
    });
    bars.sort(function (a, b) { return a.t - b.t; });

    if (!bars.length) {
      ctx.fillStyle = "rgba(235,235,245,0.6)";
      ctx.font = "13px -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No candles yet", W / 2, H / 2);
      return;
    }

    var volH = Math.round(H * 0.12);
    var padT = 10, padB = volH + 8, padL = 2, padR = 2;
    var highs = bars.map(function (b) { return b.h; });
    var lows = bars.map(function (b) { return b.l; });
    var exit = opts.exitLine != null ? Number(opts.exitLine) : null;
    if (isFinite(exit)) {
      highs.push(exit);
      lows.push(exit);
    }
    var minV = Math.min.apply(null, lows);
    var maxV = Math.max.apply(null, highs);
    var span = maxV - minV || Math.abs(maxV) * 0.04 + 1e-12;
    minV -= span * 0.06;
    maxV += span * 0.08;
    span = maxV - minV;

    function yOf(v) { return padT + (1 - (v - minV) / span) * (H - padT - padB); }

    var n = bars.length;
    var slot = (W - padL - padR) / n;
    var bodyW = Math.max(1.2, Math.min(7, slot * 0.62));

    var maxVol = 0;
    bars.forEach(function (b) { if (b.v > maxVol) maxVol = b.v; });

    bars.forEach(function (b, i) {
      var x = padL + (i + 0.5) * slot;
      var up = b.c >= b.o;
      var col = up ? "#00d35a" : "#ff453a";
      // wick
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yOf(b.h));
      ctx.lineTo(x, yOf(b.l));
      ctx.stroke();
      // body
      var y1 = yOf(Math.max(b.o, b.c));
      var y2 = yOf(Math.min(b.o, b.c));
      var bh = Math.max(1, y2 - y1);
      ctx.fillStyle = col;
      ctx.fillRect(x - bodyW / 2, y1, bodyW, bh);
      // volume
      if (maxVol > 0 && b.v > 0) {
        var vh = (b.v / maxVol) * (volH - 2);
        ctx.globalAlpha = 0.35;
        ctx.fillRect(x - bodyW / 2, H - 2 - vh, bodyW, vh);
        ctx.globalAlpha = 1;
      }
    });

    if (isFinite(exit)) {
      var yE = yOf(exit);
      ctx.save();
      ctx.strokeStyle = "#ff9f0a";
      ctx.lineWidth = 1.25;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, yE);
      ctx.lineTo(W - padR, yE);
      ctx.stroke();
      ctx.restore();
      var label = opts.exitLabel || "Risk trailing stop";
      ctx.font = "11px -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";
      ctx.fillStyle = "#ff9f0a";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      var ly = yE - 3;
      if (ly < 12) ly = yE + 13;
      ctx.fillText(label, padL + 4, ly);
    }
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : NaN;
  }

  /* ---------- Analyst score ring ---------- */
  function scoreRing(canvas, score, opts) {
    opts = opts || {};
    var rect = canvas.getBoundingClientRect();
    var S = opts.size || Math.min(rect.width || 88, rect.height || 88) || 88;
    var ctx = fit(canvas, S, S);
    ctx.clearRect(0, 0, S, S);
    var cx = S / 2, cy = S / 2;
    var r = S * 0.38;
    var lw = Math.max(5, S * 0.08);
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(84,84,88,0.55)";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    var v = Number(score);
    if (isFinite(v)) {
      var frac = Math.max(0, Math.min(1, v / 100));
      var ok = v >= (opts.min != null ? opts.min : 70);
      ctx.strokeStyle = ok ? "#00d35a" : "#ffd60a";
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2, false);
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "600 " + Math.round(S * 0.28) + "px -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(Math.round(v)), cx, cy + 1);
    } else {
      ctx.fillStyle = "rgba(235,235,245,0.6)";
      ctx.font = "13px -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("—", cx, cy);
    }
  }

  global.Charts = { line: line, candles: candles, scoreRing: scoreRing, fit: fit, reduced: reduced };
})(typeof window !== "undefined" ? window : this);
