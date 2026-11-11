"""
Holds a scheduled GitHub Actions run until a target local time (default 08:31 America/Chicago).

GitHub cron runs in UTC and does not follow daylight saving, so the workflow is scheduled at
both 13:00 and 14:00 UTC. Only the run whose hour matches today's 08:31 CT (13:31 UTC in
summer, 14:31 UTC in winter) proceeds; it waits until 08:31 CT and then lets the email send.
Manual runs (workflow_dispatch) send immediately.
"""

import datetime as dt
import os
import sys
import time
from zoneinfo import ZoneInfo

TZ = ZoneInfo(os.environ.get("REPORT_TZ", "America/Chicago"))
HH, MM = (int(x) for x in os.environ.get("REPORT_TIME", "08:31").split(":"))


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
    target_utc = target.astimezone(dt.timezone.utc)
    expected = f"0 {target_utc.hour} * * *"
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
