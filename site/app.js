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
  const managerOf = (tkr) => (DATA.funds.find((f) => f.ticker === tkr) || {}).manager || DATA.benchmarks[tkr] || tkr;
  const benchFor = (style) => (style === "Growth" ? "IWF" : "IWD");

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
      ["S&P 500", pct(m.spy_ret), `${num(m.spy_sigma60, 1)}σ vs prior 60d · ${num(m.spy_sigma1y, 1)}σ vs 1y`],
      ["Russell 1000 Growth", pct(m.iwf_ret), "IWF"],
      ["Russell 1000 Value", pct(m.iwd_ret), "IWD"],
      ["Growth managers (avg)", pct(g.event_ret), `${pct(g.excess_bmk, 2, true)} vs IWF`],
      ["Value managers (avg)", pct(v.event_ret), `${pct(v.excess_bmk, 2, true)} vs IWD`],
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
    const best = [...rows].sort((a, b) => b.event_ret - a.event_ret)[0];
    const worst = [...rows].sort((a, b) => a.event_ret - b.event_ret)[0];
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
    p.push(`<p>Best: <b>${esc(best.manager)}</b> (${best.ticker}, ${pct(best.event_ret)}). Worst: <b>${esc(worst.manager)}</b> (${worst.ticker}, ${pct(worst.event_ret)}). ` +
      `After adjusting for beta, every manager was within ±${pct(maxAbsAlpha, 1)} of its beta-predicted return. The best beyond beta was ${esc(bestAlpha.manager)} at ${pct(bestAlpha.alpha_day, 2, true)}.</p>`);
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
                `vs ${it.raw.row.benchmark}: ${pct(it.raw.row.excess_bmk, 2, true)}`, `Beyond beta: ${pct(it.raw.row.alpha_day, 2, true)}`],
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
    ds.push({ label: b + " (benchmark)", data: w.series[b], borderColor: t.bench, backgroundColor: t.bench, borderDash: [5, 4],
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
      const body = "<tbody>" + rs.map((r) => `<tr class="${r.style === "Benchmark" ? "bench" : ""}">` + cols.map((c) => {
        const v = r[c.key];
        const out = c.render ? c.render(v, r) : c.fmt ? c.fmt(v) : esc(v ?? "");
        const cls = [c.txt ? "txt" : "", c.color && typeof v === "number" ? (v < 0 ? "neg" : v > 0 ? "pos" : "") : ""].join(" ");
        return `<td class="${cls}">${out}</td>`;
      }).join("") + "</tr>").join("") + "</tbody>";
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
  const managerCell = (v, r) => `${esc(v)}<br><span class="tag">${r.style !== "Benchmark" ? `<span class="dot ${r.style}"></span>` : ""}${r.ticker}${r.style !== "Benchmark" ? " · " + r.style : ""}</span>`;

  function renderEventTable(ev) {
    const P = (v) => pct(v), Ps = (v) => pct(v, 2, true), R = (v) => num(v);
    table(document.getElementById("eventTable"), [
      { key: "manager", label: "Manager", txt: true, render: managerCell },
      { key: "event_ret", label: "Shock-day return", fmt: P, color: true },
      { key: "bench_ret", label: "Benchmark return", fmt: P },
      { key: "excess_bmk", label: "vs benchmark", fmt: Ps, color: true },
      { key: "excess_spy", label: "vs S&P 500", fmt: Ps, color: true },
      { key: "sigma_own", label: "Move in own σ", fmt: (v) => num(v, 1) + "σ", title: "Shock-day return ÷ the fund's own prior 60-day daily standard deviation" },
      { key: "vol20_pre", label: "Pre vol 20d", fmt: (v) => pct(v, 1) },
      { key: "vol60_pre", label: "Pre vol 60d", fmt: (v) => pct(v, 1) },
      { key: "vol1y_pre", label: "Pre vol 1y", fmt: (v) => pct(v, 1) },
      { key: "beta_spy_pre", label: "Beta vs S&P", fmt: R },
      { key: "beta_bmk_pre", label: "Beta vs bmk", fmt: R },
      { key: "down_cap_pre", label: "Downside capture", fmt: R },
      { key: "pred_ret", label: "Beta-predicted", fmt: P },
      { key: "alpha_day", label: "Beyond beta", fmt: Ps, color: true, title: "Actual − beta-predicted return" },
      { key: "since_event", label: "Since shock", fmt: Ps, color: true },
    ], ev.rows, { sortable: true, sortKey: "event_ret", asc: false });

    table(document.getElementById("groupTable"), [
      { key: "style", label: "Group", txt: true, render: (v) => `<span class="tag" style="font-size:13px;color:inherit"><span class="dot ${v}"></span>${v} managers</span>` },
      { key: "event_ret", label: "Shock-day return", fmt: (v) => pct(v), color: true },
      { key: "excess_bmk", label: "vs benchmark", fmt: (v) => pct(v, 2, true), color: true },
      { key: "vol60_pre", label: "Pre vol 60d", fmt: (v) => pct(v, 1) },
      { key: "beta_spy_pre", label: "Beta vs S&P", fmt: (v) => num(v) },
      { key: "down_cap_pre", label: "Downside capture", fmt: (v) => num(v) },
      { key: "alpha_day", label: "Beyond beta", fmt: (v) => pct(v, 2, true), color: true },
      { key: "since_event", label: "Since shock", fmt: (v) => pct(v, 2, true), color: true },
    ], ev.groups);
  }

  function renderRisk() {
    const P = (v) => pct(v), R = (v) => num(v);
    table(document.getElementById("riskTable"), [
      { key: "manager", label: "Manager", txt: true, render: managerCell },
      { key: "last_date", label: "Last price", fmt: (v) => shortDate(v) },
      { key: "ret_1d", label: "1D", fmt: P, color: true },
      { key: "ret_1m", label: "1M", fmt: P, color: true },
      { key: "ret_3m", label: "3M", fmt: P, color: true },
      { key: "ret_ytd", label: "YTD", fmt: P, color: true },
      { key: "ret_1y", label: "1Y", fmt: P, color: true },
      { key: "vol20", label: "Vol 20d", fmt: (v) => pct(v, 1) },
      { key: "vol60", label: "Vol 60d", fmt: (v) => pct(v, 1) },
      { key: "vol1y", label: "Vol 1y", fmt: (v) => pct(v, 1) },
      { key: "beta_spy", label: "Beta vs S&P", fmt: R },
      { key: "beta_bmk", label: "Beta vs bmk", fmt: R },
      { key: "corr_bmk", label: "Corr vs bmk", fmt: R },
      { key: "te_bmk", label: "Tracking error", fmt: (v) => pct(v, 1) },
      { key: "up_cap", label: "Upside capture", fmt: R },
      { key: "down_cap", label: "Downside capture", fmt: R },
      { key: "max_dd_1y", label: "Max drawdown 1y", fmt: P },
    ], DATA.current, { sortable: true, sortKey: "vol20", asc: false, pinBench: true });

    table(document.getElementById("mapTable"), [
      { key: "manager", label: "SMA strategy", txt: true },
      { key: "ticker", label: "Proxy", txt: true },
      { key: "style", label: "Style", txt: true, render: (v) => `<span class="tag" style="color:inherit;font-size:13px"><span class="dot ${v}"></span>${v}</span>` },
      { key: "description", label: "Proxy fund", txt: true },
      { key: "benchmark_name", label: "Style benchmark", txt: true },
    ], DATA.funds);
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
    ds.push({ label: b + " (benchmark)", data: seriesFor(b), borderColor: t.bench, backgroundColor: t.bench, borderDash: [5, 4],
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
    })
    .catch((e) => {
      const el = document.getElementById("error");
      el.hidden = false;
      el.textContent = "Could not load data/data.json (" + e.message + "). Run tracker/manager_vol_tracker.py to generate it.";
    });
})();
