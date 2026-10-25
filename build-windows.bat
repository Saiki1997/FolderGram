@echo off
rem Builds the installer and the portable exe into dist\ (needs Node.js 20+ from nodejs.org)
call npm install || goto :fail
call npm test || goto :fail
call npx electron-builder --win nsis portable --x64 -c.win.signAndEditExecutable=true || goto :fail
echo.
echo Done. Look in the dist folder.
pause
exit /b 0
:fail
echo Build failed.
pause
exit /b 1
