@echo off
REM Refreshes all data (Yahoo prices + Eikon holdings/NAVs if Eikon is open) and opens the private dashboard.
REM Close the Excel workbook first, or the save will fail.
cd /d "%~dp0"
python tracker\manager_vol_tracker.py %*
if errorlevel 1 (
  echo.
  echo Data refresh failed - see messages above.
  pause
  exit /b 1
)
call "%~dp0open_dashboard.bat"
