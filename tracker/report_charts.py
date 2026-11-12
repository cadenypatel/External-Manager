"""
PNG versions of the website's charts for the daily report email (1-year lookback, like the site's default).

  vol_growth.png / vol_value.png     20-day rolling volatility vs the style index
  perf_growth.png / perf_value.png   cumulative total return over the last year
  scatter_vol.png / scatter_beta.png pre-shock volatility / beta vs shock-day return
  path_growth.png / path_value.png   cumulative return through the latest shock day
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.ticker as mt  # noqa: E402
import numpy as np  # noqa: E402

import manager_vol_tracker as M  # noqa: E402

TD = M.TRADING_DAYS
# Same palette as the website (light mode)
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"]
GROWTH, VALUE, BENCH, INK, INK2, GRID, AXIS, EVENT = "#2a78d6", "#eb6834", "#52514e", "#0b0b0b", "#52514e", "#e1e0d9", "#c3c2b7", "#898781"
plt.rcParams.update({
    "font.family": ["Segoe UI", "DejaVu Sans", "Arial", "sans-serif"], "font.size": 9,
    "axes.edgecolor": AXIS, "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2,
    "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.6, "axes.axisbelow": True,
    "axes.spines.top": False, "axes.spines.right": False, "figure.facecolor": "white", "axes.facecolor": "white",
    "legend.frameon": False, "legend.fontsize": 8,
})
PCT = mt.FuncFormatter(lambda v, _: f"{v * 100:.0f}%")
PCT1 = mt.FuncFormatter(lambda v, _: f"{v * 100:.1f}%")


def _fig(title, sub):
    fig, ax = plt.subplots(figsize=(7.2, 3.3), dpi=110)
    fig.suptitle(title, x=0.012, ha="left", fontsize=11, fontweight="bold", color=INK, y=0.985)
    fig.text(0.012, 0.905, sub, fontsize=8.5, color=INK2, ha="left")
    return fig, ax


def _save(fig, path):
    fig.tight_layout(rect=(0, 0, 1, 0.88))
    fig.savefig(path, dpi=110)
    plt.close(fig)


def _funds(style):
    return [f["ticker"] for f in M.FUNDS if f["style"] == style]


def _lines(ax, frame, style, fmt):
    for k, t in enumerate(_funds(style)):
        if t in frame:
            ax.plot(frame.index, frame[t], color=SERIES[k], lw=1.6, label=t)
    b = M.STYLE_INDEX[style]
    ax.plot(frame.index, frame[b], color=BENCH, lw=1.6, ls=(0, (4, 3)), label=M.INDEXES[b]["short"] + " (style index)")
    ax.yaxis.set_major_formatter(fmt)
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.1), ncol=5)


def _mark(ax, dates):
    for d in dates:
        ax.axvline(d, color=EVENT, lw=0.9, ls=(0, (3, 3)))
        ax.text(d, ax.get_ylim()[1], " " + d.strftime("%b %d"), color=EVENT, fontsize=7.5, va="top")


def make_charts(px, rets, ev_date, ev_df, outdir):
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    window = px.index[-TD:]
    shocks = [ev_date] if ev_date in window else []
    files = []

    vol = (rets.rolling(20, min_periods=15).std() * np.sqrt(TD)).loc[window]
    perf = px.loc[window]
    perf = perf / perf.apply(lambda s: s.dropna().iloc[0] if s.notna().any() else np.nan) - 1

    for style, label in (("Growth", "Growth managers"), ("Value", "Value managers")):
        idx = M.INDEXES[M.STYLE_INDEX[style]]["name"]
        fig, ax = _fig(f"{label}: 20-day rolling volatility", f"Annualized, last 12 months, vs {idx}")
        _lines(ax, vol, style, PCT)
        ax.set_ylim(bottom=0)
        _mark(ax, shocks)
        _save(fig, out / f"vol_{style.lower()}.png")
        files.append(f"vol_{style.lower()}.png")

        fig, ax = _fig(f"{label}: cumulative total return", f"Last 12 months, distributions reinvested, vs {idx}")
        _lines(ax, perf, style, PCT)
        ax.axhline(0, color=AXIS, lw=0.8)
        _mark(ax, shocks)
        _save(fig, out / f"perf_{style.lower()}.png")
        files.append(f"perf_{style.lower()}.png")

    # Shock-day scatters
    for key, xlab, fname, xfmt in (("vol1y_pre", "Pre-shock volatility (1Y)", "scatter_vol.png", PCT),
                                   ("beta_spy_pre", "Pre-shock beta vs S&P 500 (1Y)", "scatter_beta.png", mt.FormatStrFormatter("%.1f"))):
        fig, ax = _fig(f"{xlab.split(' (')[0]} vs shock-day return", f"{ev_date:%b %d, %Y} · each point is a manager")
        for style, color, marker in (("Growth", GROWTH, "o"), ("Value", VALUE, "D")):
            s = ev_df[ev_df["style"] == style]
            ax.scatter(s[key], s["event_ret"], color=color, marker=marker, s=46, edgecolor="white", linewidth=1.2,
                       label=f"{style} managers", zorder=3)
            for _, r in s.iterrows():
                ax.annotate(r["ticker"], (r[key], r["event_ret"]), xytext=(6, 3), textcoords="offset points", fontsize=7.5, color=INK2)
        ax.xaxis.set_major_formatter(xfmt)
        ax.yaxis.set_major_formatter(PCT1)
        ax.set_xlabel(xlab)
        ax.set_ylabel("Shock-day return")
        ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.2), ncol=2)
        _save(fig, out / fname)
        files.append(fname)

    # Path through the shock
    i = px.index.get_loc(ev_date)
    lo, hi = max(i - 5, 1), min(i + 10, len(px.index) - 1)
    path = px.iloc[lo:hi + 1] / px.iloc[i - 1] - 1
    labels = ["Shock" if k == i else (f"+{k - i}d" if k > i else f"−{i - k}d") for k in range(lo, hi + 1)]
    for style, label in (("Growth", "Growth managers"), ("Value", "Value managers")):
        fig, ax = _fig(f"{label}: path through the shock", f"Cumulative total return from the close before {ev_date:%b %d, %Y}")
        x = np.arange(len(labels))
        for k, t in enumerate(_funds(style)):
            ax.plot(x, path[t].values, color=SERIES[k], lw=1.6, label=t)
        b = M.STYLE_INDEX[style]
        ax.plot(x, path[b].values, color=BENCH, lw=1.6, ls=(0, (4, 3)), label=M.INDEXES[b]["short"] + " (style index)")
        ax.axvline(labels.index("Shock"), color=EVENT, lw=0.9, ls=(0, (3, 3)))
        ax.set_xticks(x[::2])
        ax.set_xticklabels(labels[::2])
        ax.yaxis.set_major_formatter(PCT)
        ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.12), ncol=5)
        _save(fig, out / f"path_{style.lower()}.png")
        files.append(f"path_{style.lower()}.png")
    return files
