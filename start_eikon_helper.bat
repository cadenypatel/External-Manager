@echo off
REM Starts the Eikon helper on this PC (no browser window) so the PUBLIC site's
REM "Enter Eikon API key" box can load your holdings/trades. Eikon must be open.
REM Leave this window open while you use the site; close it to stop.
cd /d "%~dp0"
python tracker\serve.py --no-browser
