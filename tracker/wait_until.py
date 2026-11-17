"""
Gate for the scheduled daily report (default 05:00 America/Chicago, every day).

GitHub's scheduler is best-effort, and for this repo scheduled runs have started 7-8 hours
late. So the workflow is triggered every hour, around the clock, and every run applies one rule
against the next 05:00 CT target (today's, or tomorrow's once today's window has passed):

  * more than MAX_WAIT before the target       -> skip (a later run will be closer)
  * up to MAX_WAIT before the target           -> build now, hold until the target, then send
  * from the target to LATE_OK after it        -> send now (started late)

The dependable trigger is the Gmail Apps Script (tools/forward_reports.gs), which starts this
workflow at ~4:45 CT every day; the hourly GitHub schedule is only a backup.

MAX_WAIT stays under GitHub's 6-hour job limit. The workflow then skips if today's report
already exists, so only one report goes out per day. Manual runs always send immediately.
"""

import datetime as dt
import os
import sys
import time
from zoneinfo import ZoneInfo

TZ = ZoneInfo(os.environ.get("REPORT_TZ", "America/Chicago"))
HH, MM = (int(x) for x in os.environ.get("REPORT_TIME", "05:00").split(":"))
MAX_WAIT = int(os.environ.get("MAX_WAIT_MIN", "340")) * 60     # 5h40m: fits in a 6h job
LATE_OK = int(os.environ.get("LATE_OK_MIN", "300")) * 60       # still send if GitHub is up to 5h late


def decide(now):
    """Return (action, target, gap_seconds). action: 'wait', 'send' or 'skip:<reason>'."""
    today = now.replace(hour=HH, minute=MM, second=0, microsecond=0)
    for target in (today, today + dt.timedelta(days=1)):
        gap = (target - now).total_seconds()
        if -LATE_OK <= gap:
            break
    if gap > MAX_WAIT:
        return f"skip:{int(gap / 60)} min before {target:%a %H:%M} - a later run will be closer", target, gap
    return ("wait" if gap > 0 else "send"), target, gap


def main():
    """`wait_until.py` decides (send/skip) and writes the target time; it never sleeps, so the
    report can be built first. `wait_until.py --sleep` then sleeps until that target."""
    out = os.environ.get("GITHUB_OUTPUT")

    def emit(**kv):
        if out:
            with open(out, "a") as f:
                for k, v in kv.items():
                    f.write(f"{k}={v}\n")

    if "--sleep" in sys.argv:
        target = float(os.environ.get("TARGET_EPOCH") or 0)
        gap = target - time.time()
        if gap > 0:
            print(f"Report built - holding it {int(gap)} s until {dt.datetime.fromtimestamp(target, TZ):%a %H:%M:%S %Z}.")
            time.sleep(gap)
        print("Sending.")
        return

    # Timed = the hourly GitHub schedule, or the 4:45 CT trigger from the Gmail Apps Script.
    if os.environ.get("TIMED", "false") != "true":
        print("Manual run: sending now.")
        return emit(send="true", target=0)
    now = dt.datetime.now(TZ)
    action, target, gap = decide(now)
    if action.startswith("skip"):
        print(f"{now:%a %H:%M %Z}: {action[5:]}. Skipping.")
        return emit(send="false", target=0)
    if action == "wait":
        print(f"{now:%a %H:%M %Z}: will send at {target:%a %H:%M %Z} ({int(gap / 60)} min).")
    else:
        print(f"{now:%a %H:%M %Z}: {int(-gap / 60)} min after {target:%H:%M} (started late) - sending now.")
    emit(send="true", target=int(target.timestamp()))


if __name__ == "__main__":
    sys.exit(main())
