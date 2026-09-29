@echo off
REM ---------------------------------------------------------------------------
REM  Switch DSH Desktop to kernel 0.1.7-rc.2
REM
REM  HOW TO USE: double-click this file. It does NOT matter whether DSH Desktop
REM  is still open -- the script WAITS for it to exit, then does everything and
REM  offers to start the app again.
REM
REM  WHY THE WAIT: re-pointing the dist junction under a live app leaves that
REM  instance as "old exe + new resources", so the app must be stopped for the
REM  ~1 second the junction is swapped. Rather than asking you to close it first
REM  (two attempts failed that way), this script polls until it is gone.
REM
REM  WHAT IT DOES (each step gated: a failure stops the run)
REM    1  re-apply the profile's 0.1.7 adaptations
REM       The shell keeps a healthy-profile checkpoint (2026-09-27T07:35Z) and
REM       RESTORES it over the profile config whenever a desktop startup fails
REM       while the config differs. Measured twice today (00:47:48 and 01:15:43):
REM       it reverts the 4 dependency bumps, the settings-scope-shim dependency
REM       AND its cordis.patch.yml insert row, the release-age waivers and the
REM       lockfile. So this step must run every time before a promote.
REM    2  repoint the ~/.dsh/profiles/node_modules junction farm at dist\win-unpacked
REM       Measured: 530 of 549 entries point at the pinned 0.1.1 build
REM       build202608272104, so profile plugins resolve @deepseek-ai/* as 0.1.1
REM       and the 0.1.7 dependency line cannot link.
REM    3  promote dist\win-unpacked -> win-unpacked-build202609272329 (0.1.7-rc.2)
REM       (static smoke test; on failure the junction rolls back automatically)
REM    4  queue the desktop profile for the next startup
REM       (the shell currently has active = lastKnownGood = recover-web, so
REM        WITHOUT this a restart boots recover-web even after a good promote)
REM    5  resync the lockfile (lockfile-only; node_modules is NOT touched)
REM
REM  Exit codes: 0 = ok   1 = a step failed   2 = app did not exit in time
REM ---------------------------------------------------------------------------
setlocal
set REPO=D:\Deepseek-Harness
REM node IS on the MACHINE PATH on this box, but fall back to the default install
REM dir in case a double-clicked cmd ever inherits a thinner environment.
set NODE=node
where node >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set NODE="%ProgramFiles%\nodejs\node.exe"
set BUILD=win-unpacked-build202609272329
set STABLE=%REPO%\vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked

echo.
echo ============================================================
echo   DSH Desktop  --^>  kernel 0.1.7-rc.2
echo ============================================================
echo.

echo === step 0/5: waiting for DSH Desktop to exit ===
tasklist /FI "IMAGENAME eq DSH Desktop.exe" /NH 2>nul | find /I "DSH Desktop.exe" >nul
if errorlevel 1 goto appclosed
echo   DSH Desktop is still running.
echo.
echo   Please exit it COMPLETELY now:
echo     - close all its windows, then
echo     - right-click the tray icon and choose Exit
echo       (closing the window alone may only hide it to the tray)
echo.
echo   Waiting up to 10 minutes -- this window continues by itself.
set /a WTRIES=0
:waitloop
ping -n 4 127.0.0.1 -w 1000 >nul 2>nul
tasklist /FI "IMAGENAME eq DSH Desktop.exe" /NH 2>nul | find /I "DSH Desktop.exe" >nul
if errorlevel 1 goto appclosed
set /a WTRIES+=1
if %WTRIES% GEQ 150 goto waittimeout
goto waitloop

:waittimeout
echo.
echo ABORT: DSH Desktop is still running after 10 minutes; nothing was changed.
echo        Exit it from the tray icon, then run this script again.
pause
exit /b 2

:appclosed
echo   OK - DSH Desktop is closed.

echo.
echo === step 0.5/5: gate - can the profile link against 0.1.7? ===
%NODE% "%REPO%\scripts\verify-profile-exports.mjs" --profile desktop
if errorlevel 1 (
  echo.
  echo GATE FAILED: a LOADED profile package imports a symbol the 0.1.7 kernel does
  echo not export. Promoting now would break the desktop startup.
  echo Press Ctrl+C to abort, or any key to continue anyway.
  pause
)

echo.
echo === step 1/5: re-apply the profile's 0.1.7 adaptations ===
%NODE% "%REPO%\scripts\reapply-profile-0.1.7.mjs" --apply
if errorlevel 1 (
  echo.
  echo STEP 1 FAILED -- not repointing, not promoting; the app is unchanged.
  pause
  exit /b 1
)

echo.
echo === step 2/5: repoint the profile junction farm at dist\win-unpacked ===
%NODE% "%REPO%\scripts\repoint-profile-node-modules.mjs" --apply
if errorlevel 1 (
  echo.
  echo STEP 2 FAILED -- not promoting; the app is unchanged.
  echo Rollback: restore each farm entry from the catalog-before.json printed above.
  pause
  exit /b 1
)

echo.
echo === step 3/5: promote dist\win-unpacked -^> %BUILD% ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\scripts\promote-build.ps1" -From %BUILD%
set RC3=%ERRORLEVEL%
if not "%RC3%"=="0" (
  echo.
  echo STEP 3 FAILED ^(exit %RC3%^):
  echo   exit 1 = smoke test failed, the junction rolled back to the previous build
  echo   exit 2 = the app was running; close it and re-run
  echo The desktop profile was NOT queued, so the next restart still boots the
  echo currently working profile.
  pause
  exit /b 1
)

echo.
echo === step 4/5: queue the desktop profile for the next startup ===
%NODE% "%REPO%\scripts\select-desktop-profile.mjs" --profile desktop --apply --force
if errorlevel 1 (
  echo.
  echo STEP 4 FAILED -- the kernel is promoted, but the next restart will still
  echo boot recover-web. Re-run just this step:
  echo   node "%REPO%\scripts\select-desktop-profile.mjs" --profile desktop --apply --force
  pause
  exit /b 1
)

echo.
echo === step 5/5: resync the lockfile (lockfile-only; node_modules untouched) ===
pushd "%USERPROFILE%\.dsh\profiles\desktop"
%NODE% "%USERPROFILE%\.dsh\profiles\node_modules\pnpm\bin\pnpm.cjs" install --lockfile-only --no-frozen-lockfile
set RC5=%ERRORLEVEL%
popd
if not "%RC5%"=="0" echo   NOTE: lockfile resync failed (exit %RC5%%) -- not fatal for the startup.

echo.
echo ---------------- result ----------------
echo promoted target : %BUILD%
echo stable junction : %STABLE%
echo kernel version reachable through the junction:
powershell -NoProfile -Command "(Get-Content '%STABLE%\resources\app.asar.unpacked\node_modules\@deepseek-ai\dsh\package.json' -Raw | ConvertFrom-Json).version"
echo.
echo OK: farm + kernel junction are on 0.1.7-rc.2 and the desktop profile is queued.
echo.
echo Press any key to START DSH Desktop now (or close this window to start it later).
pause >nul
start "" "%STABLE%\DSH Desktop.exe"
echo DSH Desktop launched -- the first 0.1.7 startup takes a bit longer than usual.
echo ----------------------------------------
ping -n 5 127.0.0.1 -w 1000 >nul 2>nul
endlocal