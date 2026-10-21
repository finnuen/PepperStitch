# ===========================================================================
#  PepperStitch - build configuration
#
#  Requirements:
#    * CMake 3.20 or newer
#    * MSVC (Visual Studio 2019/2022 with the C++ workload) or MinGW-w64
#    * Internet access the first time the project is configured, only to fetch
#      the WebView2 SDK from NuGet.  Configure with
#      -DPS_WEBVIEW2_ROOT=<unpacked package>/build/native to avoid that.
#
#  The front end lives in assets/ and is compiled into the executable as
#  RCDATA resources, and so is WebView2Loader.dll, which main.cpp unpacks and
#  loads at run time.  The finished program is therefore one .exe with nothing
#  beside it, and links nothing but system DLLs.
# ===========================================================================

cmake_minimum_required(VERSION 3.20)

project(PepperStitch VERSION 1.0.0 LANGUAGES CXX)

if (NOT WIN32)
    message(FATAL_ERROR "PepperStitch is a Windows desktop application.")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if (NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

# ---------------------------------------------------------------------------
#  Microsoft Edge WebView2 SDK
# ---------------------------------------------------------------------------

set(PS_WEBVIEW2_VERSION "1.0.4258.31" CACHE STRING
    "Version of the Microsoft.Web.WebView2 NuGet package to use")

set(PS_WEBVIEW2_ROOT "" CACHE PATH
    "Unpacked Microsoft.Web.WebView2 package: the folder holding include/ and x64/")

if (NOT PS_WEBVIEW2_ROOT)
    set(_ps_cache   "${CMAKE_BINARY_DIR}/_deps/webview2")
    set(_ps_extract "${_ps_cache}/extracted")
    set(_ps_nupkg   "${_ps_cache}/Microsoft.Web.WebView2.${PS_WEBVIEW2_VERSION}.nupkg")

    if (NOT EXISTS "${_ps_extract}/build/native/include/WebView2.h")
        if (NOT EXISTS "${_ps_nupkg}")
            file(MAKE_DIRECTORY "${_ps_cache}")
            set(_ps_url "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${PS_WEBVIEW2_VERSION}/microsoft.web.webview2.${PS_WEBVIEW2_VERSION}.nupkg")
            message(STATUS "Downloading Microsoft.Web.WebView2 ${PS_WEBVIEW2_VERSION}")
            file(DOWNLOAD "${_ps_url}" "${_ps_nupkg}" STATUS _ps_status TLS_VERIFY ON SHOW_PROGRESS)

            if (NOT _ps_status MATCHES "^0")
                # CMake's bundled libcurl carries its own CA bundle and fails
                # behind TLS-inspecting proxies; PowerShell uses the Windows
                # certificate store, so it is a reliable second attempt.
                file(REMOVE "${_ps_nupkg}")
                find_program(PS_POWERSHELL_EXECUTABLE NAMES powershell pwsh
                             DOC "PowerShell used to fetch the WebView2 SDK")
                if (PS_POWERSHELL_EXECUTABLE)
                    execute_process(
                        COMMAND "${PS_POWERSHELL_EXECUTABLE}" -NoProfile -NonInteractive
                                -ExecutionPolicy Bypass -Command
                                "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${_ps_url}' -OutFile '${_ps_nupkg}' -UseBasicParsing"
                        RESULT_VARIABLE _ps_shell_status
                        OUTPUT_QUIET)
                    if (_ps_shell_status EQUAL 0 AND EXISTS "${_ps_nupkg}")
                        set(_ps_status 0)
                    endif()
                endif()
            endif()

            if (NOT _ps_status MATCHES "^0")
                file(REMOVE "${_ps_nupkg}")
                message(FATAL_ERROR
                    "Could not download the WebView2 SDK from NuGet.\n"
                    "Download the Microsoft.Web.WebView2 package by hand, unpack it, and configure with\n"
                    "    -DPS_WEBVIEW2_ROOT=<unpacked>/build/native")
            endif()
        endif()
        message(STATUS "Unpacking the WebView2 SDK")
        file(ARCHIVE_EXTRACT INPUT "${_ps_nupkg}" DESTINATION "${_ps_extract}")
    endif()

    set(PS_WEBVIEW2_ROOT "${_ps_extract}/build/native" CACHE PATH "WebView2 SDK" FORCE)
endif()

if (CMAKE_SIZEOF_VOID_P EQUAL 8)
    set(_ps_arch "x64")
else()
    set(_ps_arch "x86")
endif()

set(_ps_include "${PS_WEBVIEW2_ROOT}/include")
set(_ps_loader  "${PS_WEBVIEW2_ROOT}/${_ps_arch}")

if (NOT EXISTS "${_ps_include}/WebView2.h")
    message(FATAL_ERROR "PS_WEBVIEW2_ROOT does not look like a WebView2 package: ${PS_WEBVIEW2_ROOT}")
endif()

# ---------------------------------------------------------------------------
#  Version information
#
#  project(... VERSION ...) above is the single place a release bumps.
#  CMake writes it out here for src/app.rc (file properties) and src/main.cpp
#  (the title bar, About box and update check), so they cannot disagree.
# ---------------------------------------------------------------------------

string(REPLACE "." "," _ps_version_comma "${PROJECT_VERSION}")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/version_generated.h"
"// Generated by CMake from project(PepperStitch VERSION ...).\n"
"#ifndef PS_VERSION_GENERATED_H\n"
"#define PS_VERSION_GENERATED_H\n"
"\n"
"#define PS_VERSION_DOTTED \"${PROJECT_VERSION}\"\n"
"#define PS_VERSION_COMMA  ${_ps_version_comma},0\n"
"#define PS_FILE_NAME \"PepperStitch_v${PROJECT_VERSION}.exe\"\n"
"\n"
"#endif  // PS_VERSION_GENERATED_H\n")

# ---------------------------------------------------------------------------
#  Front end
#
#  Every file below assets/ becomes an RCDATA resource.  The resource ids and
#  the paths are written to assets_manifest.h, so the unpacking code in
#  main.cpp and the resource script cannot disagree.  Assets are configure
#  dependencies: editing app.js re-runs CMake, rewrites the .rc, and the
#  resource compiler therefore picks up the new bytes.
# ---------------------------------------------------------------------------

set(_ps_assets_root "${CMAKE_CURRENT_SOURCE_DIR}/assets")
file(GLOB_RECURSE _ps_assets RELATIVE "${_ps_assets_root}" LIST_DIRECTORIES false
     CONFIGURE_DEPENDS "${_ps_assets_root}/*")
list(SORT _ps_assets)

if (NOT _ps_assets)
    message(FATAL_ERROR "The assets folder is empty: ${_ps_assets_root}")
endif()

set(_ps_asset_files ${_ps_assets})
list(TRANSFORM _ps_asset_files PREPEND "${_ps_assets_root}/")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${_ps_asset_files})

set(_ps_assets_rc "// Generated by CMake from the files below assets/.\n")
string(CONCAT _ps_assets_header
    "// Generated by CMake from the files below assets/.\n"
    "#ifndef PS_ASSETS_MANIFEST_H\n"
    "#define PS_ASSETS_MANIFEST_H\n"
    "\n"
    "#include <cstddef>\n"
    "\n"
    "namespace ps_assets {\n"
    "\n"
    "struct Entry {\n"
    "    int id;\n"
    "    const wchar_t* path;\n"
    "};\n"
    "\n"
    "inline constexpr Entry kEntries[] = {\n")
set(_ps_asset_id 1000)
foreach(_ps_asset IN LISTS _ps_assets)
    math(EXPR _ps_asset_id "${_ps_asset_id} + 1")
    string(APPEND _ps_assets_rc "${_ps_asset_id} RCDATA \"${_ps_assets_root}/${_ps_asset}\"\n")
    string(APPEND _ps_assets_header "    { ${_ps_asset_id}, L\"${_ps_asset}\" },\n")
endforeach()

string(APPEND _ps_assets_header
    "};\n"
    "\n"
    "inline constexpr std::size_t kEntryCount = sizeof(kEntries) / sizeof(kEntries[0]);\n"
    "\n"
    "}  // namespace ps_assets\n"
    "\n"
    "#endif  // PS_ASSETS_MANIFEST_H\n")

file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/assets.rc" "${_ps_assets_rc}")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/assets_manifest.h" "${_ps_assets_header}")

# ---------------------------------------------------------------------------
#  Resources (icon, version info, the front end and the WebView2 loader)
# ---------------------------------------------------------------------------

set(_ps_loader_rc "${CMAKE_CURRENT_BINARY_DIR}/loader.rc")
file(WRITE "${_ps_loader_rc}"
"// Generated by CMake: WebView2Loader.dll, compiled into the executable.\n"
"2000 RCDATA \"${_ps_loader}/WebView2Loader.dll\"\n")

set(_ps_resources src/app.rc "${CMAKE_CURRENT_BINARY_DIR}/assets.rc" "${_ps_loader_rc}")

# A resource compiler does not know that app.rc pulls in the icons, and the
# generator does not know the version header is rewritten at configure time,
# so without this a rebuilt .ico or a bumped version would silently keep the
# previous bytes inside the exe.
set_property(SOURCE src/app.rc APPEND PROPERTY OBJECT_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/src/app.ico;${CMAKE_CURRENT_BINARY_DIR}/version_generated.h")

if (NOT MSVC)
    enable_language(RC OPTIONAL)
    if (NOT CMAKE_RC_COMPILER)
        message(FATAL_ERROR
            "A resource compiler is required: the front end is compiled into the executable.\n"
            "Install windres (MinGW-w64) or use the Visual Studio toolchain.")
    endif()
endif()

add_executable(PepperStitch WIN32 src/main.cpp ${_ps_resources})

set_target_properties(PepperStitch PROPERTIES
    # The version is in the file name too, so a folder of builds says which is
    # which without opening any of them.  It comes from the project() above.
    OUTPUT_NAME "PepperStitch_v${PROJECT_VERSION}"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

target_include_directories(PepperStitch PRIVATE "${_ps_include}" "${CMAKE_CURRENT_BINARY_DIR}")
target_compile_definitions(PepperStitch PRIVATE
    UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00 WINVER=0x0A00)

target_link_libraries(PepperStitch PRIVATE
    user32 shell32 ole32 oleaut32 dwmapi comdlg32 shlwapi advapi32 gdi32 uuid)

if (MSVC)
    target_compile_options(PepperStitch PRIVATE /W4 /permissive- /utf-8 /EHsc)
    target_link_options(PepperStitch PRIVATE /OPT:REF /OPT:ICF)
    set_property(TARGET PepperStitch PROPERTY
        MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
else()
    target_compile_options(PepperStitch PRIVATE -Wall -Wextra -Wno-unknown-pragmas)
    # One executable, no redistributable runtime beside it.
    target_link_options(PepperStitch PRIVATE
        -municode -mwindows -static -static-libgcc -static-libstdc++ -s)
endif()

message(STATUS "PepperStitch: WebView2 SDK ${PS_WEBVIEW2_VERSION} (${_ps_arch}) at ${PS_WEBVIEW2_ROOT}")
