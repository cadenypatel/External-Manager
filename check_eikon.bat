@echo off
REM One-time check that Eikon is reachable and which data fields your subscription returns.
REM Eikon must be open and logged in.
cd /d "%~dp0"
python tracker\lseg_check.py
pause
