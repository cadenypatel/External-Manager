@echo off
REM Serves the dashboard privately on this PC only (http://localhost:8765). Close this window to stop it.
cd /d "%~dp0"
start "" http://localhost:8765/
python -m http.server 8765 --bind 127.0.0.1 --directory site
