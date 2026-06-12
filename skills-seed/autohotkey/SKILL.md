---
name: autohotkey
description: Automate the Windows desktop with AutoHotkey via the autohotkey tool - send keystrokes, move/click the mouse, launch apps, manipulate windows, make hotkeys.
---
# AutoHotkey automation
`autohotkey` runs an AutoHotkey **v2** script. Pass `script` (inline AHK v2 source) or `file` (an existing .ahk). Examples: type text into the active window (`Send "hello"`), launch a program (`Run "notepad.exe"`), activate a window (`WinActivate "Untitled - Notepad"`), define a persistent hotkey. This is powerful and acts on the real desktop - only do exactly what the user asked, confirm anything destructive, and never capture or exfiltrate the user's input.
