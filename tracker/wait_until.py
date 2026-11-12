"""
Holds a scheduled GitHub Actions run until a target local time (default 05:00 America/Chicago).

GitHub cron runs in UTC, ignores daylight saving, and often starts a few minutes late. So the
workflow is scheduled one hour early at both UTC hours that can precede the target (summer and
winter). Only the run whose hour is exactly one hour before today's target proceeds; it waits
until the target time and then lets the report go out. Manual runs (workflow_dispatch) go immediately.
"""

import datetime as dt
import os
import sys
import time
from zoneinfo import ZoneInfo

TZ = ZoneInfo(os.environ.get("REPORT_TZ", "America/Chicago"))
HH, MM = (int(x) for x in os.environ.get("REPORT_TIME", "05:00").split(":"))


def main():
    event = os.environ.get("GITHUB_EVENT_NAME", "")
    schedule = os.environ.get("TRIGGER_SCHEDULE", "")
    out = os.environ.get("GITHUB_OUTPUT")

    def emit(go):
        if out:
            with open(out, "a") as f:
                f.write(f"send={'true' if go else 'false'}\n")
        print("send =", go)

    if event != "schedule":
        return emit(True)

    now_local = dt.datetime.now(TZ)
    target = now_local.replace(hour=HH, minute=MM, second=0, microsecond=0)
    slot_utc = (target - dt.timedelta(hours=1)).astimezone(dt.timezone.utc)
    expected = f"0 {slot_utc.hour} * * *"
    if schedule.strip() != expected:
        print(f"Trigger '{schedule}' is not today's slot ('{expected}' for {HH:02d}:{MM:02d} {TZ.key}). Skipping.")
        return emit(False)
    wait = (target - dt.datetime.now(TZ)).total_seconds()
    if wait > 0:
        print(f"Waiting {int(wait)}s until {target:%H:%M %Z}...")
        time.sleep(wait)
    else:
        print(f"GitHub started this run {int(-wait)}s late; sending now.")
    emit(True)


if __name__ == "__main__":
    sys.exit(main())
