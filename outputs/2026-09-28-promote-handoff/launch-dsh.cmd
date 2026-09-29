@echo off
REM ---------------------------------------------------------------------------
REM  launch-dsh.cmd - one-shot 0.1.7 switch, wired to the normal DSH Desktop icon.
REM
REM  WHY: the kernel switch must happen while DSH Desktop is CLOSED, and it cannot
REM  be done from inside a running app. Restarting alone therefore never worked
REM  (four attempts, all still 0.1.1). This launcher runs at the moment you start
REM  the app, which is exactly when nothing is running yet.
REM
REM  SAFETY: every step is best-effort. Whatever happens, this script ENDS by
REM  starting DSH Desktop from the stable junction, so it can never leave you
REM  unable to launch the app.
REM
REM  SELF-REMOVING: on a successful promote, scripts\promote-build.ps1 resets the
REM  Desktop + Start Menu shortcuts back to DSH Desktop.exe, so the next launch
REM  goes straight to the app.
REM ---------------------------------------------------------------------------
setlocal
set REPO=D:\Deepseek-Harness
set STABLE=%REPO%\vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked
set BUILD=win-unpacked-build202609272329
set LOG=%USERPROFILE%\.dsh\launch-dsh.log

REM node is on the MACHINE PATH here; fall back to the default install dir anyway.
set NODE=node
where node >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set NODE="%ProgramFiles%\nodejs\node.exe"

echo. >> "%LOG%"
echo ===== %DATE% %TIME% launch-dsh ===== >> "%LOG%"

REM ---- 0. single-flight guard (atomic mkdir as a lock; held across the wait) --
mkdir "%TEMP%\dsh-switch.lock" 2>nul
if errorlevel 1 (
  echo.
  echo   Another switch already appears to be in progress.
  echo   If no other window is open, delete this folder and retry:
  echo     %TEMP%\dsh-switch.lock
  echo.
  ping -n 6 127.0.0.1 -w 1000 >nul 2>nul
  exit /b 0
)

REM ---- 1. already running? never touch the junction -- but WAIT for it to exit --
tasklist /FI "IMAGENAME eq DSH Desktop.exe" /NH 2>nul | find /I "DSH Desktop.exe" >nul
if errorlevel 1 goto appclosed
echo.
echo   DSH Desktop is running. The 0.1.7 switch needs it CLOSED, so:
echo     - close all its windows, then
echo     - right-click the tray icon and choose Exit / Quit
echo       (closing the window alone may only hide it to the tray)
echo.
echo   Waiting up to 10 minutes; this window continues by itself.
echo [wait] app was running, waiting for exit >> "%LOG%"
set /a LW=0
:waitloop
ping -n 4 127.0.0.1 -w 1000 >nul 2>nul
tasklist /FI "IMAGENAME eq DSH Desktop.exe" /NH 2>nul | find /I "DSH Desktop.exe" >nul
if errorlevel 1 goto appclosed
set /a LW+=1
if %LW% GEQ 150 goto waitgiveup
goto waitloop

:waitgiveup
echo.
echo   Still running after 10 minutes -- nothing was changed. Exiting.
echo [wait] gave up >> "%LOG%"
rmdir "%TEMP%\dsh-switch.lock" 2>nul
ping -n 6 127.0.0.1 -w 1000 >nul 2>nul
exit /b 0

:appclosed

echo.
echo ============================================================
echo   DSH Desktop: one-time switch to kernel 0.1.7-rc.2
echo   This runs once; it takes up to ~2 minutes.
echo ============================================================
echo.

echo [1/5] re-applying the profile's 0.1.7 adaptations ... >> "%LOG%"
%NODE% "%REPO%\scripts\reapply-profile-0.1.7.mjs" --apply >> "%LOG%" 2>&1
echo [2/5] repointing the profile junction farm ... >> "%LOG%"
%NODE% "%REPO%\scripts\repoint-profile-node-modules.mjs" --apply >> "%LOG%" 2>&1
echo [3/5] promoting dist\win-unpacked -^> %BUILD% ... >> "%LOG%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\scripts\promote-build.ps1" -From %BUILD% >> "%LOG%" 2>&1
if errorlevel 1 (
  echo   promote did not complete - see %LOG%
  echo   Starting DSH Desktop anyway on the current kernel.
  echo [3/5] promote FAILED >> "%LOG%"
  goto launch
)
echo [4/5] queueing the desktop profile ... >> "%LOG%"
%NODE% "%REPO%\scripts\select-desktop-profile.mjs" --profile desktop --apply --force >> "%LOG%" 2>&1
echo [5/5] resyncing the lockfile ... >> "%LOG%"
pushd "%USERPROFILE%\.dsh\profiles\desktop"
%NODE% "%USERPROFILE%\.dsh\profiles\node_modules\pnpm\bin\pnpm.cjs" install --lockfile-only --no-frozen-lockfile >> "%LOG%" 2>&1
popd
echo   switch complete: kernel 0.1.7-rc.2 is now the stable build.
echo [done] switch complete >> "%LOG%"

:launch
rmdir "%TEMP%\dsh-switch.lock" 2>nul
echo.
echo   Starting DSH Desktop now. The first 0.1.7 startup takes longer than usual.
echo.
start "" "%STABLE%\DSH Desktop.exe"
ping -n 6 127.0.0.1 -w 1000 >nul 2>nul
endlocal