@echo off
rem ===========================================================================
rem  PepperStitch - one-click build script
rem
rem  Uses MSVC when a Visual Studio C++ toolchain is present and falls back to
rem  MinGW-w64 otherwise.  The finished application is copied to dist\.
rem
rem  Usage:
rem    build.bat                     release build
rem    build.bat --debug             debug build
rem    build.bat --clean             remove the build tree first
rem    build.bat --webview2 <path>   use an unpacked WebView2 SDK package
rem ===========================================================================
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0"
set "BUILD_DIR=%ROOT%build"
set "DIST_DIR=%ROOT%dist"
set "BUILD_TYPE=Release"
set "WEBVIEW2_ROOT="
set "GENERATOR="
set "TOOLCHAIN="

:parse_arguments
if "%~1"=="" goto arguments_done
if /i "%~1"=="--debug" (
    set "BUILD_TYPE=Debug"
    shift
    goto parse_arguments
)
if /i "%~1"=="--clean" (
    if exist "%BUILD_DIR%" (
        echo Removing the previous build tree...
        rd /s /q "%BUILD_DIR%"
    )
    shift
    goto parse_arguments
)
if /i "%~1"=="--webview2" (
    set "WEBVIEW2_ROOT=%~2"
    shift
    shift
    goto parse_arguments
)
echo Unknown option: %~1
exit /b 2
:arguments_done

rem ---------------------------------------------------------------------------
rem  Find a compiler
rem ---------------------------------------------------------------------------
where cl.exe >nul 2>nul && goto use_msvc

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" goto try_mingw

set "VSPATH="
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSPATH=%%i"
if not defined VSPATH goto try_mingw
if not exist "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" goto try_mingw

echo Using MSVC from "!VSPATH!"
call "!VSPATH!\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 goto try_mingw
goto use_msvc

:use_msvc
set "TOOLCHAIN=MSVC"
set "GENERATOR=Visual Studio 17 2022"
goto build

:try_mingw
where g++.exe >nul 2>nul || goto no_compiler
where mingw32-make.exe >nul 2>nul || goto no_compiler
where windres.exe >nul 2>nul || goto no_compiler
echo Using MinGW-w64 from the PATH
set "TOOLCHAIN=MinGW"
set "GENERATOR=MinGW Makefiles"
goto build

:build
echo Building PepperStitch (%BUILD_TYPE%, %TOOLCHAIN%)...

set "WEBVIEW2_ARG="
if defined WEBVIEW2_ROOT set "WEBVIEW2_ARG=-DPS_WEBVIEW2_ROOT=%WEBVIEW2_ROOT%"

if "%TOOLCHAIN%"=="MSVC" (
    cmake -S "%ROOT%." -B "%BUILD_DIR%" -G "Visual Studio 17 2022" -A x64 %WEBVIEW2_ARG%
) else (
    cmake -S "%ROOT%." -B "%BUILD_DIR%" -G "MinGW Makefiles" -DCMAKE_BUILD_TYPE=%BUILD_TYPE% %WEBVIEW2_ARG%
)
if errorlevel 1 exit /b 1

cmake --build "%BUILD_DIR%" --config %BUILD_TYPE% --parallel
if errorlevel 1 exit /b 1

if not exist "%DIST_DIR%" mkdir "%DIST_DIR%"

rem The executable carries the version in its name, and the version lives in
rem project(...) in CMakeLists.txt, so it is read from there rather than
rem repeated here.
set "PS_VERSION="
for /f "tokens=3" %%v in ('findstr /r /c:"^project(PepperStitch VERSION" "%ROOT%CMakeLists.txt"') do set "PS_VERSION=%%v"
if not defined PS_VERSION (
    echo Could not read the version from CMakeLists.txt.
    exit /b 1
)

set "EXE_NAME=PepperStitch_v!PS_VERSION!.exe"
set "PRODUCED=%BUILD_DIR%\bin\%BUILD_TYPE%\!EXE_NAME!"
if not exist "!PRODUCED!" set "PRODUCED=%BUILD_DIR%\bin\!EXE_NAME!"
if not exist "!PRODUCED!" (
    echo The build finished but !EXE_NAME! was not found.
    exit /b 1
)

copy /y "!PRODUCED!" "%DIST_DIR%\!EXE_NAME!" >nul
if errorlevel 1 exit /b 1

echo.
echo Built %DIST_DIR%\!EXE_NAME!
exit /b 0

:no_compiler
echo.
echo No C++ toolchain was found.
echo Install either MinGW-w64 (g++, mingw32-make, windres on the PATH) or the
echo "Desktop development with C++" workload from the Visual Studio Installer.
exit /b 1
