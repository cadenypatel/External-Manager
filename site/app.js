/* Equity Manager Tracker - dashboard
   Reads data/data.json produced by tracker/manager_vol_tracker.py */
(() => {
  "use strict";

  let DATA = null;
  let currentEvent = null;
  let rangeDays = 252;
  const charts = {};

  // ---------- formatting ----------
  const MINUS = "−";
  const pct = (v, dp = 2, sign = false) => {
    if (v === null || v === undefined || Number.isNaN(v)) return "–";
    const s = (Math.abs(v) * 100).toFixed(dp) + "%";
    if (v < 0) return MINUS + s;
    return (sign && v > 0 ? "+" : "") + s;
  };
  const num = (v, dp = 2, sign = false) => {
    if (v === null || v === undefined || Number.isNaN(v)) return "–";
    const s = Math.abs(v).toFixed(dp);
    if (v < 0) return MINUS + s;
    return (sign && v > 0 ? "+" : "") + s;
  };
  const fmtDate = (iso) => {
    const d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };
  const shortDate = (iso) => {
    const d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- theme ----------
  function theme() {
    return {
      ink: css("--ink"), ink2: css("--ink-2"), muted: css("--muted"), grid: css("--grid"), axis: css("--axis"),
      surface: css("--surface"), growth: css("--growth"), value: css("--value"),
      series: [css("--s1"), css("--s2"), css("--s3"), css("--s4")], bench: css("--bench"), event: css("--event"),
    };
  }
  function applyDefaults(t) {
    Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
    Chart.defaults.font.size = 12;
    Chart.defaults.color = t.ink2;
    Chart.defaults.borderColor = t.grid;
    Chart.defaults.maintainAspectRatio = false;
    Chart.defaults.animation = false;
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.legend.labels.boxWidth = 8;
    Chart.defaults.plugins.legend.labels.boxHeight = 8;
    Chart.defaults.plugins.legend.position = "bottom";
    Object.assign(Chart.defaults.plugins.tooltip, {
      backgroundColor: t.surface, titleColor: t.ink, bodyColor: t.ink2, borderColor: t.axis, borderWidth: 1,
      padding: 10, usePointStyle: true, boxPadding: 4,
    });
  }

  // ---------- chart plugins ----------
  // Direct labels on scatter points, with simple collision avoidance.
  const pointLabels = {
    id: "pointLabels",
    afterDatasetsDraw(chart, _a, opts) {
      if (!opts || !opts.enabled) return;
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillStyle = opts.color;
      ctx.textBaseline = "middle";
      const placed = [];
      const pts = [];
      chart.data.datasets.forEach((ds, i) => {
        chart.getDatasetMeta(i).data.forEach((el, j) => pts.push({ x: el.x, y: el.y, label: ds.data[j].label }));
      });
      pts.sort((a, b) => a.y - b.y);
      const overlaps = (r) => placed.some((p) => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y)
        || pts.some((p) => Math.abs(p.x - (r.x + r.w / 2)) < r.w / 2 + 5 && Math.abs(p.y - (r.y + r.h / 2)) < r.h / 2 + 5);
      pts.forEach((p) => {
        const w = ctx.measureText(p.label).width, h = 13;
        const cands = [
          { x: p.x + 9, y: p.y - h / 2 }, { x: p.x - 9 - w, y: p.y - h / 2 },
          { x: p.x - w / 2, y: p.y - 10 - h }, { x: p.x - w / 2, y: p.y + 10 },
          { x: p.x + 9, y: p.y - h - 6 }, { x: p.x + 9, y: p.y + 6 },
          { x: p.x - 9 - w, y: p.y - h - 6 }, { x: p.x - 9 - w, y: p.y + 6 },
        ];
        let pick = cands.find((c) => {
          const r = { ...c, w, h };
          return r.x >= chartArea.left && r.x + w <= chartArea.right && r.y >= chartArea.top - 4 && r.y + h <= chartArea.bottom + 4 && !overlaps(r);
        }) || cands[0];
        placed.push({ ...pick, w, h });
        ctx.fillText(p.label, pick.x, pick.y + h / 2);
      });
      ctx.restore();
    },
  };
  // Vertical markers at shock days on time-series charts.
  const eventMarkers = {
    id: "eventMarkers",
    beforeDatasetsDraw(chart, _a, opts) {
      if (!opts || !opts.dates || !opts.dates.length) return;
      const { ctx, chartArea, scales } = chart;
      const labels = chart.data.labels;
      ctx.save();
      ctx.strokeStyle = opts.color;
      ctx.fillStyle = opts.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
      let lastRight = -Infinity, row = 0;
      opts.dates.forEach((d) => {
        const i = labels.indexOf(d);
        if (i < 0) return;
        const x = scales.x.getPixelForValue(i);
        ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
        const txt = opts.text || shortDate(d);
        const w = ctx.measureText(txt).width;
        let lx = x + 4;
        if (lx + w > chartArea.right) lx = x - 4 - w;           // flip left at the right edge
        row = lx < lastRight + 6 ? row + 1 : 0;                  // stack labels that would collide
        ctx.fillText(txt, lx, chartArea.top + 10 + row * 13);
        lastRight = Math.max(lastRight, lx + w);
      });
      ctx.restore();
    },
  };
  // Crosshair on hover for line charts.
  const crosshair = {
    id: "crosshair",
    afterDraw(chart, _a, opts) {
      if (!opts || !opts.enabled) return;
      const act = chart.tooltip && chart.tooltip.getActiveElements();
      if (!act || !act.length) return;
      const x = act[0].element.x;
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.strokeStyle = opts.color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
      ctx.restore();
    },
  };
  Chart.register(pointLabels, eventMarkers, crosshair);

  function make(id, cfg) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id), cfg);
  }

  // ---------- helpers ----------
  const fundsBy = (style) => DATA.funds.filter((f) => f.style === style);
  const benchFor = (style) => DATA.style_index[style];
  const idxShort = (t) => (DATA.indexes[t] ? DATA.indexes[t].short : t);
  const idxName = (t) => (DATA.indexes[t] ? DATA.indexes[t].name : t);

  // ---------- shock day ----------
  function renderEventSelect() {
    const sel = document.getElementById("eventSelect");
    const evs = [...DATA.events].reverse();
    sel.innerHTML = evs.map((e) => `<option value="${e.date}">${esc(e.label)}${e.auto ? " (auto)" : ""}</option>`).join("");
    sel.value = currentEvent.date;
    sel.onchange = () => {
      currentEvent = DATA.events.find((e) => e.date === sel.value);
      renderShock();
    };
  }

  function renderTiles(ev) {
    const m = ev.market;
    const g = ev.groups.find((x) => x.style === "Growth");
    const v = ev.groups.find((x) => x.style === "Value");
    const tiles = [
      ["S&P 500 Index (TR)", pct(m.spy_ret), `${num(m.spy_sigma60, 1)}σ vs prior 60d · ${num(m.spy_sigma1y, 1)}σ vs 1y`],
      ["Russell 1000 Growth (TR)", pct(m.r1g_ret), "Growth style index"],
      ["Russell 1000 Value (TR)", pct(m.r1v_ret), "Value style index"],
      ["Growth peers (avg)", pct(g.event_ret), `${pct(g.excess_style, 2, true)} vs R1000 Growth`],
      ["Value peers (avg)", pct(v.event_ret), `${pct(v.excess_style, 2, true)} vs R1000 Value`],
    ];
    document.getElementById("marketTiles").innerHTML = tiles
      .map(([k, val, s]) => `<div class="tile"><div class="k">${k}</div><div class="v">${val}</div><div class="s">${s}</div></div>`)
      .join("");
  }

  function strength(r) {
    const a = Math.abs(r);
    return a >= 0.7 ? "strongly" : a >= 0.4 ? "moderately" : "weakly";
  }
  function renderFinding(ev) {
    const c = Object.fromEntries(ev.correlations.map((x) => [x.x, x.value]));
    const rows = ev.rows;
    const isDown = ev.market.spy_ret < 0;
    const bestAlpha = [...rows].sort((a, b) => b.alpha_day - a.alpha_day)[0];
    const g = ev.groups.find((x) => x.style === "Growth");
    const v = ev.groups.find((x) => x.style === "Value");
    const volR = c.vol60_pre, betaR = c.beta_spy_pre;
    const lowHelped = isDown ? volR < 0 : volR > 0;
    const maxAbsAlpha = Math.max(...rows.map((r) => Math.abs(r.alpha_day)));
    const p = [];
    p.push(`<p><b>${isDown ? "Lower" : "Higher"} pre-event volatility went with ${isDown ? "holding up better" : "gaining more"}</b>${lowHelped ? "" : " <i>(not this time)</i>"}: ` +
      `the correlation between volatility and the day's return was ${num(volR)} (${strength(volR)}), and for beta it was ${num(betaR)} (${strength(betaR)}).</p>`);
    p.push(`<p>Growth managers went in with ${pct(g.vol60_pre, 1)} volatility and a beta of ${num(g.beta_spy_pre)}, and returned ${pct(g.event_ret)}. ` +
      `Value managers went in with ${pct(v.vol60_pre, 1)} volatility and a beta of ${num(v.beta_spy_pre)}, and returned ${pct(v.event_ret)}.</p>`);
    const peerLine = (style) => {
      const rs = rows.filter((r) => r.style === style).sort((a, b) => b.event_ret - a.event_ret);
      const top = rs[0], bot = rs[rs.length - 1];
      return `${style} peers: best was <b>${esc(top.manager)}</b> (${pct(top.event_ret)}, ${pct(top.excess_stated, 2, true)} vs its ${idxShort(top.stated_benchmark)} benchmark), ` +
        `worst was <b>${esc(bot.manager)}</b> (${pct(bot.event_ret)}, ${pct(bot.excess_stated, 2, true)} vs ${idxShort(bot.stated_benchmark)}).`;
    };
    p.push(`<p>${peerLine("Growth")}<br>${peerLine("Value")}</p>`);
    p.push(`<p>After adjusting for beta, every manager was within ±${pct(maxAbsAlpha, 1)} of its beta-predicted return. The best beyond beta was ${esc(bestAlpha.manager)} at ${pct(bestAlpha.alpha_day, 2, true)}.</p>`);
    document.getElementById("finding").innerHTML = p.join("");
  }

  function scatter(id, ev, xKey, xTitle, xFmt) {
    const t = theme();
    const mk = (style, color, shape) => ({
      label: style + " managers",
      data: ev.rows.filter((r) => r.style === style).map((r) => ({ x: r[xKey], y: r.event_ret, label: r.ticker, row: r })),
      backgroundColor: color, borderColor: t.surface, borderWidth: 2, pointStyle: shape,
      pointRadius: shape === "rectRot" ? 7 : 6, pointHoverRadius: 9, pointHitRadius: 12,
    });
    make(id, {
      type: "scatter",
      data: { datasets: [mk("Growth", t.growth, "circle"), mk("Value", t.value, "rectRot")] },
      options: {
        layout: { padding: { right: 12, top: 6 } },
        scales: {
          x: { title: { display: true, text: xTitle, color: t.ink2 }, grid: { display: false }, border: { color: t.axis },
               ticks: { callback: (v) => xFmt(v) } },
          y: { title: { display: true, text: "Shock-day return", color: t.ink2 }, grid: { color: t.grid }, border: { display: false },
               ticks: { callback: (v) => pct(v, 0) } },
        },
        plugins: {
          pointLabels: { enabled: true, color: t.ink2 },
          tooltip: {
            callbacks: {
              title: (items) => items[0].raw.row.manager,
              label: (it) => [`${xTitle}: ${xFmt(it.raw.x)}`, `Shock-day return: ${pct(it.raw.y)}`,
                `vs ${idxShort(it.raw.row.stated_benchmark)} (stated bmk): ${pct(it.raw.row.excess_stated, 2, true)}`,
                `Rank in ${it.raw.row.style.toLowerCase()} peers: ${it.raw.row.event_peer_rank} of ${it.raw.row.peer_count}`,
                `Beyond beta: ${pct(it.raw.row.alpha_day, 2, true)}`],
            },
          },
        },
      },
    });
  }

  function pathChart(id, ev, style) {
    const t = theme();
    const w = ev.window;
    const labels = w.offsets.map((o, i) => (o === 0 ? "Shock" : (o > 0 ? "+" : MINUS) + Math.abs(o) + "d"));
    const ds = fundsBy(style).map((f, i) => ({
      label: f.ticker, data: w.series[f.ticker], borderColor: t.series[i], backgroundColor: t.series[i],
      borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0, spanGaps: true,
    }));
    const b = benchFor(style);
    ds.push({ label: idxShort(b) + " (style index)", data: w.series[b], borderColor: t.bench, backgroundColor: t.bench, borderDash: [5, 4],
              borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointStyle: "line" });
    const shockIdx = w.offsets.indexOf(0);
    make(id, {
      type: "line",
      data: { labels, datasets: ds },
      options: {
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { grid: { display: false }, border: { color: t.axis }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 9 } },
          y: { grid: { color: t.grid }, border: { display: false }, ticks: { callback: (v) => pct(v, 0) } },
        },
        plugins: {
          crosshair: { enabled: true, color: t.axis },
          eventMarkers: { dates: [labels[shockIdx]], color: t.event, text: fmtDate(ev.date) },
          tooltip: { callbacks: { title: (it) => `${it[0].label} · ${fmtDate(w.dates[it[0].dataIndex])}`, label: (it) => `${it.dataset.label}: ${pct(it.raw)}` } },
        },
      },
    });
  }

  // ---------- tables ----------
  function table(el, cols, rows, opts = {}) {
    let sortKey = opts.sortKey || null, asc = opts.asc ?? false;
    const draw = () => {
      let rs = [...rows];
      if (sortKey) {
        const c = cols.find((x) => x.key === sortKey);
        rs.sort((a, b) => {
          const va = a[sortKey], vb = b[sortKey];
          if (va == null) return 1; if (vb == null) return -1;
          const r = typeof va === "string" ? va.localeCompare(vb) : va - vb;
          return asc ? r : -r;
        });
        if (opts.pinBench) rs = [...rs.filter((r) => r.style !== "Benchmark"), ...rs.filter((r) => r.style === "Benchmark")];
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
      const body = "<tbody>" + rs.map((r) => tr(r)).join("") + (opts.footer || []).map((r) => tr({ ...r, __footer: true }, "footer")).join("") + "</tbody>";
      el.innerHTML = head + body;
      if (opts.sortable) {
        el.querySelectorAll("th").forEach((th) => th.addEventListener("click", () => {
          const k = th.dataset.k;
          if (k === sortKey) asc = !asc; else { sortKey = k; asc = typeof rows[0][k] === "string"; }
          draw();
        }));
      }
    };
    draw();
  }
  const managerCell = (v, r) => {
    if (r.__footer) return `<b>${esc(v)}</b>`;
    if (r.style === "Benchmark") return `${esc(v)}`;
    const f = DATA.funds.find((x) => x.ticker === r.ticker) || {};
    return `${esc(v)}<br><span class="tag"><span class="dot ${r.style}"></span>${r.ticker} · ${f.vehicle || ""}</span>`;
  };
  const rankCell = (v, r) => (v == null ? "" : `${v} of ${r.peer_count}`);
  const bmkCell = (v) => (v ? `<span title="${esc(idxName(v))}">${esc(idxShort(v))}</span>` : "");

  function renderEventTable(ev) {
    const P = (v) => pct(v), Ps = (v) => pct(v, 2, true), R = (v) => num(v);
    const cols = [
      { key: "manager", label: "Manager", txt: true, render: managerCell },
      { key: "stated_benchmark", label: "Stated benchmark", txt: true, render: bmkCell, title: "The primary benchmark the manager lists" },
      { key: "event_ret", label: "Shock-day return", fmt: P, color: true },
      { key: "excess_stated", label: "vs stated bmk", fmt: Ps, color: true },
      { key: "excess_spy", label: "vs S&P 500", fmt: Ps, color: true },
      { key: "excess_style", label: "vs style index", fmt: Ps, color: true, title: "vs Russell 1000 Growth (growth peers) or Russell 1000 Value (value peers)" },
      { key: "event_peer_rank", label: "Peer rank", render: rankCell, title: "Rank within this peer group only (1 = best)" },
      { key: "event_vs_peer", label: "vs peer median", fmt: Ps, color: true },
      { key: "sigma_own", label: "Move in own σ", fmt: (v) => num(v, 1) + "σ", title: "Shock-day return ÷ the fund's own prior 60-day daily standard deviation" },
      { key: "vol20_pre", label: "Pre vol 20d", fmt: (v) => pct(v, 1) },
      { key: "vol60_pre", label: "Pre vol 60d", fmt: (v) => pct(v, 1) },
      { key: "vol1y_pre", label: "Pre vol 1y", fmt: (v) => pct(v, 1) },
      { key: "beta_spy_pre", label: "Beta vs S&P 500", fmt: R },
      { key: "beta_stated_pre", label: "Beta vs stated bmk", fmt: R },
      { key: "down_cap_pre", label: "Downside capture (stated bmk)", fmt: R },
      { key: "pred_ret", label: "Beta-predicted", fmt: P },
      { key: "alpha_day", label: "Beyond beta", fmt: Ps, color: true, title: "Actual − beta-predicted return" },
      { key: "since_event", label: "Since shock", fmt: Ps, color: true },
    ];
    const m = ev.market;
    ["Growth", "Value"].forEach((style) => {
      const g = ev.groups.find((x) => x.style === style);
      const si = DATA.style_index[style];
      const footer = [
        { manager: `${style} peer median`, event_ret: g.event_ret_median },
        { manager: `${style} peer average`, event_ret: g.event_ret, excess_stated: g.excess_stated, excess_spy: g.excess_spy,
          excess_style: g.excess_style, vol60_pre: g.vol60_pre, beta_spy_pre: g.beta_spy_pre, down_cap_pre: g.down_cap_pre,
          alpha_day: g.alpha_day, since_event: g.since_event },
        { manager: idxName(si), event_ret: g.style_index_ret },
        { manager: idxName(DATA.sp500), event_ret: m.spy_ret },
      ];
      table(document.getElementById("event" + style), cols, ev.rows.filter((r) => r.style === style),
        { sortable: true, sortKey: "event_ret", asc: false, footer });
    });
  }

  function renderRisk() {
    const P = (v) => pct(v), R = (v) => num(v);
    const cols = [
      { key: "manager", label: "Manager", txt: true, render: managerCell },
      { key: "stated_benchmark", label: "Stated benchmark", txt: true, render: bmkCell },
      { key: "pricing_basis", label: "Pricing basis", txt: true },
      { key: "last_date", label: "Last price", fmt: (v) => (v ? shortDate(v) : "") },
      { key: "ret_1d", label: "1D", fmt: P, color: true },
      { key: "ret_1m", label: "1M", fmt: P, color: true },
      { key: "ret_1m_peer_rank", label: "1M peer rank", render: rankCell },
      { key: "ret_3m", label: "3M", fmt: P, color: true },
      { key: "ret_ytd", label: "YTD", fmt: P, color: true },
      { key: "ret_1y", label: "1Y", fmt: P, color: true },
      { key: "vol20", label: "Vol 20d", fmt: (v) => pct(v, 1) },
      { key: "vol20_peer_rank", label: "Vol 20d peer rank", render: rankCell, title: "1 = lowest volatility in this peer group" },
      { key: "vol60", label: "Vol 60d", fmt: (v) => pct(v, 1) },
      { key: "vol1y", label: "Vol 1y", fmt: (v) => pct(v, 1) },
      { key: "beta_spy", label: "Beta vs S&P 500", fmt: R },
      { key: "beta_stated", label: "Beta vs stated bmk", fmt: R },
      { key: "corr_stated", label: "Corr vs stated bmk", fmt: R },
      { key: "te_stated", label: "Tracking error vs stated bmk", fmt: (v) => pct(v, 1) },
      { key: "up_cap", label: "Upside capture", fmt: R },
      { key: "down_cap", label: "Downside capture", fmt: R },
      { key: "max_dd_1y", label: "Max drawdown 1y", fmt: P },
    ];
    const benchRow = (t) => ({ ...DATA.current_benchmarks.find((b) => b.ticker === t), style: "Benchmark", stated_benchmark: "" });
    ["Growth", "Value"].forEach((style) => {
      const rs = DATA.current.filter((r) => r.style === style);
      const med = (k) => { const v = rs.map((r) => r[k]).filter((x) => x != null).sort((a, b) => a - b); const n = v.length; return n ? (n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2) : null; };
      const footer = [
        { manager: `${style} peer median`, ...Object.fromEntries(["ret_1d", "ret_1m", "ret_3m", "ret_ytd", "ret_1y", "vol20", "vol60", "vol1y", "beta_spy", "max_dd_1y"].map((k) => [k, med(k)])) },
        benchRow(DATA.style_index[style]),
        benchRow(DATA.sp500),
      ];
      table(document.getElementById("risk" + style), cols, rs, { sortable: true, sortKey: "vol20", asc: true, footer });
    });

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

  // ---------- holdings & trades (Eikon) ----------
  function renderEdition() {
    const isPublic = DATA.edition === "public";
    const ed = document.getElementById("edition");
    ed.textContent = isPublic ? "Public edition · free data" : "Private edition · Eikon";
    ed.title = isPublic ? "Built daily by GitHub from Yahoo Finance. No licensed data." : "Built on your PC. Includes Eikon data - do not share.";
  }

  // ---------- Eikon connect box (talks only to the helper on this PC) ----------
  const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
  const HELPER = LOCAL ? "" : "http://localhost:8765";      // public site -> helper on the viewer's own PC
  const KEY_STORE = "emt.eikonKey";
  const store = {
    get() { try { return localStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; } },
    set(v) { try { localStorage.setItem(KEY_STORE, v); } catch (e) {} },
    clear() { try { localStorage.removeItem(KEY_STORE); } catch (e) {} },
  };
  function setMsg(text, kind = "") {
    const m = document.getElementById("eikonMsg");
    m.textContent = text;
    m.className = "eikon-msg " + kind;
  }
  async function fetchTimeout(url, opts = {}, ms = 4000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
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
      setMsg("Connected. Pulling holdings from Eikon (this can take a minute)…");
      const r = await fetchTimeout(HELPER + "/api/eikon/holdings", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_key: key }),
      }, 180000);
      const res = await r.json();
      if (!r.ok) { setMsg(res.error || "Eikon pull failed.", "bad"); return; }
      DATA.eikon = res;                                   // held in this page only - never uploaded
      renderHoldings();
      const n = Object.keys(res.holdings || {}).length;
      const errs = (res.errors || []).slice(0, 4).join(" · ");
      if (res.status !== "ok") setMsg(res.status, "bad");
      else if (!n) setMsg(`Connected to Eikon, but no holdings came back. ${errs}`, "bad");
      else setMsg(`Loaded holdings for ${n} of ${DATA.funds.length} managers. Visible only in this browser.` + (errs ? ` Problems: ${errs}` : ""), n === DATA.funds.length ? "good" : "");
    } catch (e) {
      setMsg("Eikon request failed: " + (e.name === "AbortError" ? "timed out" : e.message), "bad");
    } finally {
      btn.disabled = false;
    }
  }
  function initEikonForm() {
    const form = document.getElementById("eikonForm");
    const input = document.getElementById("eikonKey");
    const remember = document.getElementById("eikonRemember");
    const saved = store.get();
    if (saved) { input.value = saved; remember.checked = true; }
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const key = input.value.trim();
      if (remember.checked && key) store.set(key); else store.clear();
      connectEikon(key);
    });
    remember.addEventListener("change", () => { if (!remember.checked) store.clear(); });
    if (saved) connectEikon(saved, true);                 // quietly reconnect if the helper is running
  }

  function renderHoldings() {
    const body = document.getElementById("holdingsBody");
    const status = document.getElementById("eikonStatus");
    const ek = DATA.eikon || { status: "not connected", holdings: {} };
    const H = ek.holdings || {};
    const have = Object.keys(H).length;
    status.textContent = ek.status === "ok" && have ? `Eikon connected · ${have} of ${DATA.funds.length} managers` : "Eikon not connected";
    if (!have) {
      body.innerHTML = `<div class="card prose"><p><b>No holdings loaded.</b> Enter your Eikon app key above and click <b>Load holdings</b>.
        Trades appear once a fund has two holdings reports saved on your PC.</p></div>`;
      return;
    }
    const W = (v) => (v == null ? "–" : num(v, 2) + "%");
    const Wd = (v) => (v == null ? "–" : num(v, 2, true) + " pp");
    let html = "";
    ["Growth", "Value"].forEach((style) => {
      html += `<h3 class="peer-h"><span class="dot ${style}"></span> ${style} peer group</h3><div class="grid-2">`;
      fundsBy(style).forEach((f) => {
        const h = H[f.ticker];
        if (!h) {
          html += `<div class="card"><strong>${esc(f.manager)}</strong><p class="hint">No Eikon holdings returned for ${f.ticker}.</p></div>`;
          return;
        }
        const c = h.changes;
        const counts = c ? ["New position", "Added", "Trimmed", "Sold out"].map((k) => `<span class="chip">${k}: ${c.counts[k] || 0}</span>`).join("") : "";
        const rows = c ? c.rows.slice(0, 25) : [];
        html += `<div class="card holdings-card">
          <div class="table-title" style="padding:0 0 6px"><strong>${esc(f.manager)}</strong><span>${f.ticker} · ${h.n_holdings} holdings · as of ${fmtDate(h.as_of)}</span></div>
          ${c ? `<div class="hint" style="margin:0 0 8px">Changes ${fmtDate(c.from)} → ${fmtDate(c.to)}${c.fund_flow_share_change != null ? ` · fund-wide share change ${pct(c.fund_flow_share_change, 1, true)}` : ""}</div><div class="chips">${counts}</div>` :
            `<div class="hint" style="margin:0 0 8px">Only one holdings report saved so far (${h.snapshots.join(", ")}). Trades appear after the next report.</div>`}
          ${rows.length ? `<div class="table-scroll"><table class="data"><thead><tr><th class="txt">Security</th><th class="txt">Action</th><th>Weight before</th><th>Weight now</th><th>Change</th><th>Shares chg</th></tr></thead><tbody>` +
            rows.map((r) => `<tr><td class="txt">${esc(r.name)}</td><td class="txt">${esc(r.action)}</td><td>${W(r.weight_prev)}</td><td>${W(r.weight_now)}</td><td class="${r.weight_change < 0 ? "neg" : "pos"}">${Wd(r.weight_change)}</td><td>${r.share_change == null ? "–" : pct(r.share_change, 1, true)}</td></tr>`).join("") +
            `</tbody></table></div>` : ""}
          <details><summary>Top holdings</summary><table class="data"><tbody>${h.top.slice(0, 10).map((t) => `<tr><td class="txt">${esc(t.name)}</td><td>${W(t.weight)}</td></tr>`).join("")}</tbody></table></details>
        </div>`;
      });
      html += "</div>";
    });
    body.innerHTML = html;
  }

  // ---------- time series ----------
  function sliceIdx() {
    const n = DATA.series.dates.length;
    return Math.max(0, n - rangeDays - 1);
  }
  function tsChart(id, style, kind) {
    const t = theme();
    const S = DATA.series;
    const i0 = sliceIdx();
    const labels = S.dates.slice(i0);
    const seriesFor = (tkr) => {
      if (kind === "vol") return S.vol20[tkr].slice(i0);
      const p = S.price[tkr].slice(i0);
      const base = p.find((x) => x != null);
      return p.map((x) => (x == null || base == null ? null : x / base - 1));
    };
    const ds = fundsBy(style).map((f, i) => ({
      label: f.ticker, data: seriesFor(f.ticker), borderColor: t.series[i], backgroundColor: t.series[i],
      borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0, spanGaps: true,
    }));
    const b = benchFor(style);
    ds.push({ label: idxShort(b) + " (style index)", data: seriesFor(b), borderColor: t.bench, backgroundColor: t.bench, borderDash: [5, 4],
              borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointStyle: "line", spanGaps: true });
    const evDates = DATA.events.map((e) => e.date).filter((d) => labels.includes(d));
    make(id, {
      type: "line",
      data: { labels, datasets: ds },
      options: {
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { grid: { display: false }, border: { color: t.axis },
               ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 7,
                        callback: function (v) { const d = new Date(this.getLabelForValue(v) + "T12:00:00");
                          return d.toLocaleDateString("en-US", rangeDays <= 126 ? { month: "short", day: "numeric" } : { month: "short", year: "2-digit" }); } } },
          y: { grid: { color: t.grid }, border: { display: false }, beginAtZero: kind === "vol",
               ticks: { callback: (v) => pct(v, 0) } },
        },
        plugins: {
          crosshair: { enabled: true, color: t.axis },
          eventMarkers: { dates: evDates, color: t.event },
          tooltip: {
            itemSort: (a, b) => b.raw - a.raw,
            callbacks: { title: (it) => fmtDate(it[0].label), label: (it) => `${it.dataset.label}: ${pct(it.raw, kind === "vol" ? 1 : 2)}` },
          },
        },
      },
    });
  }
  function renderTimeSeries() {
    tsChart("volGrowth", "Growth", "vol");
    tsChart("volValue", "Value", "vol");
    tsChart("perfGrowth", "Growth", "perf");
    tsChart("perfValue", "Value", "perf");
  }

  // ---------- orchestration ----------
  function renderShock() {
    const ev = currentEvent;
    renderTiles(ev);
    renderFinding(ev);
    scatter("scatterVol", ev, "vol60_pre", "Pre-event 60d volatility", (v) => pct(v, 0));
    scatter("scatterBeta", ev, "beta_spy_pre", "Pre-event beta vs S&P 500", (v) => num(v, 1));
    pathChart("pathGrowth", ev, "Growth");
    pathChart("pathValue", ev, "Value");
    renderEventTable(ev);
  }
  function renderAll() {
    applyDefaults(theme());
    renderShock();
    renderRisk();
    renderEdition();
    renderHoldings();
    renderTimeSeries();
  }

  document.querySelectorAll(".range-row button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".range-row button").forEach((x) => x.classList.toggle("active", x === b));
    rangeDays = +b.dataset.range;
    renderTimeSeries();
  }));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => DATA && renderAll());

  fetch("data/data.json", { cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then((d) => {
      DATA = d;
      currentEvent = DATA.events[DATA.events.length - 1];
      const gen = new Date(DATA.generated_utc);
      document.getElementById("asof").textContent = "Data as of " + fmtDate(DATA.as_of);
      document.getElementById("generated").textContent = "Last refreshed " + gen.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) + ".";
      document.getElementById("sigmaCfg").textContent = DATA.config.auto_event_sigma;
      renderEventSelect();
      renderAll();
      initEikonForm();
    })
    .catch((e) => {
      const el = document.getElementById("error");
      el.hidden = false;
      el.textContent = "Could not load data/data.json (" + e.message + "). Run tracker/manager_vol_tracker.py to generate it.";
    });
})();
