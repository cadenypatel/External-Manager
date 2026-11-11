"""
Daily email report - overview of the PUBLIC dashboard (Yahoo Finance data only, never Eikon).

  python tracker/daily_report.py --out report.html      # build and save, no email
  python tracker/daily_report.py --send                 # build and email (needs env vars below)

Email settings come from environment variables (GitHub Actions secrets), never from code:
  SMTP_USER       Gmail address that sends the report
  SMTP_PASSWORD   a Gmail *app password* for that account (not the normal password)
  MAIL_TO         recipient address(es), comma-separated
  SMTP_HOST / SMTP_PORT  optional, default smtp.gmail.com / 465
"""

import argparse
import datetime as dt
import html
import os
import smtplib
import sys
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
import pandas as pd

import manager_vol_tracker as M

SITE_URL = "https://cadenypatel.github.io/External-Manager/"
TD = M.TRADING_DAYS

# ---------- formatting ----------
INK, INK2, MUTED, LINE, BG, HEAD = "#1a1a19", "#52514e", "#898781", "#e1e0d9", "#ffffff", "#f3f2ef"
NEG, POS, GROWTH, VALUE, ACCENT = "#b42323", "#0b6b0b", "#2a78d6", "#d0571e", "#1c5cab"
FONT = "font-family:Segoe UI,Helvetica,Arial,sans-serif;"


def pct(v, dp=2, sign=False):
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return "–"
    s = f"{abs(v) * 100:.{dp}f}%"
    return ("−" + s) if v < 0 else (("+" if sign and v > 0 else "") + s)


def num(v, dp=2, sign=False):
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return "–"
    s = f"{abs(v):.{dp}f}"
    return ("−" + s) if v < 0 else (("+" if sign and v > 0 else "") + s)


def colored(v, text):
    if v is None or (isinstance(v, float) and np.isnan(v)) or v == 0:
        return text
    return f'<span style="color:{NEG if v < 0 else POS}">{text}</span>'


def fdate(ts):
    return pd.Timestamp(ts).strftime("%b %d, %Y").replace(" 0", " ")


def table(headers, rows, first_left=True, widths=None):
    th = "".join(
        f'<th style="{FONT}font-size:11px;font-weight:600;color:{INK2};background:{HEAD};padding:7px 8px;'
        f'text-align:{"left" if (i == 0 and first_left) else "right"};border-bottom:1px solid {LINE};">{h}</th>'
        for i, h in enumerate(headers))
    body = ""
    for r in rows:
        style_row = r.get("_style", "") if isinstance(r, dict) else ""
        cells = r["cells"] if isinstance(r, dict) else r
        body += "<tr>" + "".join(
            f'<td style="{FONT}font-size:12.5px;color:{INK};padding:7px 8px;border-bottom:1px solid {LINE};'
            f'text-align:{"left" if (i == 0 and first_left) else "right"};white-space:nowrap;{style_row}">{c}</td>'
            for i, c in enumerate(cells)) + "</tr>"
    return (f'<table role="presentation" cellpadding="0" cellspacing="0" width="100%" '
            f'style="border-collapse:collapse;border:1px solid {LINE};">'
            f"<thead><tr>{th}</tr></thead><tbody>{body}</tbody></table>")


def h2(text, sub=""):
    return (f'<h2 style="{FONT}font-size:16px;color:{INK};margin:26px 0 4px;">{text}</h2>'
            + (f'<p style="{FONT}font-size:12px;color:{MUTED};margin:0 0 10px;">{sub}</p>' if sub else ""))


def para(text):
    return f'<p style="{FONT}font-size:13.5px;line-height:1.55;color:{INK};margin:8px 0;">{text}</p>'


# ---------- analytics ----------
def sigma_series(rets):
    """S&P 500 daily move in sigmas vs its own volatility over the prior year (the site's default 1Y lookback)."""
    s = rets[M.SP500]
    sd = s.rolling(TD, min_periods=60).std().shift(1)
    return s / sd


def build(px):
    rets = px.pct_change(fill_method=None)
    last = rets.index[-1]
    sig = sigma_series(rets)
    cur, bench = M.current_risk(rets, px)

    # Recent notable S&P 500 days (last ~3 months, >= 2 sigma vs 1Y volatility)
    recent = sig.iloc[-63:]
    notable = recent[recent.abs() >= 2].sort_index(ascending=False)

    # Featured shock day: most recent >= 3 sigma day in the last 3 months, else the configured event
    big = recent[recent.abs() >= 3]
    if len(big):
        ev_date = big.index[-1]
    else:
        conf = [pd.Timestamp(d) for d, _ in M.EVENTS if pd.Timestamp(d) in rets.index]
        ev_date = max(conf) if conf else recent.abs().idxmax()
    ev_df, market, groups, _ = M.event_analysis(rets, px, ev_date)
    return dict(px=px, rets=rets, last=last, sig=sig, cur=cur, bench=bench, notable=notable,
                ev_date=ev_date, ev_sigma=sig.get(ev_date), ev_df=ev_df, market=market, groups=groups)


def render(d):
    last, cur, bench = d["last"], d["cur"], d["bench"]
    rets = d["rets"]
    idx = {r["ticker"]: r for r in bench.to_dict("records")}
    sp, g, v = idx[M.SP500], idx[M.R1G], idx[M.R1V]

    # --- headline sentence
    lead = (f"The S&amp;P 500 returned <b>{pct(sp['ret_1d'])}</b> on {fdate(last)}"
            f" ({num(d['sig'].get(last), 1, True)}σ vs its 1-year volatility). "
            f"Growth (Russell 1000 Growth) {pct(g['ret_1d'], sign=True)}, value (Russell 1000 Value) {pct(v['ret_1d'], sign=True)}.")

    # --- market snapshot
    mrows = []
    for r in (sp, g, v):
        mrows.append([html.escape(r["manager"]), colored(r["ret_1d"], pct(r["ret_1d"], sign=True)),
                      colored(r["ret_1m"], pct(r["ret_1m"], sign=True)), colored(r["ret_ytd"], pct(r["ret_ytd"], sign=True)),
                      pct(r["vol20"], 1), pct(r["vol1y"], 1), pct(r["max_dd_1y"])])
    market_tbl = table(["Index (total return)", "1D", "1M", "YTD", "Vol 20d", "Vol 1Y", "Max DD 1Y"], mrows)

    # --- notable days
    if len(d["notable"]):
        nrows = [[fdate(ts), colored(rets.at[ts, M.SP500], pct(rets.at[ts, M.SP500], sign=True)), num(s, 1, True) + "σ"]
                 for ts, s in d["notable"].head(8).items()]
        notable = table(["Date", "S&P 500", "Move vs 1Y volatility"], nrows)
    else:
        notable = para("No S&amp;P 500 day of 2σ or more in the last three months.")

    # --- peer tables
    def peer_table(style):
        sub = cur[cur["style"] == style].sort_values("vol1y")
        rows = []
        for r in sub.to_dict("records"):
            rows.append([f"<b>{html.escape(r['manager'])}</b><br><span style='color:{MUTED};font-size:11px'>{r['ticker']} · vs {M.INDEXES[r['stated_benchmark']]['short']}</span>",
                         colored(r["ret_1d"], pct(r["ret_1d"], sign=True)), colored(r["ret_1m"], pct(r["ret_1m"], sign=True)),
                         colored(r["ret_ytd"], pct(r["ret_ytd"], sign=True)), pct(r["vol1y"], 1), num(r["beta_spy"]),
                         num(r["down_cap"]), pct(r["max_dd_1y"])])
        si = idx[M.STYLE_INDEX[style]]
        rows.append({"cells": [f"{html.escape(si['manager'])}", colored(si["ret_1d"], pct(si["ret_1d"], sign=True)),
                               colored(si["ret_1m"], pct(si["ret_1m"], sign=True)), colored(si["ret_ytd"], pct(si["ret_ytd"], sign=True)),
                               pct(si["vol1y"], 1), num(si["beta_spy"]), "–", pct(si["max_dd_1y"])],
                     "_style": f"background:{HEAD};color:{INK2};font-style:italic;"})
        return table(["Manager", "1D", "1M", "YTD", "Vol 1Y", "Beta vs S&amp;P", "Down capture", "Max DD 1Y"], rows)

    # --- shock-day summary
    ev, m = d["ev_df"], d["market"]
    gG = next(x for x in d["groups"] if x["style"] == "Growth")
    gV = next(x for x in d["groups"] if x["style"] == "Value")

    def best_worst(style):
        s = ev[ev["style"] == style].sort_values("event_ret", ascending=False)
        if s.empty:
            return ""
        b, w = s.iloc[0], s.iloc[-1]
        return (f"<b>{style}:</b> best {html.escape(b['manager'])} ({pct(b['event_ret'])}, {pct(b['excess_stated'], sign=True)} vs its benchmark); "
                f"worst {html.escape(w['manager'])} ({pct(w['event_ret'])}, {pct(w['excess_stated'], sign=True)}).")

    vol_corr = ev["vol1y_pre"].corr(ev["event_ret"]) if len(ev) > 2 else np.nan
    beta_corr = ev["beta_spy_pre"].corr(ev["event_ret"]) if len(ev) > 2 else np.nan
    shock = (para(f"<b>{fdate(d['ev_date'])}</b>: S&amp;P 500 {pct(m['spy_ret'])} ({num(d['ev_sigma'], 1, True)}σ vs 1Y volatility). "
                  f"Growth peers averaged {pct(gG['event_ret'])} ({pct(gG['excess_style'], sign=True)} vs Russell 1000 Growth); "
                  f"value peers averaged {pct(gV['event_ret'])} ({pct(gV['excess_style'], sign=True)} vs Russell 1000 Value).")
             + para(best_worst("Growth") + "<br>" + best_worst("Value"))
             + para(f"Across all managers, pre-shock 1Y volatility vs the day's return: correlation {num(vol_corr)}; "
                    f"pre-shock beta vs the day's return: {num(beta_corr)}. "
                    f"{'Lower-volatility managers held up better.' if (m['spy_ret'] < 0 and vol_corr < -0.4) else ''}"))

    body = f"""
<div style="background:#f6f6f4;padding:24px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" align="center" width="680" style="max-width:680px;width:100%;background:{BG};border:1px solid {LINE};">
<tr><td style="padding:22px 26px 6px;">
  <div style="{FONT}font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:{MUTED};">Daily overview · public edition</div>
  <h1 style="{FONT}font-size:22px;color:{INK};margin:4px 0 2px;">Equity Manager Tracker</h1>
  <div style="{FONT}font-size:13px;color:{INK2};">Data as of {fdate(last)} close · lookback 1 year</div>
  {para(lead)}
  {h2("Market snapshot", "Total-return indexes. Volatility annualized.")}
  {market_tbl}
  {h2("Notable S&amp;P 500 days, last 3 months", "Moves of 2σ or more vs the index's own 1-year volatility")}
  {notable}
  {h2(f'<span style="color:{GROWTH}">●</span> Growth peer group', "Sorted by 1-year volatility, lowest first. Down capture vs each manager's stated benchmark.")}
  {peer_table("Growth")}
  {h2(f'<span style="color:{VALUE}">◆</span> Value peer group', "Sorted by 1-year volatility, lowest first. Down capture vs each manager's stated benchmark.")}
  {peer_table("Value")}
  {h2("Latest shock day")}
  {shock}
  <p style="margin:22px 0 6px;"><a href="{SITE_URL}" style="{FONT}display:inline-block;background:{INK};color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 16px;border-radius:6px;">Open the dashboard</a></p>
</td></tr>
<tr><td style="padding:12px 26px 20px;border-top:1px solid {LINE};">
  <p style="{FONT}font-size:11px;line-height:1.5;color:{MUTED};margin:0;">
  Public mutual fund and ETF proxies for the SMA strategies; returns are end-of-day, total-return, from Yahoo Finance.
  No Eikon or other licensed data is included. For internal research and monitoring. Not investment advice.</p>
</td></tr>
</table></div>"""
    subject = f"Equity Manager Tracker · {fdate(last)} · S&P 500 {pct(sp['ret_1d'], sign=True)}"
    return subject, ('<!doctype html><html><head><meta charset="utf-8">'
                     '<meta name="viewport" content="width=device-width, initial-scale=1"></head>'
                     f"<body style='margin:0'>{body}</body></html>")


def send(subject, html_body):
    user, pwd, to = os.environ.get("SMTP_USER"), os.environ.get("SMTP_PASSWORD"), os.environ.get("MAIL_TO")
    if not (user and pwd and to):
        # Not set up yet: skip quietly instead of failing the scheduled run.
        print("Email not sent: add SMTP_USER, SMTP_PASSWORD and MAIL_TO as GitHub Actions secrets.")
        return
    msg = MIMEMultipart("alternative")
    msg["Subject"], msg["From"], msg["To"] = subject, f"Equity Manager Tracker <{user}>", to
    msg.attach(MIMEText("Your email client does not display HTML. Open the dashboard: " + SITE_URL, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))
    host, port = os.environ.get("SMTP_HOST", "smtp.gmail.com"), int(os.environ.get("SMTP_PORT", "465"))
    with smtplib.SMTP_SSL(host, port, timeout=60) as s:
        s.login(user, pwd)
        s.sendmail(user, [a.strip() for a in to.split(",") if a.strip()], msg.as_string())
    print(f"Sent: {subject}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", help="also save the HTML to this file")
    ap.add_argument("--send", action="store_true")
    args = ap.parse_args()
    px = M.fetch_prices(M.all_tickers(), M.HISTORY_START)
    subject, body = render(build(px))
    if args.out:
        Path(args.out).write_text(body, encoding="utf-8")
        print(f"Saved {args.out}  ({subject})")
    if args.send:
        send(subject, body)


if __name__ == "__main__":
    main()
