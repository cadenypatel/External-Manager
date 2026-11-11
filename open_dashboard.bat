@echo off
REM Opens the dashboard privately on this PC: http://localhost:8765/External-Manager/
REM Close this window to stop it.
cd /d "%~dp0"
python tracker\serve.py
