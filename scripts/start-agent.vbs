' Launches the andy2_crawler PC agent hidden (no console window).
' A tiny shim in the Windows Startup folder calls this at logon — see USAGE.md.
Set sh = CreateObject("WScript.Shell")
root = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\scripts\") - 1)
sh.CurrentDirectory = root
sh.Run "cmd /c npx tsx src\agent\agent.ts >> data\agent-launcher.log 2>&1", 0, False
