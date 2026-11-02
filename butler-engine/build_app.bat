@echo off
rem Build Butler.exe (WebView2 edition) with MSVC.
rem CI overrides (set by the GitHub Actions pipeline):
rem   SKIP_VCVARS=1  -> MSVC env is already set up (e.g. by msvc-dev-cmd); don't call vcvars
rem   VCVARS=<path>  -> use this vcvars64.bat instead of the local VS install
rem   VERSTR=x.y.z   -> use this version string and DON'T touch build.no
setlocal
if "%SKIP_VCVARS%"=="1" goto :skipvc
if "%VCVARS%"=="" set "VCVARS=C:\Program Files\Microsoft Visual Studio\18\Professional\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" ( echo ERROR: vcvars64.bat not found & exit /b 1 )
call "%VCVARS%" >nul
if errorlevel 1 ( echo ERROR: vcvars failed & exit /b 1 )
:skipvc

cd /d "%~dp0"
rem WebView2 SDK: set WV to the NuGet-restored SDK's build\native dir. Override via the WV env var;
rem defaults to a local packages\ (restore Microsoft.Web.WebView2 there for a self-contained build).
if "%WV%"=="" set "WV=%~dp0packages\webview2\build\native"

if not "%VERSTR%"=="" goto :haveversion
rem --- local build: auto-incrementing build number (major.minor fixed) ---
set "VMAJOR=0"
set "VMINOR=3"
set "BN=0"
if exist build.no set /p BN=<build.no
set /a BN=BN+1
> build.no echo %BN%
set "B3=000%BN%"
set "B3=%B3:~-3%"
set "VERSTR=%VMAJOR%.%VMINOR%.%B3%"
echo Building version %VERSTR% (Beta)
goto :afterversion
:haveversion
echo Building version %VERSTR% (CI)
:afterversion

rc /nologo /fo app.res app.rc
if errorlevel 1 ( echo ERROR: rc failed & exit /b 1 )

cl /nologo /std:c++17 /utf-8 /EHsc /O2 /MT /DUNICODE /D_UNICODE /W3 ^
   /DAPP_VERSTR=L\"%VERSTR%\" ^
   /I "%WV%\include" ^
   app.cpp app.res /Fe:Butler.exe ^
   /link /SUBSYSTEM:WINDOWS /LIBPATH:"%WV%\x64" ^
   /MANIFEST:EMBED /MANIFESTUAC:"level='requireAdministrator' uiAccess='false'"
set RC=%errorlevel%
del /q app.obj 2>nul
if "%RC%"=="0" ( echo BUILD OK: %~dp0Butler.exe ) else ( echo BUILD FAILED rc=%RC% )
exit /b %RC%
