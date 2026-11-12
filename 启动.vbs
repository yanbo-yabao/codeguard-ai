' CodeGuard AI - silent launcher (no console window)
' Double-click this file: the server starts in the background,
' your browser opens automatically. Run stop.bat to stop it.
Dim shell, fso, dir
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir
' Run start.bat hidden (window style 0), do not wait
shell.Run """" & dir & "\start.bat""", 0, False
