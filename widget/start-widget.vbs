' Launches the crawler status widget hidden (no console window).
' Called at logon by scripts\start-agent.vbs; run it manually to restart a closed widget.
Set sh = CreateObject("WScript.Shell")
root = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\widget\") - 1)
sh.CurrentDirectory = root
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\widget\widget.ps1""", 0, False
