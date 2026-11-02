@echo off
rem Build BOTH engine variants and vendor them into ..\bin:
rem   butler-core.exe  (requireAdministrator) - fixes + the elevated scheduled task
rem   butler-scan.exe  (asInvoker)            - read-only scans with no UAC prompt
rem Set WV to a restored Microsoft.Web.WebView2 SDK's build\native dir (or drop it in packages\).
setlocal
if "%SKIP_VCVARS%"=="1" goto :skipvc
if "%VCVARS%"=="" set "VCVARS=C:\Program Files\Microsoft Visual Studio\18\Professional\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" ( echo ERROR: vcvars64.bat not found & exit /b 1 )
call "%VCVARS%" >nul
:skipvc
cd /d "%~dp0"
if "%WV%"=="" set "WV=%~dp0packages\webview2\build\native"
if "%VERSTR%"=="" set "VERSTR=1.0.0"

rc /nologo /fo app.res app.rc
if errorlevel 1 ( echo ERROR: rc failed & exit /b 2 )

set COMMON=/nologo /std:c++17 /utf-8 /EHsc /O2 /MT /DUNICODE /D_UNICODE /W3 /DAPP_VERSTR=L\"%VERSTR%\" /I "%WV%\include"
set LINKC=/link /SUBSYSTEM:WINDOWS /LIBPATH:"%WV%\x64" /MANIFEST:EMBED

echo Building butler-core.exe (elevated)...
cl %COMMON% app.cpp app.res /Fe:butler-core.exe /Fo:core.obj %LINKC% /MANIFESTUAC:"level='requireAdministrator' uiAccess='false'"
if errorlevel 1 ( echo ERROR: core build failed & exit /b 3 )

echo Building butler-scan.exe (standard user)...
cl %COMMON% app.cpp app.res /Fe:butler-scan.exe /Fo:scan.obj %LINKC% /MANIFESTUAC:"level='asInvoker' uiAccess='false'"
if errorlevel 1 ( echo ERROR: scan build failed & exit /b 4 )

if not exist "..\bin" mkdir "..\bin"
copy /y butler-core.exe "..\bin\butler-core.exe" >nul
copy /y butler-scan.exe "..\bin\butler-scan.exe" >nul
del /q app.obj core.obj scan.obj butler-core.exe butler-scan.exe 2>nul
echo BUILD OK: vendored butler-core.exe + butler-scan.exe into ..\bin
exit /b 0
