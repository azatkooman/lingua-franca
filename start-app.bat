@echo off
echo Building optimized Translation App...
call npm run build
echo Starting Web Server on Local Network...
echo ==============================================================
echo Tell users to look for the "Network" IP address below!
echo (e.g. https://192.168.x.x:4173/)
echo ==============================================================
call npm run preview -- --host
pause
