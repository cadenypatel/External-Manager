/* Equity Manager Tracker - dashboard
   Reads data/data.json (daily total-return prices since 2019) and computes every
   statistic in the browser, so any lookback window and any shock day since 2020 works. */
(() => {
  "use strict";

  let DATA = null;
  const E = {};                       // series engine
  let rangeKey = "252";               // lookback: trading days or "max"
  let eventIdx = null;                // selected shock-day index
  let sigmaK = 0;                     // sigma filter (0 = off)
  let sigmaHits = [];                 // indices found by the sigma filter
  const charts = {};
  const TD = 252;
  const FLAG_PP = 1.5;                // holdings: flag weight moves of this many percentage points
  const RANGE_LABEL = { "63": "3M", "126": "6M", "252": "1Y", "756": "3Y", max: "since 2020" };

  // ---------- formatting ----------
  const MINUS = "−";
  const pct = (v, dp = 2, sign = false) => {
    if (v === null || v === undefined || Number.isNaN(v)) return "–";
    const s = (Math.abs(v) * 100).toFixed(dp) + "%";
    return v < 0 ? MINUS + s : (sign && v > 0 ? "+" : "") + s;
  };
  const num = (v, dp = 2, sign = false) => {
    if (v === null || v === undefined || Number.isNaN(v)) return "–";
    const s = Math.abs(v).toFixed(dp);
    return v < 0 ? MINUS + s : (sign && v > 0 ? "+" : "") + s;
  };
  const fmtDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const shortDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const rangeLabel = () => RANGE_LABEL[rangeKey];

  // ---------- math ----------
  const nn = (a) => a.filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const std = (a) => {
    if (a.length < 2) return null;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
  };
  const median = (a) => {
    const v = nn(a).sort((x, y) => x - y), n = v.length;
    return n ? (n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2) : null;
  };
  const corrOf = (x, y) => {
    const p = x.map((v, i) => [v, y[i]]).filter(([a, b]) => a != null && b != null);
    if (p.length < 3) return null;
    const mx = mean(p.map((q) => q[0])), my = mean(p.map((q) => q[1]));
    let sxy = 0, sxx = 0, syy = 0;
    p.forEach(([a, b]) => { sxy += (a - mx) * (b - my); sxx += (a - mx) ** 2; syy += (b - my) ** 2; });
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  };

  // ---------- series engine ----------
  function buildEngine() {
    const d = DATA.series.dates, n = d.length;
    E.dates = d; E.n = n; E.last = n - 1; E.price = DATA.series.price; E.ret = {};
    for (const t in E.price) {
      const p = E.price[t], r = new Array(n).fill(null);
      for (let i = 1; i < n; i++) if (p[i] != null && p[i - 1] != null && p[i - 1] !== 0) r[i] = p[i] / p[i - 1] - 1;
      E.ret[t] = r;
    }
    E.minIdx = Math.max(1, d.findIndex((x) => x >= DATA.config.min_date));
    const lb = DATA.config.sigma_lookback || 60;
    const s = E.ret[DATA.sp500];
    E.sigma = new Array(n).fill(null);
    for (let i = lb; i < n; i++) {
      if (s[i] == null) continue;
      const sd = std(nn(s.slice(i - lb, i)));
      if (sd) E.sigma[i] = s[i] / sd;
    }
    E.vol20 = {};
    for (const t in E.ret) {
      const r = E.ret[t], v = new Array(n).fill(null);
      for (let i = 20; i < n; i++) {
        const w = nn(r.slice(i - 19, i + 1));
        if (w.length >= 15) v[i] = std(w) * Math.sqrt(TD);
      }
      E.vol20[t] = v;
    }
  }
  const win = (end) => {
    const start = rangeKey === "max" ? E.minIdx : Math.max(1, end - Number(rangeKey) + 1);
    return [Math.min(start, end), end];
  };
  const seg = (t, a, b) => E.ret[t].slice(Math.max(1, a), b + 1);
  const annVol = (t, a, b) => { const v = nn(seg(t, a, b)); return v.length >= 10 ? std(v) * Math.sqrt(TD) : null; };
  function pairs(t, u, a, b) {
    const x = [], y = [], rt = E.ret[t], ru = E.ret[u];
    for (let i = Math.max(1, a); i <= b; i++) if (rt[i] != null && ru[i] != null) { x.push(rt[i]); y.push(ru[i]); }
    return [x, y];
  }
  function beta(t, u, a, b) {
    const [x, y] = pairs(t, u, a, b);
    if (x.length < 20) return null;
    const mx = mean(x), my = mean(y);
    let c = 0, v = 0;
    for (let i = 0; i < x.length; i++) { c += (x[i] - mx) * (y[i] - my); v += (y[i] - my) ** 2; }
    return v ? c / v : null;
  }
  function corr(t, u, a, b) { const [x, y] = pairs(t, u, a, b); return x.length >= 20 ? corrOf(x, y) : null; }
  function te(t, u, a, b) { const [x, y] = pairs(t, u, a, b); return x.length >= 20 ? std(x.map((v, i) => v - y[i])) * Math.sqrt(TD) : null; }
  function capture(t, u, a, b, side) {
    const [x, y] = pairs(t, u, a, b);
    const idx = y.map((v, i) => i).filter((i) => (side === "down" ? y[i] < 0 : y[i] > 0));
    if (idx.length < 10) return null;
    const f = idx.reduce((p, i) => p * (1 + x[i]), 1) - 1, m = idx.reduce((p, i) => p * (1 + y[i]), 1) - 1;
    return m ? f / m : null;
  }
  function maxDD(t, a, b) {
    let w = 1, peak = 1, dd = 0, k = 0;
    for (const r of seg(t, a, b)) { if (r == null) continue; k++; w *= 1 + r; peak = Math.max(peak, w); dd = Math.min(dd, w / peak - 1); }
    return k ? dd : null;
  }
  function periodRet(t, a, b) {               // close before index a -> close at index b
    const p = E.price[t];
    let i0 = a - 1;
    while (i0 >= 0 && p[i0] == null) i0--;
    if (i0 < 0) { i0 = a; while (i0 <= b && p[i0] == null) i0++; }
    let i1 = b;
    while (i1 > i0 && p[i1] == null) i1--;
    return i0 <= b && i1 > i0 && p[i0] ? p[i1] / p[i0] - 1 : null;
  }
  const lastIdx = (t) => { let i = E.last; while (i > 0 && E.price[t][i] == null) i--; return i; };
  const countObs = (t, a, b) => nn(seg(t, a, b)).length;
  function addPeer(rows, key, higherBetter, prefix) {
    ["Growth", "Value"].forEach((style) => {
      const g = rows.filter((r) => r.style === style);
      const med = median(g.map((r) => r[key]));
      const sorted = g.filter((r) => r[key] != null).sort((a, b) => (higherBetter ? b[key] - a[key] : a[key] - b[key]));
      g.forEach((r) => {
        r[prefix + "_peer_median"] = med;
        r[prefix + "_vs_peer"] = r[key] != null && med != null ? r[key] - med : null;
        r[prefix + "_peer_rank"] = r[key] == null ? null : sorted.indexOf(r) + 1;
        r.peer_count = sorted.length;
      });
    });
  }

  // ---------- theme & chart defaults ----------
  function theme() {
    return {
      ink: css("--ink"), ink2: css("--ink-2"), muted: css("--muted"), grid: css("--grid"), axis: css("--axis"),
      surface: css("--surface"), growth: css("--growth"), value: css("--value"),
      series: [css("--s1"), css("--s2"), css("--s3"), css("--s4")], bench: css("--bench"), event: css("--event"), bad: css("--bad"),
    };
  }
  function applyDefaults(t) {
    Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
    Chart.defaults.font.size = 12;
    Chart.defaults.color = t.ink2;
    Chart.defaults.borderColor = t.grid;
    Chart.defaults.maintainAspectRatio = false;
    Chart.defaults.animation = false;
    Object.assign(Chart.defaults.plugins.legend.labels, { usePointStyle: true, boxWidth: 8, boxHeight: 8 });
    Chart.defaults.plugins.legend.position = "bottom";
    Object.assign(Chart.defaults.plugins.tooltip, {
      backgroundColor: t.surface, titleColor: t.ink, bodyColor: t.ink2, borderColor: t.axis, borderWidth: 1,
      padding: 10, usePointStyle: true, boxPadding: 4,
    });
  }
  const pointLabels = {
    id: "pointLabels",
    afterDatasetsDraw(chart, _a, opts) {
      if (!opts || !opts.enabled) return;
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillStyle = opts.color;
      ctx.textBaseline = "middle";
      const placed = [], pts = [];
      chart.data.datasets.forEach((ds, i) => chart.getDatasetMeta(i).data.forEach((el, j) => pts.push({ x: el.x, y: el.y, label: ds.data[j].label })));
      pts.sort((a, b) => a.y - b.y);
      const overlaps = (r) => placed.some((p) => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y)
        || pts.some((p) => Math.abs(p.x - (r.x + r.w / 2)) < r.w / 2 + 5 && Math.abs(p.y - (r.y + r.h / 2)) < r.h / 2 + 5);
      pts.forEach((p) => {
        const w = ctx.measureText(p.label).width, h = 13;
        const cands = [
          { x: p.x + 9, y: p.y - h / 2 }, { x: p.x - 9 - w, y: p.y - h / 2 }, { x: p.x - w / 2, y: p.y - 10 - h }, { x: p.x - w / 2, y: p.y + 10 },
          { x: p.x + 9, y: p.y - h - 6 }, { x: p.x + 9, y: p.y + 6 }, { x: p.x - 9 - w, y: p.y - h - 6 }, { x: p.x - 9 - w, y: p.y + 6 },
        ];
        const pick = cands.find((c) => { const r = { ...c, w, h }; return r.x >= chartArea.left && r.x + w <= chartArea.right && r.y >= chartArea.top - 4 && r.y + h <= chartArea.bottom + 4 && !overlaps(r); }) || cands[0];
        placed.push({ ...pick, w, h });
        ctx.fillText(p.label, pick.x, pick.y + h / 2);
      });
      ctx.restore();
    },
  };
  const eventMarkers = {
    id: "eventMarkers",
    beforeDatasetsDraw(chart, _a, opts) {
      if (!opts || !opts.marks || !opts.marks.length) return;
      const { ctx, chartArea, scales } = chart;
      const labels = chart.data.labels;
      ctx.save();
      ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
      let lastRight = -Infinity, row = 0;
      const labelled = opts.marks.length <= 12;
      opts.marks.forEach((m) => {
        const i = labels.indexOf(m.date);
        if (i < 0) return;
        const x = scales.x.getPixelForValue(i);
        ctx.strokeStyle = ctx.fillStyle = m.strong ? opts.strong : opts.color;
        ctx.lineWidth = m.strong ? 1.5 : 1;
        ctx.setLineDash(m.strong ? [] : [3, 3]);
        ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
        if (!labelled && !m.strong) return;
        const txt = m.text || shortDate(m.date);
        const w = ctx.measureText(txt).width;
        let lx = x + 4;
        if (lx + w > chartArea.right) lx = x - 4 - w;
        row = lx < lastRight + 6 ? row + 1 : 0;
        ctx.fillText(txt, lx, chartArea.top + 10 + row * 13);
        lastRight = Math.max(lastRight, lx + w);
      });
      ctx.restore();
    },
  };
  const crosshair = {
    id: "crosshair",
    afterDraw(chart, _a, opts) {
      if (!opts || !opts.enabled) return;
      const act = chart.tooltip && chart.tooltip.getActiveElements();
      if (!act || !act.length) return;
      const { ctx, chartArea } = chart, x = act[0].element.x;
      ctx.save(); ctx.strokeStyle = opts.color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke(); ctx.restore();
    },
  };
  Chart.register(pointLabels, eventMarkers, crosshair);
  function make(id, cfg) { if (charts[id]) charts[id].destroy(); charts[id] = new Chart(document.getElementById(id), cfg); }

  // ---------- helpers ----------
  const fundsBy = (style) => DATA.funds.filter((f) => f.style === style);
  const benchFor = (style) => DATA.style_index[style];
  const idxShort = (t) => (DATA.indexes[t] ? DATA.indexes[t].short : t);
  const idxName = (t) => (DATA.indexes[t] ? DATA.indexes[t].name : t);

  // ---------- tables ----------
  function table(el, cols, rows, opts = {}) {
    let sortKey = opts.sortKey || null, asc = opts.asc ?? false;
    const draw = () => {
      let rs = [...rows];
      if (sortKey) {
        rs.sort((a, b) => {
          const va = a[sortKey], vb = b[sortKey];
          if (va == null) return 1; if (vb == null) return -1;
          const r = typeof va === "string" ? va.localeCompare(vb) : va - vb;
          return asc ? r : -r;
        });
      }
      const head = "<thead><tr>" + cols.map((c) => {
        const cls = [c.txt ? "txt" : "", opts.sortable ? "sortable" : "", c.key === sortKey ? "sorted" + (asc ? " asc" : "") : ""].join(" ");
        return `<th class="${cls}" data-k="${c.key}" ${c.title ? `title="${esc(c.title)}"` : ""}>${c.label}</th>`;
      }).join("") + "</tr></thead>";
      const tr = (r, extra = "") => `<tr class="${r.style === "Benchmark" ? "bench" : ""} ${extra}">` + cols.map((c) => {
        const v = r[c.key];
        if (v === undefined && r.__footer) return "<td></td>";
        const out = c.render ? c.render(v, r) : c.fmt ? c.fmt(v) : esc(v ?? "");
        const cls = [c.txt ? "txt" : "", c.color && typeof v === "number" ? (v < 0 ? "neg" : v > 0 ? "pos" : "") : ""].join(" ");
        return `<td class="${cls}">${out}</td>`;
      }).join("") + "</tr>";
      el.innerHTML = head + "<tbody>" + rs.map((r) => tr(r)).join("") + (opts.footer || []).map((r) => tr({ ...r, __footer: true }, "footer")).join("") + "</tbody>";
      if (opts.sortable) el.querySelectorAll("th").forEach((th) => th.addEventListener("click", () => {
        const k = th.dataset.k;
        if (k === sortKey) asc = !asc; else { sortKey = k; asc = typeof rows[0][k] === "string"; }
        draw();
      }));
    };
    draw();
  }
  const managerCell = (v, r) => {
    if (r.__footer) return `<b>${esc(v)}</b>`;
    if (r.style === "Benchmark") return esc(v);
    const f = DATA.funds.find((x) => x.ticker === r.ticker) || {};
    return `${esc(v)}<br><span class="tag"><span class="dot ${r.style}"></span>${r.ticker} · ${f.vehicle || ""}</span>`;
  };
  const rankCell = (v, r) => (v == null ? "" : `${v} of ${r.peer_count}`);
  const bmkCell = (v) => (v ? `<span title="${esc(idxName(v))}">${esc(idxShort(v))}</span>` : "");

  // ---------- shock-day analysis ----------
  function eventAnalysis(e) {
    const SP = DATA.sp500, [a, b] = win(e - 1), spx = E.ret[SP][e];
    const rows = [];
    DATA.funds.forEach((f) => {
      const t = f.ticker, sb = f.stated_benchmark, si = benchFor(f.style), ev = E.ret[t][e];
      if (ev == null) return;                                // fund didn't exist yet / no price that day
      const sd60 = std(nn(E.ret[t].slice(Math.max(1, e - 60), e)));
      const bSpy = beta(t, SP, a, b);
      rows.push({
        manager: f.manager, ticker: t, style: f.style, stated_benchmark: sb,
        event_ret: ev, stated_bmk_ret: E.ret[sb][e], excess_stated: ev - E.ret[sb][e],
        style_index_ret: E.ret[si][e], excess_style: ev - E.ret[si][e], excess_spy: ev - spx,
        sigma_own: sd60 ? ev / sd60 : null,
        vol20_pre: annVol(t, e - 20, e - 1), vol_pre: annVol(t, a, b),
        beta_spy_pre: bSpy, beta_stated_pre: beta(t, sb, a, b), down_cap_pre: capture(t, sb, a, b, "down"),
        pred_ret: bSpy != null ? bSpy * spx : null, alpha_day: bSpy != null ? ev - bSpy * spx : null,
        since_event: e < E.last ? periodRet(t, e + 1, E.last) : null,
      });
    });
    addPeer(rows, "event_ret", true, "event");
    const spPre = nn(E.ret[SP].slice(Math.max(1, e - TD), e));
    const market = {
      spy_ret: spx, spy_sigma60: E.sigma[e], spy_sigma1y: std(spPre) ? spx / std(spPre) : null,
      r1g_ret: E.ret[DATA.style_index.Growth][e], r1v_ret: E.ret[DATA.style_index.Value][e],
    };
    const groups = ["Growth", "Value"].map((style) => {
      const g = rows.filter((r) => r.style === style), si = benchFor(style);
      const avg = (k) => { const v = nn(g.map((r) => r[k])); return v.length ? mean(v) : null; };
      return { style, n: g.length, style_index: si, style_index_ret: E.ret[si][e], event_ret_median: median(g.map((r) => r.event_ret)),
        ...Object.fromEntries(["event_ret", "excess_stated", "excess_style", "excess_spy", "vol_pre", "beta_spy_pre", "down_cap_pre", "alpha_day", "since_event"].map((k) => [k, avg(k)])) };
    });
    const corrs = {
      vol: corrOf(rows.map((r) => r.vol_pre), rows.map((r) => r.event_ret)),
      beta: corrOf(rows.map((r) => r.beta_spy_pre), rows.map((r) => r.event_ret)),
    };
    return { date: E.dates[e], rows, market, groups, corrs };
  }

  function renderTiles(ev) {
    const m = ev.market, g = ev.groups.find((x) => x.style === "Growth"), v = ev.groups.find((x) => x.style === "Value");
    const tiles = [
      ["S&P 500 Index (TR)", pct(m.spy_ret), `${num(m.spy_sigma60, 1)}σ vs prior 60d · ${num(m.spy_sigma1y, 1)}σ vs 1y`],
      ["Russell 1000 Growth (TR)", pct(m.r1g_ret), "Growth style index"],
      ["Russell 1000 Value (TR)", pct(m.r1v_ret), "Value style index"],
      ["Growth peers (avg)", pct(g.event_ret), `${pct(g.excess_style, 2, true)} vs R1000 Growth`],
      ["Value peers (avg)", pct(v.event_ret), `${pct(v.excess_style, 2, true)} vs R1000 Value`],
    ];
    document.getElementById("marketTiles").innerHTML = tiles
      .map(([k, val, s]) => `<div class="tile"><div class="k">${k}</div><div class="v">${val}</div><div class="s">${s}</div></div>`).join("");
  }
  const strength = (r) => { const a = Math.abs(r); return a >= 0.7 ? "strongly" : a >= 0.4 ? "moderately" : "weakly"; };
  function renderFinding(ev) {
    const rows = ev.rows, isDown = ev.market.spy_ret < 0, p = [];
    if (rows.length < 3) { document.getElementById("finding").innerHTML = "<p>Too few managers have prices on this date to compare.</p>"; return; }
    const g = ev.groups.find((x) => x.style === "Growth"), v = ev.groups.find((x) => x.style === "Value");
    const { vol: volR, beta: betaR } = ev.corrs;
    const lowHelped = volR != null && (isDown ? volR < 0 : volR > 0);
    p.push(`<p><b>${isDown ? "Lower" : "Higher"} pre-event volatility went with ${isDown ? "holding up better" : "gaining more"}</b>${lowHelped ? "" : " <i>(not this time)</i>"}: ` +
      `the correlation between ${rangeLabel()} volatility and the day's return was ${num(volR)}${volR != null ? ` (${strength(volR)})` : ""}, and for beta it was ${num(betaR)}${betaR != null ? ` (${strength(betaR)})` : ""}.</p>`);
    if (g.n && v.n) p.push(`<p>Growth managers went in with ${pct(g.vol_pre, 1)} volatility and a beta of ${num(g.beta_spy_pre)}, and returned ${pct(g.event_ret)}. ` +
      `Value managers went in with ${pct(v.vol_pre, 1)} volatility and a beta of ${num(v.beta_spy_pre)}, and returned ${pct(v.event_ret)}.</p>`);
    const peerLine = (style) => {
      const rs = rows.filter((r) => r.style === style).sort((a, b) => b.event_ret - a.event_ret);
      if (!rs.length) return "";
      const top = rs[0], bot = rs[rs.length - 1];
      return `${style} peers: best was <b>${esc(top.manager)}</b> (${pct(top.event_ret)}, ${pct(top.excess_stated, 2, true)} vs its ${idxShort(top.stated_benchmark)} benchmark), ` +
        `worst was <b>${esc(bot.manager)}</b> (${pct(bot.event_ret)}, ${pct(bot.excess_stated, 2, true)} vs ${idxShort(bot.stated_benchmark)}).`;
    };
    p.push(`<p>${peerLine("Growth")}<br>${peerLine("Value")}</p>`);
    const withA = rows.filter((r) => r.alpha_day != null);
    if (withA.length) {
      const best = [...withA].sort((a, b) => b.alpha_day - a.alpha_day)[0];
      const maxAbs = Math.max(...withA.map((r) => Math.abs(r.alpha_day)));
      p.push(`<p>After adjusting for beta, every manager was within ±${pct(maxAbs, 1)} of its beta-predicted return. The best beyond beta was ${esc(best.manager)} at ${pct(best.alpha_day, 2, true)}.</p>`);
    }
    document.getElementById("finding").innerHTML = p.join("");
  }
  function scatter(id, ev, xKey, xTitle, xFmt) {
    const t = theme();
    const mk = (style, color, shape) => ({
      label: style + " managers",
      data: ev.rows.filter((r) => r.style === style && r[xKey] != null).map((r) => ({ x: r[xKey], y: r.event_ret, label: r.ticker, row: r })),
      backgroundColor: color, borderColor: t.surface, borderWidth: 2, pointStyle: shape,
      pointRadius: shape === "rectRot" ? 7 : 6, pointHoverRadius: 9, pointHitRadius: 12,
    });
    make(id, {
      type: "scatter",
      data: { datasets: [mk("Growth", t.growth, "circle"), mk("Value", t.value, "rectRot")] },
      options: {
        layout: { padding: { right: 12, top: 6 } },
        scales: {
          x: { title: { display: true, text: xTitle, color: t.ink2 }, grid: { display: false }, border: { color: t.axis }, ticks: { callback: (v) => xFmt(v) } },
          y: { title: { display: true, text: "Shock-day return", color: t.ink2 }, grid: { color: t.grid }, border: { display: false }, ticks: { callback: (v) => pct(v, 1) } },
        },
        plugins: {
          pointLabels: { enabled: true, color: t.ink2 },
          tooltip: { callbacks: {
            title: (items) => items[0].raw.row.manager,
            label: (it) => [`${xTitle}: ${xFmt(it.raw.x)}`, `Shock-day return: ${pct(it.raw.y)}`,
              `vs ${idxShort(it.raw.row.stated_benchmark)} (stated bmk): ${pct(it.raw.row.excess_stated, 2, true)}`,
              `Rank in ${it.raw.row.style.toLowerCase()} peers: ${it.raw.row.event_peer_rank} of ${it.raw.row.peer_count}`,
              `Beyond beta: ${pct(it.raw.row.alpha_day, 2, true)}`],
          } },
        },
      },
    });
  }
  function pathChart(id, e, style) {
    const t = theme(), wb = DATA.config.window_before || 5, wa = DATA.config.window_after || 10;
    const lo = Math.max(1, e - wb), hi = Math.min(E.last, e + wa);
    const idxs = []; for (let i = lo; i <= hi; i++) idxs.push(i);
    const labels = idxs.map((i) => (i === e ? "Shock" : (i > e ? "+" : MINUS) + Math.abs(i - e) + "d"));
    const cum = (tk) => idxs.map((i) => (E.price[tk][i] != null && E.price[tk][e - 1] ? E.price[tk][i] / E.price[tk][e - 1] - 1 : null));
    const ds = fundsBy(style).map((f, k) => ({ label: f.ticker, data: cum(f.ticker), borderColor: t.series[k], backgroundColor: t.series[k],
      borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0, spanGaps: true }));
    const b = benchFor(style);
    ds.push({ label: idxShort(b) + " (style index)", data: cum(b), borderColor: t.bench, backgroundColor: t.bench, borderDash: [5, 4],
      borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointStyle: "line" });
    make(id, {
      type: "line", data: { labels, datasets: ds },
      options: {
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { grid: { display: false }, border: { color: t.axis }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 9 } },
          y: { grid: { color: t.grid }, border: { display: false }, ticks: { callback: (v) => pct(v, 0) } },
        },
        plugins: {
          crosshair: { enabled: true, color: t.axis },
          eventMarkers: { marks: [{ date: "Shock", text: fmtDate(E.dates[e]), strong: true }], color: t.event, strong: t.event },
          tooltip: { callbacks: { title: (it) => `${it[0].label} · ${fmtDate(E.dates[idxs[it[0].dataIndex]])}`, label: (it) => `${it.dataset.label}: ${pct(it.raw)}` } },
        },
      },
    });
  }
  function renderEventTables(ev) {
    const P = (v) => pct(v), Ps = (v) => pct(v, 2, true), R = (v) => num(v), L = rangeLabel();
    const cols = [
      { key: "manager", label: "Manager", txt: true, render: managerCell },
      { key: "stated_benchmark", label: "Stated benchmark", txt: true, render: bmkCell, title: "The primary benchmark the manager lists" },
      { key: "event_ret", label: "Shock-day return", fmt: P, color: true },
      { key: "excess_stated", label: "vs stated bmk", fmt: Ps, color: true },
      { key: "excess_spy", label: "vs S&P 500", fmt: Ps, color: true },
      { key: "excess_style", label: "vs style index", fmt: Ps, color: true },
      { key: "event_peer_rank", label: "Peer rank", render: rankCell, title: "Rank within this peer group only (1 = best)" },
      { key: "event_vs_peer", label: "vs peer median", fmt: Ps, color: true },
      { key: "sigma_own", label: "Move in own σ", fmt: (v) => num(v, 1) + "σ", title: "Shock-day return ÷ the fund's own prior 60-day daily standard deviation" },
      { key: "vol20_pre", label: "Pre vol 20d", fmt: (v) => pct(v, 1) },
      { key: "vol_pre", label: `Pre vol (${L})`, fmt: (v) => pct(v, 1) },
      { key: "beta_spy_pre", label: `Beta vs S&P (${L})`, fmt: R },
      { key: "beta_stated_pre", label: `Beta vs stated (${L})`, fmt: R },
      { key: "down_cap_pre", label: `Downside capture (${L})`, fmt: R },
      { key: "pred_ret", label: "Beta-predicted", fmt: P },
      { key: "alpha_day", label: "Beyond beta", fmt: Ps, color: true, title: "Actual − beta-predicted return" },
      { key: "since_event", label: "Since shock", fmt: Ps, color: true },
    ];
    ["Growth", "Value"].forEach((style) => {
      const g = ev.groups.find((x) => x.style === style);
      const footer = [
        { manager: `${style} peer median`, event_ret: g.event_ret_median },
        { manager: `${style} peer average`, event_ret: g.event_ret, excess_stated: g.excess_stated, excess_spy: g.excess_spy, excess_style: g.excess_style,
          vol_pre: g.vol_pre, beta_spy_pre: g.beta_spy_pre, down_cap_pre: g.down_cap_pre, alpha_day: g.alpha_day, since_event: g.since_event },
        { manager: idxName(g.style_index), event_ret: g.style_index_ret },
        { manager: idxName(DATA.sp500), event_ret: ev.market.spy_ret },
      ];
      table(document.getElementById("event" + style), cols, ev.rows.filter((r) => r.style === style), { sortable: true, sortKey: "event_ret", asc: false, footer });
    });
  }
  function renderShock() {
    const ev = eventAnalysis(eventIdx);
    const d = E.dates[eventIdx];
    const named = (DATA.named_events || []).find((x) => x.date === d);
    document.getElementById("eventDate").value = d;
    document.getElementById("capVol").textContent = `Volatility over the ${rangeLabel()} window ending the day before ${fmtDate(d)}`;
    document.getElementById("capBeta").textContent = `Beta to the S&P 500 over the ${rangeLabel()} window ending the day before ${fmtDate(d)}`;
    if (named) setEventNote(`${named.label}.`);
    renderTiles(ev);
    renderFinding(ev);
    scatter("scatterVol", ev, "vol_pre", `Pre-event volatility (${rangeLabel()})`, (v) => pct(v, 0));
    scatter("scatterBeta", ev, "beta_spy_pre", `Pre-event beta vs S&P 500 (${rangeLabel()})`, (v) => num(v, 1));
    pathChart("pathGrowth", eventIdx, "Growth");
    pathChart("pathValue", eventIdx, "Value");
    renderEventTables(ev);
  }
  function setEventNote(text, warn = false) {
    const el = document.getElementById("eventNote");
    el.textContent = text;
    el.classList.toggle("warn", warn);
  }
  function selectDate(iso, fromUser = false) {
    if (!iso) return;
    let i = E.dates.indexOf(iso);
    let note = "";
    if (i < 0) {
      i = -1;
      for (let k = E.last; k >= 0; k--) if (E.dates[k] <= iso) { i = k; break; }
      if (i < 0) i = E.minIdx;
      note = `Markets were closed on ${fmtDate(iso)}; showing the previous trading day, ${fmtDate(E.dates[i])}.`;
    }
    if (i < E.minIdx) { i = E.minIdx; note = `The earliest date available is ${fmtDate(E.dates[i])}.`; }
    eventIdx = i;
    setEventNote(note || (fromUser ? `Showing ${fmtDate(E.dates[i])}. Pre-event measures use the ${rangeLabel()} window ending the day before.` :
      "Type any trading day since Jan 1, 2020. Pre-event measures use only data from before that day, over the lookback window chosen at the top."), !!note);
    renderShock();
    renderSigmaList();
    renderTimeSeries();
  }

  // ---------- sigma filter ----------
  function renderSigmaList() {
    const panel = document.getElementById("sigmaPanel");
    if (!sigmaK) { panel.hidden = true; sigmaHits = []; return; }
    const [a, b] = win(E.last);
    sigmaHits = [];
    for (let i = Math.max(a, E.minIdx); i <= b; i++) if (E.sigma[i] != null && Math.abs(E.sigma[i]) >= sigmaK) sigmaHits.push(i);
    sigmaHits.reverse();
    panel.hidden = false;
    document.getElementById("sigmaHead").innerHTML =
      `<b>${sigmaHits.length}</b> day${sigmaHits.length === 1 ? "" : "s"} with an S&amp;P 500 move of ≥ ${sigmaK}σ (vs its prior 60-day volatility) in the ${rangeLabel()} window. Click one to analyze it.`;
    const shown = sigmaHits.slice(0, 200);
    document.getElementById("sigmaList").innerHTML = shown.map((i) => {
      const s = E.sigma[i], r = E.ret[DATA.sp500][i];
      return `<button type="button" class="sigma-chip ${i === eventIdx ? "active" : ""} ${s < 0 ? "down" : "up"}" data-i="${i}">
        <span class="d">${fmtDate(E.dates[i])}</span><span class="s">${num(s, 1, true)}σ · ${pct(r, 2, true)}</span></button>`;
    }).join("") + (sigmaHits.length > shown.length ? `<span class="hint">Showing the 200 most recent. Raise the sigma level or shorten the window to narrow it.</span>` : "");
    document.querySelectorAll(".sigma-chip").forEach((btn) => btn.addEventListener("click", () => selectDate(E.dates[+btn.dataset.i], true)));
  }

  // ---------- current risk ----------
  function riskRow(name, t, style, sb, basis, a, b) {
    const li = lastIdx(t);
    return {
      manager: name, ticker: t, style, stated_benchmark: sb || "", pricing_basis: basis, last_date: E.dates[li],
      ret_1d: E.ret[t][li], ret_range: periodRet(t, a, b), vol_range: annVol(t, a, b), vol20: annVol(t, li - 19, li),
      beta_spy: beta(t, DATA.sp500, a, b), beta_stated: sb ? beta(t, sb, a, b) : null, corr_stated: sb ? corr(t, sb, a, b) : null,
      te_stated: sb ? te(t, sb, a, b) : null, up_cap: sb ? capture(t, sb, a, b, "up") : null, down_cap: sb ? capture(t, sb, a, b, "down") : null,
      max_dd: maxDD(t, a, b), obs: countObs(t, a, b),
    };
  }
  function renderRisk() {
    const [a, b] = win(E.last), L = rangeLabel(), P = (v) => pct(v), R = (v) => num(v);
    document.getElementById("riskNote").textContent =
      `Measured over the ${L} window (${fmtDate(E.dates[a])} to ${fmtDate(E.dates[b])}). Benchmark-relative figures use each manager's stated benchmark.`;
    const rows = DATA.funds.map((f) => riskRow(f.manager, f.ticker, f.style, f.stated_benchmark, f.pricing_basis, a, b));
    addPeer(rows, "ret_range", true, "ret");
    addPeer(rows, "vol_range", false, "vol");
    const cols = [
      { key: "manager", label: "Manager", txt: true, render: managerCell },
      { key: "stated_benchmark", label: "Stated benchmark", txt: true, render: bmkCell },
      { key: "pricing_basis", label: "Pricing basis", txt: true },
      { key: "last_date", label: "Last price", fmt: (v) => (v ? shortDate(v) : "") },
      { key: "ret_1d", label: "1D", fmt: P, color: true },
      { key: "ret_range", label: `Return (${L})`, fmt: P, color: true },
      { key: "ret_peer_rank", label: "Return peer rank", render: rankCell },
      { key: "vol_range", label: `Vol (${L})`, fmt: (v) => pct(v, 1) },
      { key: "vol_peer_rank", label: "Vol peer rank", render: rankCell, title: "1 = lowest volatility in this peer group" },
      { key: "vol20", label: "Vol 20d", fmt: (v) => pct(v, 1) },
      { key: "beta_spy", label: "Beta vs S&P 500", fmt: R },
      { key: "beta_stated", label: "Beta vs stated bmk", fmt: R },
      { key: "corr_stated", label: "Corr vs stated bmk", fmt: R },
      { key: "te_stated", label: "Tracking error", fmt: (v) => pct(v, 1) },
      { key: "up_cap", label: "Upside capture", fmt: R },
      { key: "down_cap", label: "Downside capture", fmt: R },
      { key: "max_dd", label: `Max drawdown (${L})`, fmt: P },
    ];
    ["Growth", "Value"].forEach((style) => {
      const rs = rows.filter((r) => r.style === style);
      const med = (k) => median(rs.map((r) => r[k]));
      const si = benchFor(style);
      const footer = [
        { manager: `${style} peer median`, ...Object.fromEntries(["ret_1d", "ret_range", "vol_range", "vol20", "beta_spy", "max_dd"].map((k) => [k, med(k)])) },
        riskRow(idxName(si), si, "Benchmark", null, "Index level (close)", a, b),
        riskRow(idxName(DATA.sp500), DATA.sp500, "Benchmark", null, "Index level (close)", a, b),
      ];
      table(document.getElementById("risk" + style), cols, rs, { sortable: true, sortKey: "vol_range", asc: true, footer });
    });
  }
  function renderMap() {
    table(document.getElementById("mapTable"), [
      { key: "manager", label: "SMA strategy", txt: true },
      { key: "style", label: "Peer group", txt: true, render: (v) => `<span class="tag" style="color:inherit;font-size:13px"><span class="dot ${v}"></span>${v}</span>` },
      { key: "ticker", label: "Proxy", txt: true },
      { key: "description", label: "Proxy fund", txt: true },
      { key: "pricing_basis", label: "Pricing basis", txt: true },
      { key: "stated_benchmark", label: "Stated benchmark", txt: true, render: (v) => esc(idxName(v)) },
      { key: "source", label: "Benchmark source", txt: true },
    ], DATA.funds);
  }

  // ---------- time series ----------
  function tsChart(id, style, kind) {
    const t = theme(), [a, b] = win(E.last);
    const labels = E.dates.slice(a, b + 1);
    const seriesFor = (tk) => {
      if (kind === "vol") return E.vol20[tk].slice(a, b + 1);
      const p = E.price[tk];
      let base = null;
      for (let i = a - 1; i <= b; i++) if (i >= 0 && p[i] != null) { base = p[i]; break; }
      return labels.map((_, k) => (p[a + k] == null || base == null ? null : p[a + k] / base - 1));
    };
    const ds = fundsBy(style).map((f, k) => ({ label: f.ticker, data: seriesFor(f.ticker), borderColor: t.series[k], backgroundColor: t.series[k],
      borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0, spanGaps: true }));
    const bi = benchFor(style);
    ds.push({ label: idxShort(bi) + " (style index)", data: seriesFor(bi), borderColor: t.bench, backgroundColor: t.bench, borderDash: [5, 4],
      borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointStyle: "line", spanGaps: true });
    const marks = sigmaHits.filter((i) => i >= a && i <= b && i !== eventIdx).map((i) => ({ date: E.dates[i] }));
    if (eventIdx >= a && eventIdx <= b) marks.push({ date: E.dates[eventIdx], strong: true });
    const span = b - a;
    make(id, {
      type: "line", data: { labels, datasets: ds },
      options: {
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { grid: { display: false }, border: { color: t.axis },
            ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 7, callback: function (v) {
              return new Date(this.getLabelForValue(v) + "T12:00:00").toLocaleDateString("en-US", span <= 130 ? { month: "short", day: "numeric" } : { month: "short", year: "2-digit" }); } } },
          y: { grid: { color: t.grid }, border: { display: false }, beginAtZero: kind === "vol", ticks: { callback: (v) => pct(v, 0) } },
        },
        plugins: {
          crosshair: { enabled: true, color: t.axis },
          eventMarkers: { marks, color: t.event, strong: t.bad },
          tooltip: { itemSort: (x, y) => y.raw - x.raw, callbacks: { title: (it) => fmtDate(it[0].label), label: (it) => `${it.dataset.label}: ${pct(it.raw, kind === "vol" ? 1 : 2)}` } },
        },
      },
    });
  }
  function renderTimeSeries() {
    tsChart("volGrowth", "Growth", "vol"); tsChart("volValue", "Value", "vol");
    tsChart("perfGrowth", "Growth", "perf"); tsChart("perfValue", "Value", "perf");
  }

  // ---------- edition ----------
  function renderEdition() {
    const isPublic = DATA.edition === "public";
    const ed = document.getElementById("edition");
    ed.textContent = isPublic ? "Public edition · free data" : "Private edition · Eikon";
    ed.title = isPublic ? "Built daily by GitHub from Yahoo Finance. No licensed data." : "Built on your PC. Includes Eikon data - do not share.";
  }

  // ---------- Eikon connect box (talks only to the helper on this PC) ----------
  const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
  const HELPER = LOCAL ? "" : "http://localhost:8765";
  const KEY_STORE = "emt.eikonKey";
  const store = {
    get() { try { return localStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; } },
    set(v) { try { localStorage.setItem(KEY_STORE, v); } catch (e) {} },
    clear() { try { localStorage.removeItem(KEY_STORE); } catch (e) {} },
  };
  function setMsg(text, kind = "") { const m = document.getElementById("eikonMsg"); m.textContent = text; m.className = "eikon-msg " + kind; }
  async function fetchTimeout(url, opts = {}, ms = 4000) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
  }
  async function connectEikon(key, quiet = false) {
    const btn = document.getElementById("eikonConnect");
    btn.disabled = true;
    if (!quiet) setMsg("Looking for the Eikon helper on this PC…");
    try {
      try {
        const p = await fetchTimeout(HELPER + "/api/eikon/ping", {}, 3000);
        if (!p.ok) throw new Error("HTTP " + p.status);
      } catch (e) {
        if (!quiet) setMsg("Can't reach the helper on this PC. Double-click start_eikon_helper.bat, keep Eikon open, then try again. If your browser asks to allow access to local devices, click Allow.", "bad");
        return;
      }
      // Start the pull on the helper, then poll its progress (a first run checks past dates and can take minutes).
      const start = await fetchTimeout(HELPER + "/api/eikon/holdings", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_key: key }),
      }, 15000);
      if (!start.ok && start.status !== 202) { const j = await start.json().catch(() => ({})); setMsg(j.error || "Eikon pull failed to start.", "bad"); return; }
      await pollJob();
    } catch (e) {
      setMsg("Eikon request failed: " + (e.name === "AbortError" ? "timed out" : e.message), "bad");
    } finally { btn.disabled = false; }
  }
  function showEikonResult(res) {
    DATA.eikon = res;
    renderHoldings();
    const n = Object.keys(res.holdings || {}).length, errs = (res.errors || []).slice(0, 4).join(" · ");
    if (res.status !== "ok") setMsg(res.status, "bad");
    else if (!n) setMsg(`Connected to Eikon, but no holdings came back. ${errs}`, "bad");
    else setMsg(`Loaded holdings for ${n} of ${DATA.funds.length} managers. Visible only in this browser.` + (errs ? ` Problems: ${errs}` : ""), n === DATA.funds.length ? "good" : "");
  }
  async function pollJob() {
    const btn = document.getElementById("eikonConnect");
    btn.disabled = true;
    const t0 = Date.now();
    try {
      while (Date.now() - t0 < 30 * 60 * 1000) {
        const s = await (await fetchTimeout(HELPER + "/api/eikon/status", {}, 10000)).json();
        if (s.state === "done") { showEikonResult(s.result); return; }
        if (s.state === "error") { setMsg(s.error || "Eikon pull failed.", "bad"); return; }
        if (s.state === "idle") { setMsg(""); return; }
        document.getElementById("eikonStatus").textContent = "Eikon loading…";
        setMsg(`Pulling from Eikon (${Math.round((Date.now() - t0) / 1000)}s): ${s.progress || "working"}… The button unlocks when it finishes.`);
        await new Promise((ok) => setTimeout(ok, 2000));
      }
      setMsg("Eikon pull is still running after 30 minutes. Check the helper window.", "bad");
    } finally { btn.disabled = false; }
  }
  async function resumeEikon() {
    // If the helper on this PC already has results (or a pull in progress), show them without asking again.
    try {
      const s = await (await fetchTimeout(HELPER + "/api/eikon/status", {}, 2500)).json();
      if (s.state === "done" && s.result) showEikonResult(s.result);
      else if (s.state === "running") await pollJob();
      else return false;
      return true;
    } catch (e) { return false; }
  }
  function initEikonForm() {
    const form = document.getElementById("eikonForm"), input = document.getElementById("eikonKey"), remember = document.getElementById("eikonRemember");
    const saved = store.get();
    if (saved) { input.value = saved; remember.checked = true; }
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const key = input.value.trim();
      if (remember.checked && key) store.set(key); else store.clear();
      connectEikon(key);
    });
    remember.addEventListener("change", () => { if (!remember.checked) store.clear(); });
    resumeEikon().then((had) => { if (!had && saved) connectEikon(saved, true); });
  }

  // ---------- holdings & trades ----------
  function bizDaysBetween(a, b) {
    let n = 0; const d = new Date(a + "T12:00:00"), end = new Date(b + "T12:00:00");
    while (d < end) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
    return n;
  }
  function holdingsCard(f, h) {
    const W = (v) => (v == null ? "–" : num(v, 2) + "%");
    const c = h.changes;
    let rows, changeLabel = "Change";
    if (c) {
      const gap = bizDaysBetween(c.from, c.to);
      changeLabel = gap <= 1 ? "Day-to-day change" : `Change since ${shortDate(c.from)}`;
      rows = c.rows.map((r) => {
        const dw = r.weight_change;
        const flag = r.action === "New position" ? "New position" : r.action === "Sold out" ? "Sold out"
          : dw != null && Math.abs(dw) >= FLAG_PP ? (dw > 0 ? "Up" : "Down") : "";
        return { ...r, flag, mag: Math.abs(dw || 0) };
      });
    } else {
      rows = (h.holdings || h.top || []).map((x) => ({ name: x.name, weight_now: x.weight, weight_change: null, flag: "", mag: 0 }));
    }
    const flagged = rows.filter((r) => r.flag).sort((a, b) => b.mag - a.mag);
    const primary = flagged[0];
    const rest = rows.filter((r) => !r.flag).sort((a, b) => (b.weight_now || 0) - (a.weight_now || 0));
    const ordered = [...flagged, ...rest];
    const flagText = (r) => r.flag === "Up" ? `▲ +${num(r.weight_change, 2)} pp` : r.flag === "Down" ? `▼ ${num(r.weight_change, 2)} pp` : r.flag;
    const header = c
      ? `Report ${fmtDate(c.to)} vs ${fmtDate(c.from)}${c.fund_flow_share_change != null ? ` · fund-wide share change ${pct(c.fund_flow_share_change, 1, true)}` : ""}`
      : `One report on file (${fmtDate(h.as_of)}). Changes appear once Eikon has a second report.`;
    return `<div class="card holdings-card ${flagged.length ? "flagged" : ""}">
      <div class="hc-head"><strong>${esc(f.manager)}</strong>
        ${flagged.length ? `<span class="flag-badge">${flagged.length} notable change${flagged.length > 1 ? "s" : ""}</span>` : (c ? `<span class="calm-badge">No notable changes</span>` : "")}</div>
      <div class="hint hc-sub">${f.ticker} · ${h.n_holdings} holdings · ${header}</div>
      ${primary ? `<div class="hc-primary">Biggest change: <b>${esc(primary.name)}</b>, ${esc(flagText(primary))}${primary.flag === "Sold out" ? ` (was ${W(primary.weight_prev)})` : primary.flag === "New position" ? ` at ${W(primary.weight_now)}` : ""}</div>` : ""}
      <div class="table-scroll hc-table"><table class="data"><thead><tr>
        <th class="txt">Security</th><th>Weight</th><th>${changeLabel}</th><th>Shares chg</th><th class="txt">Flag</th></tr></thead><tbody>` +
      ordered.map((r) => `<tr class="${r === primary ? "primary" : r.flag ? "flagged-row" : ""}">
        <td class="txt">${esc(r.name)}</td><td>${W(r.weight_now)}</td>
        <td class="${r.weight_change == null ? "" : r.weight_change < 0 ? "neg" : r.weight_change > 0 ? "pos" : ""}">${r.weight_change == null ? "–" : num(r.weight_change, 2, true) + " pp"}</td>
        <td>${r.share_change == null ? "–" : pct(r.share_change, 1, true)}</td>
        <td class="txt">${r.flag ? `<span class="flag">${esc(flagText(r))}</span>` : ""}</td></tr>`).join("") +
      `</tbody></table></div></div>`;
  }
  function renderHoldings() {
    const body = document.getElementById("holdingsBody"), status = document.getElementById("eikonStatus");
    const ek = DATA.eikon || { status: "not connected", holdings: {} };
    const H = ek.holdings || {}, have = Object.keys(H).length;
    status.textContent = ek.status === "ok" && have ? `Eikon connected · ${have} of ${DATA.funds.length} managers` : "Eikon not connected";
    if (!have) {
      body.innerHTML = `<div class="card prose"><p><b>No holdings loaded.</b> Enter your Eikon app key above and click <b>Load holdings</b>.</p></div>`;
      return;
    }
    let html = "";
    ["Growth", "Value"].forEach((style) => {
      html += `<h3 class="peer-h"><span class="dot ${style}"></span> ${style} peer group</h3><div class="grid-2">`;
      fundsBy(style).forEach((f) => {
        const h = H[f.ticker];
        if (h) { html += holdingsCard(f, h); return; }
        const e = (ek.errors || []).find((x) => x.startsWith(f.ticker + ":"));
        html += `<div class="card holdings-card"><div class="hc-head"><strong>${esc(f.manager)}</strong></div>
          <p class="hint">${e ? esc(e.slice(f.ticker.length + 2)) : `No Eikon holdings returned for ${f.ticker}.`}</p></div>`;
      });
      html += "</div>";
    });
    body.innerHTML = html;
  }

  // ---------- orchestration ----------
  function renderAll() {
    applyDefaults(theme());
    renderEdition();
    renderShock();
    renderSigmaList();
    renderRisk();
    renderMap();
    renderHoldings();
    renderTimeSeries();
  }
  document.querySelectorAll(".range-row button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".range-row button").forEach((x) => x.classList.toggle("active", x === b));
    rangeKey = b.dataset.range;
    document.getElementById("rangeNote").textContent = `All statistics use the ${rangeLabel()} window`;
    renderShock(); renderSigmaList(); renderRisk(); renderTimeSeries();
  }));
  document.getElementById("eventDate").addEventListener("change", (e) => selectDate(e.target.value, true));
  document.getElementById("sigmaSel").addEventListener("change", (e) => { sigmaK = +e.target.value; renderSigmaList(); renderTimeSeries(); });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => DATA && renderAll());

  fetch("data/data.json", { cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then((d) => {
      DATA = d;
      buildEngine();
      const input = document.getElementById("eventDate");
      input.min = DATA.config.min_date; input.max = E.dates[E.last];
      eventIdx = Math.max(E.minIdx, E.dates.indexOf(DATA.default_event) >= 0 ? E.dates.indexOf(DATA.default_event) : E.last);
      document.getElementById("asof").textContent = "Data as of " + fmtDate(DATA.series.dates[E.last]);
      document.getElementById("generated").textContent = "Last refreshed " + new Date(DATA.generated_utc).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) + ".";
      renderAll();
      initEikonForm();
    })
    .catch((e) => {
      const el = document.getElementById("error");
      el.hidden = false;
      el.textContent = "Could not load the dashboard data (" + e.message + "). Run tracker/manager_vol_tracker.py to generate it.";
      console.error(e);
    });
})();
