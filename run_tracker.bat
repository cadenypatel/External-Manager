@echo off
REM Refreshes the data locally: writes site\data\data.json and site\Manager_Vol_Tracker.xlsx.
REM Close the workbook in Excel first, or the save will fail.
REM Optional: run_tracker.bat --event 2026-11-05   (shock day the Excel sheet focuses on)
cd /d "%~dp0"
python tracker\manager_vol_tracker.py %*
if %errorlevel%==0 start "" "site\Manager_Vol_Tracker.xlsx"
pause
