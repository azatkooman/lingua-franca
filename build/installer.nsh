!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Lingua Franca HTTPS"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Lingua Franca WebRTC"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Lingua Franca HTTPS" dir=in action=allow protocol=TCP localport=4173 program="$INSTDIR\Lingua Franca.exe" profile=private'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Lingua Franca WebRTC" dir=in action=allow protocol=UDP localport=10000-10100 program="$INSTDIR\Lingua Franca.exe" profile=private'
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Lingua Franca HTTPS"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Lingua Franca WebRTC"'
!macroend
