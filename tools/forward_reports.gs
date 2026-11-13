/**
 * Forwards the 5:00 AM CT Equity Manager Tracker report from this Gmail to other people.
 * Runs inside YOUR Gmail (Google Apps Script) - no forwarding verification, no API keys.
 *
 * Strict rules - it forwards an email ONLY if ALL of these hold:
 *   - it is from notifications@github.com
 *   - its subject starts with "[cadenypatel/External-Manager] Equity Manager Tracker"
 *     (so no replies, no other repos, no other GitHub email)
 *   - it arrived TODAY, on a weekday, between 04:55 and 10:05 Central Time
 *     (the 5:00 AM report, with room for GitHub starting late)
 *   - it arrived after this script was installed (setup), so older reports are never sent
 *   - nothing has been forwarded yet today (max ONE forward per day)
 *
 * Setup: script.google.com -> project -> paste this file -> set RECIPIENTS -> Save ->
 *        run "setup" once and Allow. setup forwards nothing; the first forward is the next
 *        weekday's 5:00 AM report.
 */

const RECIPIENTS = "boss@example.com";              // comma-separate for more people
const TZ = "America/Chicago";
const SUBJECT_PREFIX = "[cadenypatel/External-Manager] Equity Manager Tracker";
const WINDOW_START = "04:55";                       // CT
const WINDOW_END = "10:05";                         // CT

function forwardReports() {
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  const today = Utilities.formatDate(now, TZ, "yyyy-MM-dd");
  if (props.getProperty("lastForwardDate") === today) return;          // already sent today
  if (Number(Utilities.formatDate(now, TZ, "u")) > 5) return;          // Sat=6, Sun=7

  const installedAt = Number(props.getProperty("installedAt") || Date.now());
  const threads = GmailApp.search(
    'from:notifications@github.com subject:"Equity Manager Tracker" newer_than:1d', 0, 10);

  const candidates = [];
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (m) {
      if (m.getFrom().indexOf("notifications@github.com") === -1) return;
      if (m.getSubject().indexOf(SUBJECT_PREFIX) !== 0) return;       // exact report subject only
      const d = m.getDate();
      if (d.getTime() < installedAt) return;                           // never older reports
      if (Utilities.formatDate(d, TZ, "yyyy-MM-dd") !== today) return; // today's only
      const hm = Utilities.formatDate(d, TZ, "HH:mm");
      if (hm < WINDOW_START || hm > WINDOW_END) return;                // the 5 AM report only
      candidates.push(m);
    });
  });
  if (!candidates.length) return;

  candidates.sort(function (a, b) { return a.getDate() - b.getDate(); });
  candidates[0].forward(RECIPIENTS, { name: "Equity Manager Tracker" });
  props.setProperty("lastForwardDate", today);                         // one per day
}

// Run once. Creates the every-5-minutes check. Forwards NOTHING now, and marks today as done,
// so the first forward is the next weekday's 5:00 AM report.
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "forwardReports") ScriptApp.deleteTrigger(t);
  });
  const props = PropertiesService.getScriptProperties();
  props.setProperty("installedAt", String(Date.now()));
  props.setProperty("lastForwardDate", Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd"));
  ScriptApp.newTrigger("forwardReports").timeBased().everyMinutes(5).create();
}
