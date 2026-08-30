!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Lingua Franca HTTPS"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Lingua Franca WebRTC"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Lingua Franca WebRTC TCP"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Lingua Franca HTTPS" dir=in action=allow protocol=TCP localport=4173 program="$INSTDIR\Lingua Franca.exe" profile=private'
  ; All WebRTC transports share ICE port 10000. TCP is opened too: it is the fallback path for
  ; phones on Wi-Fi that blocks UDP, and previously it was advertised but never allowed through.
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Lingua Franca WebRTC" dir=in action=allow protocol=UDP localport=10000 program="$INSTDIR\Lingua Franca.exe" profile=private'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Lingua Franca WebRTC TCP" dir=in action=allow protocol=TCP localport=10000 program="$INSTDIR\Lingua Franca.exe" profile=private'
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Lingua Franca HTTPS"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Lingua Franca WebRTC"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Lingua Franca WebRTC TCP"'
!macroend
