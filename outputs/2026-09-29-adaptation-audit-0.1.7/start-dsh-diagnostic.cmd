@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
set "DSH_LAUNCH_LOG=%TEMP%\dsh-diagnostic-launch.log"
cd /d "D:\Deepseek-Harness"
node scripts\pin-desktop-profile.mjs --apply
node scripts\select-desktop-profile.mjs --profile desktop --apply --force
cd /d "D:\Deepseek-Harness\vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked"
echo launching DSH Desktop > "%DSH_LAUNCH_LOG%"
"DSH Desktop.exe" --enable-logging=stderr >> "%DSH_LAUNCH_LOG%" 2>&1
echo.
echo Launch log: %DSH_LAUNCH_LOG%
pause
