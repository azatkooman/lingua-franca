; Windows Firewall rules. A rule with both a program and a port only allows that program on that
; port, so each rule names the process that actually listens:
;   - Lingua Franca.exe serves the web pages: TCP 4173 (HTTPS) and 4175 (plain listener link).
;   - mediasoup-worker.exe carries the audio: ICE port 10000 (UDP, and TCP for Wi-Fi that blocks
;     UDP), and 10000-10100 when the shared port cannot be bound and each transport gets its own.
; The media rules used to name Lingua Franca.exe, which never opens those ports, so on a fresh
; computer phones loaded the page but received no audio unless someone answered a Windows prompt.

!define LF_WORKER "$INSTDIR\resources\bin\mediasoup-worker.exe"

!macro lfDeleteRules
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Lingua Franca HTTPS"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Lingua Franca Listener"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Lingua Franca WebRTC"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Lingua Franca WebRTC TCP"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Lingua Franca Audio UDP"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Lingua Franca Audio TCP"'
!macroend

!macro customInstall
  !insertmacro lfDeleteRules
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Lingua Franca HTTPS" dir=in action=allow protocol=TCP localport=4173 program="$INSTDIR\Lingua Franca.exe" profile=private'
  ; Plain-HTTP listener port: phones open it without a certificate warning. It serves listening only.
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Lingua Franca Listener" dir=in action=allow protocol=TCP localport=4175 program="$INSTDIR\Lingua Franca.exe" profile=private'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Lingua Franca Audio UDP" dir=in action=allow protocol=UDP localport=10000-10100 program="${LF_WORKER}" profile=private'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Lingua Franca Audio TCP" dir=in action=allow protocol=TCP localport=10000-10100 program="${LF_WORKER}" profile=private'
!macroend

!macro customUnInstall
  !insertmacro lfDeleteRules
!macroend
