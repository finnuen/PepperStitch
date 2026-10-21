// ===========================================================================
//  PepperStitch - a Windows image stitcher in one executable.
//
//  The window is a thin Win32 shell around Microsoft Edge WebView2.  The whole
//  user interface is compiled into this file as RCDATA resources, unpacked on
//  first run under %LOCALAPPDATA%\PepperStitch\assets and served from
//  https://app.local, so the program works with no network and nothing beside
//  the .exe.
//
//  What the host does, and nothing else:
//    * unpacks the front end and serves it (virtual host app.local)
//    * serves a dropped or command-line picture (file.local) so the page can
//      read it without a filesystem path, and so no base64 copy is needed
//    * shows the Save dialog and writes the exported bytes (save.local)
//    * a few window commands (host.local): ready, reveal, devtools, theme
//
//  The page never talks to the network, and the host never decodes an image.
// ===========================================================================

#include <windows.h>
#include <commdlg.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shlwapi.h>

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <cwctype>
#include <string>
#include <vector>

#include "WebView2.h"
#include "assets_manifest.h"
#include "resource.h"
#include "version_generated.h"

namespace {

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------

constexpr wchar_t kAppName[]      = L"PepperStitch";
constexpr wchar_t kAppHost[]      = L"app.local";
constexpr wchar_t kFileHost[]     = L"file.local";
constexpr wchar_t kSaveHost[]     = L"save.local";
constexpr wchar_t kCommandHost[]  = L"host.local";
constexpr wchar_t kStartPath[]    = L"/index.html";
constexpr wchar_t kWindowKey[]    = L"window";

constexpr int kDefaultWidth  = 1320;
constexpr int kDefaultHeight = 860;
constexpr int kMinWidth      = 1040;
constexpr int kMinHeight     = 660;

constexpr COLORREF kDarkBackground  = RGB(17, 17, 22);
constexpr COLORREF kLightBackground = RGB(244, 244, 247);

// ---------------------------------------------------------------------------
//  Minimal COM support
//
//  No WRL: this has to compile with MinGW-w64 as well as MSVC, and WRL is a
//  Visual C++ header.  Only what the WebView2 callbacks need is here.
// ---------------------------------------------------------------------------

template <typename TDerived, typename TInterface>
class ComHandler : public TInterface {
public:
    ComHandler() noexcept = default;
    ComHandler(const ComHandler&) = delete;
    ComHandler& operator=(const ComHandler&) = delete;

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** object) noexcept override {
        if (object == nullptr) {
            return E_POINTER;
        }
        *object = nullptr;
        if (::IsEqualIID(riid, IID_IUnknown) || ::IsEqualIID(riid, TDerived::InterfaceId())) {
            *object = static_cast<TInterface*>(static_cast<TDerived*>(this));
            AddRef();
            return S_OK;
        }
        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() noexcept override {
        return static_cast<ULONG>(++m_references);
    }

    ULONG STDMETHODCALLTYPE Release() noexcept override {
        const ULONG remaining = static_cast<ULONG>(--m_references);
        if (remaining == 0) {
            delete static_cast<TDerived*>(this);
        }
        return remaining;
    }

private:
    std::atomic<ULONG> m_references{1};
};

template <typename T>
class ComPtr {
public:
    ComPtr() noexcept = default;
    ~ComPtr() { Reset(); }

    ComPtr(const ComPtr&) = delete;
    ComPtr& operator=(const ComPtr&) = delete;

    ComPtr(ComPtr&& other) noexcept : m_pointer(other.m_pointer) {
        other.m_pointer = nullptr;
    }

    ComPtr& operator=(ComPtr&& other) noexcept {
        if (this != &other) {
            Reset();
            m_pointer = other.m_pointer;
            other.m_pointer = nullptr;
        }
        return *this;
    }

    [[nodiscard]] T* Get() const noexcept { return m_pointer; }
    [[nodiscard]] T* operator->() const noexcept { return m_pointer; }
    [[nodiscard]] explicit operator bool() const noexcept { return m_pointer != nullptr; }

    bool operator==(std::nullptr_t) const noexcept { return m_pointer == nullptr; }
    bool operator!=(std::nullptr_t) const noexcept { return m_pointer != nullptr; }

    // The address of the internal pointer, releasing whatever was there.
    T** Put() noexcept {
        Reset();
        return &m_pointer;
    }

    // Takes ownership of one reference.
    void Attach(T* pointer) noexcept {
        Reset();
        m_pointer = pointer;
    }

    void Reset() noexcept {
        if (m_pointer != nullptr) {
            m_pointer->Release();
            m_pointer = nullptr;
        }
    }

private:
    T* m_pointer = nullptr;
};

// ---------------------------------------------------------------------------
//  Small helpers
// ---------------------------------------------------------------------------

[[nodiscard]] std::wstring EnvironmentVariable(const wchar_t* name) {
    const DWORD needed = ::GetEnvironmentVariableW(name, nullptr, 0);
    if (needed == 0) {
        return {};
    }
    std::wstring value(needed, L'\0');
    const DWORD written = ::GetEnvironmentVariableW(name, value.data(), needed);
    value.resize(written);
    return value;
}

[[nodiscard]] bool EnsureDirectory(const std::wstring& path) {
    if (path.empty() || path.back() == L'\\') {
        return false;
    }
    const int result = ::SHCreateDirectoryExW(nullptr, path.c_str(), nullptr);
    return result == ERROR_SUCCESS || result == ERROR_ALREADY_EXISTS;
}

[[nodiscard]] std::wstring DirectoryOf(const std::wstring& path) {
    const std::size_t slash = path.find_last_of(L"\\/");
    return slash == std::wstring::npos ? std::wstring() : path.substr(0, slash);
}

[[nodiscard]] std::wstring FileNameOf(const std::wstring& path) {
    const std::size_t slash = path.find_last_of(L"\\/");
    return slash == std::wstring::npos ? path : path.substr(slash + 1);
}

[[nodiscard]] bool FileExists(const std::wstring& path) {
    const DWORD attributes = ::GetFileAttributesW(path.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

[[nodiscard]] std::wstring ToWide(const std::string& text) {
    if (text.empty()) {
        return {};
    }
    const int needed = ::MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
    std::wstring result(static_cast<std::size_t>(needed), L'\0');
    ::MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), result.data(), needed);
    return result;
}

[[nodiscard]] std::string ToUtf8(const std::wstring& text) {
    if (text.empty()) {
        return {};
    }
    const int needed = ::WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                                             nullptr, 0, nullptr, nullptr);
    std::string result(static_cast<std::size_t>(needed), '\0');
    ::WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                          result.data(), needed, nullptr, nullptr);
    return result;
}

[[nodiscard]] std::wstring JoinPath(const std::wstring& left, const std::wstring& right) {
    if (left.empty()) {
        return right;
    }
    if (left.back() == L'\\') {
        return left + right;
    }
    return left + L'\\' + right;
}

[[nodiscard]] bool WriteAllBytes(const std::wstring& path, const void* data, std::size_t size) {
    const HANDLE file = ::CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr,
                                      CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }
    const auto* bytes = static_cast<const std::uint8_t*>(data);
    std::size_t written = 0;
    bool ok = true;
    while (written < size) {
        const DWORD chunk = static_cast<DWORD>(std::min<std::size_t>(size - written, 1u << 20));
        DWORD thisTime = 0;
        if (!::WriteFile(file, bytes + written, chunk, &thisTime, nullptr) || thisTime == 0) {
            ok = false;
            break;
        }
        written += thisTime;
    }
    ::CloseHandle(file);
    return ok;
}

[[nodiscard]] bool ReadAllBytes(const std::wstring& path, std::vector<std::uint8_t>& bytes) {
    const HANDLE file = ::CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }
    LARGE_INTEGER size{};
    if (!::GetFileSizeEx(file, &size) || size.QuadPart < 0 || size.QuadPart > (1LL << 31)) {
        ::CloseHandle(file);
        return false;
    }
    bytes.resize(static_cast<std::size_t>(size.QuadPart));
    std::size_t read = 0;
    bool ok = true;
    while (read < bytes.size()) {
        const DWORD chunk = static_cast<DWORD>(std::min<std::size_t>(bytes.size() - read, 1u << 20));
        DWORD thisTime = 0;
        if (!::ReadFile(file, bytes.data() + read, chunk, &thisTime, nullptr) || thisTime == 0) {
            ok = false;
            break;
        }
        read += thisTime;
    }
    ::CloseHandle(file);
    return ok;
}

[[nodiscard]] std::string JsonEscape(const std::wstring& text) {
    std::string out;
    out.reserve(text.size() + 8);
    for (const wchar_t c : text) {
        switch (c) {
        case L'"':  out += "\\\""; break;
        case L'\\': out += "\\\\"; break;
        case L'\b': out += "\\b"; break;
        case L'\f': out += "\\f"; break;
        case L'\n': out += "\\n"; break;
        case L'\r': out += "\\r"; break;
        case L'\t': out += "\\t"; break;
        default:
            if (c < 0x20) {
                char buffer[8] = {};
                std::snprintf(buffer, sizeof(buffer), "\\u%04x", static_cast<unsigned>(c));
                out += buffer;
            } else {
                out += static_cast<char>(c);
            }
            break;
        }
    }
    return out;
}

[[nodiscard]] std::wstring PercentDecode(const std::wstring& text) {
    std::string bytes;
    bytes.reserve(text.size());
    for (std::size_t i = 0; i < text.size(); ++i) {
        if (text[i] == L'%' && i + 2 < text.size()) {
            const auto hex = [](wchar_t c) -> int {
                if (c >= L'0' && c <= L'9') return c - L'0';
                if (c >= L'a' && c <= L'f') return c - L'a' + 10;
                if (c >= L'A' && c <= L'F') return c - L'A' + 10;
                return -1;
            };
            const int high = hex(text[i + 1]);
            const int low = hex(text[i + 2]);
            if (high >= 0 && low >= 0) {
                bytes.push_back(static_cast<char>(high * 16 + low));
                i += 2;
                continue;
            }
        }
        if (text[i] < 128) {
            bytes.push_back(static_cast<char>(text[i]));
        } else {
            // Percent-decoding is only used for ASCII values the page writes
            // (formats, flags, file names it already escaped); anything else
            // is passed through as a byte of the UTF-8 stream.
            bytes.push_back(static_cast<char>(text[i] & 0xFF));
        }
    }
    return ToWide(bytes);
}

[[nodiscard]] std::wstring QueryValue(const std::wstring& uri, const wchar_t* key) {
    const std::size_t question = uri.find(L'?');
    if (question == std::wstring::npos) {
        return {};
    }
    const std::wstring query = uri.substr(question + 1);
    const std::wstring needle = std::wstring(key) + L'=';
    std::size_t position = 0;
    while (position < query.size()) {
        const std::size_t end = query.find(L'&', position);
        const std::wstring pair = query.substr(position, end == std::wstring::npos ? std::wstring::npos : end - position);
        if (pair.rfind(needle, 0) == 0) {
            return PercentDecode(pair.substr(needle.size()));
        }
        if (end == std::wstring::npos) {
            break;
        }
        position = end + 1;
    }
    return {};
}

[[nodiscard]] std::wstring UriHost(const std::wstring& uri) {
    const std::size_t scheme = uri.find(L"://");
    if (scheme == std::wstring::npos) {
        return {};
    }
    const std::size_t start = scheme + 3;
    const std::size_t end = uri.find_first_of(L"/?#", start);
    return uri.substr(start, end == std::wstring::npos ? std::wstring::npos : end - start);
}

[[nodiscard]] std::wstring UriPath(const std::wstring& uri) {
    const std::size_t scheme = uri.find(L"://");
    if (scheme == std::wstring::npos) {
        return {};
    }
    const std::size_t start = uri.find_first_of(L"/?#", scheme + 3);
    if (start == std::wstring::npos || uri[start] != L'/') {
        return {};
    }
    const std::size_t end = uri.find_first_of(L"?#", start);
    return uri.substr(start, end == std::wstring::npos ? std::wstring::npos : end - start);
}

[[nodiscard]] const wchar_t* MimeForPath(const std::wstring& path) {
    const std::wstring extension = [&] {
        std::wstring value = FileNameOf(path);
        const std::size_t dot = value.find_last_of(L'.');
        if (dot == std::wstring::npos) return std::wstring();
        value = value.substr(dot + 1);
        std::transform(value.begin(), value.end(), value.begin(), towlower);
        return value;
    }();

    if (extension == L"png")  return L"image/png";
    if (extension == L"jpg" || extension == L"jpeg" || extension == L"jfif") return L"image/jpeg";
    if (extension == L"webp") return L"image/webp";
    if (extension == L"avif") return L"image/avif";
    if (extension == L"gif")  return L"image/gif";
    if (extension == L"bmp")  return L"image/bmp";
    if (extension == L"heic") return L"image/heic";
    if (extension == L"heif") return L"image/heif";
    if (extension == L"tif" || extension == L"tiff") return L"image/tiff";
    return L"application/octet-stream";
}

[[nodiscard]] std::wstring VersionWide() {
    return ToWide(PS_VERSION_DOTTED);
}

// What the window and the interface call the app.  The version travels with the
// name, so a build in the hand and a build in the folder can be told apart;
// kAppName stays the bare name for messages that are about the program itself.
[[nodiscard]] std::wstring AppDisplayName() {
    return std::wstring(L"PepperStitch_v") + VersionWide();
}

// ---------------------------------------------------------------------------
//  Application state
// ---------------------------------------------------------------------------

struct App {
    HWND window = nullptr;
    ComPtr<ICoreWebView2Environment> environment;
    ComPtr<ICoreWebView2Controller> controller;
    ComPtr<ICoreWebView2> webview;

    std::wstring dataDirectory;   // %LOCALAPPDATA%\PepperStitch
    std::wstring assetsDirectory; // ...\assets
    std::wstring settingsDirectory;

    std::vector<std::wstring> pendingFiles;  // handed to the page once it is ready
    std::vector<std::wstring> fileTokens;    // https://file.local/<index>

    bool pageReady = false;
    bool darkTitleBar = true;
    std::wstring lastSaveDirectory;
};

App g_app;

// ---------------------------------------------------------------------------
//  Resources and unpacking
// ---------------------------------------------------------------------------

[[nodiscard]] bool WriteResourceToFile(int id, const std::wstring& path) {
    const HRSRC resource = ::FindResourceW(nullptr, MAKEINTRESOURCEW(id), RT_RCDATA);
    if (resource == nullptr) {
        return false;
    }
    const HGLOBAL loaded = ::LoadResource(nullptr, resource);
    if (loaded == nullptr) {
        return false;
    }
    const DWORD size = ::SizeofResource(nullptr, resource);
    const void* data = ::LockResource(loaded);
    if (data == nullptr) {
        return false;
    }
    return WriteAllBytes(path, data, size);
}

[[nodiscard]] bool UnpackFrontEnd(const std::wstring& root) {
    for (std::size_t i = 0; i < ps_assets::kEntryCount; ++i) {
        const ps_assets::Entry& entry = ps_assets::kEntries[i];
        std::wstring relative = entry.path;
        std::replace(relative.begin(), relative.end(), L'/', L'\\');
        const std::wstring target = JoinPath(root, relative);

        const std::wstring directory = DirectoryOf(target);
        if (!directory.empty() && !EnsureDirectory(directory)) {
            return false;
        }
        if (!WriteResourceToFile(entry.id, target)) {
            return false;
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
//  Window placement
// ---------------------------------------------------------------------------

[[nodiscard]] std::wstring SettingsFile() {
    return JoinPath(g_app.settingsDirectory, L"window.ini");
}

[[nodiscard]] int ReadSetting(const wchar_t* key, int fallback) {
    return static_cast<int>(::GetPrivateProfileIntW(kWindowKey, key, fallback, SettingsFile().c_str()));
}

void WriteSetting(const wchar_t* key, int value) {
    const std::wstring text = std::to_wstring(value);
    ::WritePrivateProfileStringW(kWindowKey, key, text.c_str(), SettingsFile().c_str());
}

void SaveWindowPlacement() {
    if (g_app.window == nullptr) {
        return;
    }
    WINDOWPLACEMENT placement{};
    placement.length = sizeof(placement);
    if (!::GetWindowPlacement(g_app.window, &placement)) {
        return;
    }
    const RECT& rect = placement.rcNormalPosition;
    WriteSetting(L"left", rect.left);
    WriteSetting(L"top", rect.top);
    WriteSetting(L"right", rect.right);
    WriteSetting(L"bottom", rect.bottom);
    WriteSetting(L"maximized", (placement.showCmd == SW_SHOWMAXIMIZED) ? 1 : 0);
}

void RestoreWindowPlacement(int& x, int& y, int& width, int& height, bool& maximized) {
    const int left = ReadSetting(L"left", 0);
    const int top = ReadSetting(L"top", 0);
    const int right = ReadSetting(L"right", 0);
    const int bottom = ReadSetting(L"bottom", 0);
    maximized = ReadSetting(L"maximized", 0) == 1;

    RECT candidate{left, top, right, bottom};
    if (right - left >= 400 && bottom - top >= 300) {
        const HMONITOR monitor = ::MonitorFromRect(&candidate, MONITOR_DEFAULTTONULL);
        if (monitor != nullptr) {
            x = candidate.left;
            y = candidate.top;
            width = candidate.right - candidate.left;
            height = candidate.bottom - candidate.top;
            return;
        }
    }

    RECT work{};
    ::SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
    width = std::max(kDefaultWidth, kMinWidth);
    height = std::max(kDefaultHeight, kMinHeight);
    x = work.left + ((work.right - work.left) - width) / 2;
    y = work.top + ((work.bottom - work.top) - height) / 2;
}

void ApplyTitleBarTheme(bool dark) {
    g_app.darkTitleBar = dark;
    if (g_app.window == nullptr) {
        return;
    }
    const BOOL value = dark ? TRUE : FALSE;
    // 20 is DWMWA_USE_IMMERSIVE_DARK_MODE on current Windows; 19 on older builds.
    if (FAILED(::DwmSetWindowAttribute(g_app.window, 20, &value, sizeof(value)))) {
        ::DwmSetWindowAttribute(g_app.window, 19, &value, sizeof(value));
    }
}

// ---------------------------------------------------------------------------
//  Web resource responses
// ---------------------------------------------------------------------------

[[nodiscard]] ComPtr<IStream> MemoryStream(const void* data, std::size_t size) {
    ComPtr<IStream> stream;
    if (size == 0) {
        return stream;
    }
    stream.Attach(::SHCreateMemStream(static_cast<const BYTE*>(data), static_cast<UINT>(size)));
    return stream;
}

// The page is served from app.local, while pictures, saving and window
// commands come from three other hosts.  Those are cross-origin fetches, so
// every response carries the CORS headers that let the page read it, and a
// preflight is answered without reaching the handler behind it.
constexpr wchar_t kCorsHeaders[] =
    L"\nAccess-Control-Allow-Origin: *"
    L"\nAccess-Control-Allow-Methods: GET, POST, OPTIONS"
    L"\nAccess-Control-Allow-Headers: *"
    L"\nAccess-Control-Max-Age: 600";

void Respond(ICoreWebView2WebResourceRequestedEventArgs* args, int status, const wchar_t* reason,
             const void* body, std::size_t size, const std::wstring& headers) {
    if (g_app.environment == nullptr) {
        return;
    }
    ComPtr<IStream> stream = MemoryStream(body, size);
    ComPtr<ICoreWebView2WebResourceResponse> response;
    const std::wstring allHeaders = headers + kCorsHeaders;
    if (SUCCEEDED(g_app.environment->CreateWebResourceResponse(
            stream.Get(), status, reason, allHeaders.c_str(), response.Put()))) {
        args->put_Response(response.Get());
    }
}

void RespondJson(ICoreWebView2WebResourceRequestedEventArgs* args, const std::string& json) {
    Respond(args, 200, L"OK", json.data(), json.size(),
            L"Content-Type: application/json; charset=utf-8\nCache-Control: no-store");
}

void RespondNoContent(ICoreWebView2WebResourceRequestedEventArgs* args) {
    Respond(args, 204, L"No Content", nullptr, 0, L"Cache-Control: no-store");
}

void RespondError(ICoreWebView2WebResourceRequestedEventArgs* args, int status,
                  const wchar_t* reason, const std::string& message) {
    Respond(args, status, reason, message.data(), message.size(),
            L"Content-Type: text/plain; charset=utf-8\nCache-Control: no-store");
}

[[nodiscard]] std::string ErrorJson(const std::string& message) {
    return "{\"ok\":false,\"error\":\"" + message + "\"}";
}

// ---------------------------------------------------------------------------
//  Talking to the page
// ---------------------------------------------------------------------------

void PostToPage(const std::string& json) {
    if (!g_app.webview) {
        return;
    }
    g_app.webview->PostWebMessageAsJson(ToWide(json).c_str());
}

void SendFilesToPage(const std::vector<std::wstring>& paths) {
    if (paths.empty()) {
        return;
    }
    if (!g_app.pageReady) {
        g_app.pendingFiles.insert(g_app.pendingFiles.end(), paths.begin(), paths.end());
        return;
    }

    std::string json = "{\"type\":\"files\",\"items\":[";
    bool first = true;
    for (const std::wstring& path : paths) {
        if (!FileExists(path)) {
            continue;
        }
        const std::size_t token = g_app.fileTokens.size();
        g_app.fileTokens.push_back(path);

        if (!first) {
            json += ',';
        }
        first = false;
        json += "{\"url\":\"https://";
        json += "file.local/";
        json += std::to_string(token);
        json += "\",\"name\":\"";
        json += JsonEscape(FileNameOf(path));
        json += "\",\"path\":\"";
        json += JsonEscape(path);
        json += "\"}";
    }
    json += "]}";
    if (first) {
        return;
    }
    PostToPage(json);
}

// ---------------------------------------------------------------------------
//  file.local - pictures the host was handed
// ---------------------------------------------------------------------------

void ServeFile(ICoreWebView2WebResourceRequestedEventArgs* args, const std::wstring& uri) {
    const std::wstring path = UriPath(uri);
    std::size_t index = 0;
    if (!path.empty() && path.size() > 1) {
        const std::wstring number = path.substr(1);
        wchar_t* end = nullptr;
        index = std::wcstoul(number.c_str(), &end, 10);
        if (end == number.c_str()) {
            RespondError(args, 400, L"Bad Request", "bad file token");
            return;
        }
    }
    if (index >= g_app.fileTokens.size()) {
        RespondError(args, 404, L"Not Found", "unknown file token");
        return;
    }

    const std::wstring& file = g_app.fileTokens[index];
    std::vector<std::uint8_t> bytes;
    if (!ReadAllBytes(file, bytes)) {
        RespondError(args, 404, L"Not Found", "the picture could not be read");
        return;
    }

    const std::wstring headers =
        std::wstring(L"Content-Type: ") + MimeForPath(file) + L"\nCache-Control: no-store";
    Respond(args, 200, L"OK", bytes.data(), bytes.size(), headers);
}

// ---------------------------------------------------------------------------
//  save.local - the Save dialog and the exported bytes
// ---------------------------------------------------------------------------

[[nodiscard]] bool ReadStream(IStream* stream, std::vector<char>& bytes) {
    if (stream == nullptr) {
        return false;
    }
    STATSTG stat{};
    ULONGLONG expected = 0;
    if (SUCCEEDED(stream->Stat(&stat, STATFLAG_NONAME))) {
        expected = stat.cbSize.QuadPart;
    }
    bytes.clear();
    if (expected > 0 && expected < (1ull << 31)) {
        bytes.reserve(static_cast<std::size_t>(expected));
    }

    char buffer[64 * 1024];
    for (;;) {
        ULONG read = 0;
        const HRESULT result = stream->Read(buffer, static_cast<ULONG>(sizeof(buffer)), &read);
        if (read > 0) {
            bytes.insert(bytes.end(), buffer, buffer + read);
        }
        if (result != S_OK || read == 0) {
            break;
        }
    }
    return !bytes.empty();
}

[[nodiscard]] const wchar_t* FilterFor(const std::wstring& extension) {
    if (extension == L"jpg" || extension == L"jpeg") {
        return L"JPEG image\0*.jpg;*.jpeg\0All files\0*.*\0\0";
    }
    if (extension == L"webp") {
        return L"WebP image\0*.webp\0All files\0*.*\0\0";
    }
    return L"PNG image\0*.png\0All files\0*.*\0\0";
}

// A Save dialog cannot be opened from inside a WebView2 resource callback: the
// callback runs on the window thread while the page sits waiting for the
// response, and the shell's file dialog stalls before it ever draws.  The
// request is deferred, a thread of its own runs the dialog, and the answer is
// posted back to the window, which completes the response.
constexpr UINT kSaveFinishedMessage = WM_APP + 1;

struct SaveJob {
    ICoreWebView2WebResourceRequestedEventArgs* args = nullptr;
    ICoreWebView2Deferral* deferral = nullptr;
    std::wstring extension;
    std::wstring suggested;
    std::wstring savedPath;   // empty when the dialog was cancelled or failed
    std::wstring error;       // empty on success or a plain cancellation
    std::vector<char> bytes;

    ~SaveJob() {
        if (deferral != nullptr) {
            deferral->Release();
        }
        if (args != nullptr) {
            args->Release();
        }
    }
};

DWORD WINAPI SaveDialogThread(void* parameter) {
    SaveJob* job = static_cast<SaveJob*>(parameter);
    // The shell dialog wants a single-threaded apartment of its own.
    const HRESULT com = ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);

    std::wstring seed;
    if (!g_app.lastSaveDirectory.empty()) {
        seed = JoinPath(g_app.lastSaveDirectory, job->suggested);
    } else {
        seed = job->suggested;
    }

    std::vector<wchar_t> buffer(1024, L'\0');
    std::wcsncpy(buffer.data(), seed.c_str(), buffer.size() - 1);

    OPENFILENAMEW dialog{};
    dialog.lStructSize = sizeof(dialog);
    dialog.hwndOwner = g_app.window;
    dialog.lpstrFilter = FilterFor(job->extension);
    dialog.lpstrFile = buffer.data();
    dialog.nMaxFile = static_cast<DWORD>(buffer.size());
    dialog.lpstrDefExt = job->extension.c_str();
    dialog.lpstrTitle = L"Save stitched image";
    dialog.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;

    if (!::GetSaveFileNameW(&dialog)) {
        if (::CommDlgExtendedError() != 0) {
            job->error = L"the save dialog could not be opened";
        }
    } else {
        const std::wstring target = buffer.data();
        if (WriteAllBytes(target, job->bytes.data(), job->bytes.size())) {
            job->savedPath = target;
        } else {
            job->error = L"the file could not be written";
        }
    }

    if (SUCCEEDED(com)) {
        ::CoUninitialize();
    }
    ::PostMessage(g_app.window, kSaveFinishedMessage, 0, reinterpret_cast<LPARAM>(job));
    return 0;
}

std::string SaveResultJson(const SaveJob& job) {
    if (!job.error.empty()) {
        return ErrorJson(ToUtf8(job.error));
    }
    if (job.savedPath.empty()) {
        return "{\"ok\":false,\"cancelled\":true}";
    }
    return "{\"ok\":true,\"path\":\"" + JsonEscape(job.savedPath) + "\"}";
}

void HandleSave(ICoreWebView2WebResourceRequestedEventArgs* args, const std::wstring& uri) {
    std::wstring extension = QueryValue(uri, L"ext");
    std::transform(extension.begin(), extension.end(), extension.begin(), towlower);
    if (extension != L"jpg" && extension != L"jpeg" && extension != L"webp") {
        extension = L"png";
    }

    std::wstring suggested = QueryValue(uri, L"name");
    suggested = FileNameOf(suggested);
    if (suggested.empty()) {
        suggested = L"stitch";
    }
    // GetSaveFileName needs the file name to carry the extension it expects.
    if (FileNameOf(suggested).find(L'.') == std::wstring::npos) {
        suggested += L"." + extension;
    }

    std::vector<char> bytes;
    ComPtr<ICoreWebView2WebResourceRequest> request;
    if (SUCCEEDED(args->get_Request(request.Put())) && request) {
        ComPtr<IStream> content;
        if (SUCCEEDED(request->get_Content(content.Put()))) {
            (void)ReadStream(content.Get(), bytes);
        }
    }
    if (bytes.empty()) {
        RespondJson(args, ErrorJson("no image data arrived"));
        return;
    }

    ComPtr<ICoreWebView2Deferral> deferral;
    if (FAILED(args->GetDeferral(deferral.Put())) || !deferral) {
        RespondJson(args, ErrorJson("the save dialog could not be opened"));
        return;
    }

    SaveJob* job = new SaveJob();
    job->args = args;
    args->AddRef();
    job->deferral = deferral.Get();
    deferral.Get()->AddRef();
    job->extension = extension;
    job->suggested = suggested;
    job->bytes = std::move(bytes);

    ::CloseHandle(::CreateThread(nullptr, 0, SaveDialogThread, job, 0, nullptr));
}

// ---------------------------------------------------------------------------
//  host.local - window commands
// ---------------------------------------------------------------------------

void HandleCommand(ICoreWebView2WebResourceRequestedEventArgs* args, const std::wstring& uri) {
    const std::wstring path = UriPath(uri);

    if (path == L"/ready") {
        g_app.pageReady = true;
        RespondNoContent(args);

        std::vector<std::wstring> pending;
        pending.swap(g_app.pendingFiles);
        if (!pending.empty()) {
            // Posted after the response, so the page's DOM is listening.
            SendFilesToPage(pending);
        }
        return;
    }

    if (path == L"/reveal") {
        const std::wstring target = QueryValue(uri, L"path");
        if (!target.empty() && FileExists(target)) {
            const std::wstring parameters = L"/select,\"" + target + L"\"";
            ::ShellExecuteW(nullptr, L"open", L"explorer.exe", parameters.c_str(), nullptr, SW_SHOWNORMAL);
        }
        RespondNoContent(args);
        return;
    }

    if (path == L"/devtools") {
        RespondNoContent(args);
        if (g_app.webview) {
            g_app.webview->OpenDevToolsWindow();
        }
        return;
    }

    if (path == L"/theme") {
        const bool dark = QueryValue(uri, L"dark") != L"0";
        RespondNoContent(args);
        ApplyTitleBarTheme(dark);
        if (g_app.controller) {
            ComPtr<ICoreWebView2Controller2> controller2;
            if (SUCCEEDED(g_app.controller->QueryInterface(
                    IID_ICoreWebView2Controller2, reinterpret_cast<void**>(controller2.Put()))) && controller2) {
                const COLORREF colour = dark ? kDarkBackground : kLightBackground;
                const COREWEBVIEW2_COLOR background{
                    255, GetRValue(colour), GetGValue(colour), GetBValue(colour)};
                controller2->put_DefaultBackgroundColor(background);
            }
        }
        return;
    }

    RespondError(args, 404, L"Not Found", "unknown command");
}

// ---------------------------------------------------------------------------
//  The WebView2 loader
//
//  WebView2Loader.dll is the one DLL this program needs.  It is compiled into
//  the executable and unpacked under %LOCALAPPDATA%\PepperStitch on first use,
//  then loaded by absolute path, so no DLL search order is involved and no
//  file has to sit beside the .exe.
// ---------------------------------------------------------------------------

using CreateEnvironmentWithOptionsFn = HRESULT(STDMETHODCALLTYPE*)(
    PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions*,
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler*);

CreateEnvironmentWithOptionsFn g_createEnvironment = nullptr;
HMODULE g_loaderModule = nullptr;

// FNV-1a over the embedded bytes: the unpacked DLL is only loaded when it is
// byte for byte what this executable carries, which repairs a truncated or
// half-written copy left by an interrupted run.
[[nodiscard]] unsigned long long HashBytes(const void* bytes, std::size_t size) {
    const auto* data = static_cast<const unsigned char*>(bytes);
    unsigned long long hash = 1469598103934665603ull;
    for (std::size_t index = 0; index < size; ++index) {
        hash ^= data[index];
        hash *= 1099511628211ull;
    }
    return hash;
}

[[nodiscard]] bool PrepareLoader() {
    if (g_createEnvironment != nullptr) {
        return true;
    }

    const HRSRC resource = ::FindResourceW(nullptr, MAKEINTRESOURCEW(IDR_WEBVIEW2_LOADER), RT_RCDATA);
    if (resource == nullptr) {
        return false;
    }
    const DWORD size = ::SizeofResource(nullptr, resource);
    const HGLOBAL loaded = ::LoadResource(nullptr, resource);
    const void* bytes = loaded != nullptr ? ::LockResource(loaded) : nullptr;
    if (bytes == nullptr || size == 0) {
        return false;
    }

    const std::wstring path = JoinPath(g_app.dataDirectory, L"WebView2Loader.dll");
    std::vector<std::uint8_t> existing;
    const bool current = ReadAllBytes(path, existing) && existing.size() == size &&
                         HashBytes(existing.data(), existing.size()) == HashBytes(bytes, size);
    if (!current && !WriteAllBytes(path, bytes, size)) {
        return false;
    }

    g_loaderModule = ::LoadLibraryW(path.c_str());
    if (g_loaderModule == nullptr) {
        return false;
    }
    const FARPROC address = ::GetProcAddress(g_loaderModule, "CreateCoreWebView2EnvironmentWithOptions");
    if (address == nullptr) {
        return false;
    }
    // Through void*: a direct FARPROC cast trips -Wcast-function-type although
    // the signature is the one the DLL exports.
    g_createEnvironment =
        reinterpret_cast<CreateEnvironmentWithOptionsFn>(reinterpret_cast<void*>(address));
    return g_createEnvironment != nullptr;
}

// ---------------------------------------------------------------------------
//  WebView2 plumbing
// ---------------------------------------------------------------------------

HRESULT HandleResourceRequest(ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) {
    ComPtr<ICoreWebView2WebResourceRequest> request;
    if (FAILED(args->get_Request(request.Put())) || !request) {
        return S_OK;
    }
    LPWSTR raw = nullptr;
    if (FAILED(request->get_Uri(&raw)) || raw == nullptr) {
        return S_OK;
    }
    const std::wstring uri = raw;
    ::CoTaskMemFree(raw);

    LPWSTR rawMethod = nullptr;
    std::wstring method = L"GET";
    if (SUCCEEDED(request->get_Method(&rawMethod)) && rawMethod != nullptr) {
        method = rawMethod;
        ::CoTaskMemFree(rawMethod);
    }
    if (method == L"OPTIONS") {
        // A cross-origin POST is preceded by a preflight; answering it here
        // keeps it away from HandleSave, which would open a file dialog.
        Respond(args, 204, L"No Content", nullptr, 0, L"Cache-Control: no-store");
        return S_OK;
    }
    const std::wstring host = UriHost(uri);
    if (host == kFileHost) {
        ServeFile(args, uri);
    } else if (host == kSaveHost) {
        if (UriPath(uri) == L"/save") {
            HandleSave(args, uri);
        } else {
            RespondError(args, 404, L"Not Found", "unknown save request");
        }
    } else if (host == kCommandHost) {
        HandleCommand(args, uri);
    }
    return S_OK;
}

class WebResourceRequestedHandler final
    : public ComHandler<WebResourceRequestedHandler, ICoreWebView2WebResourceRequestedEventHandler> {
public:
    static const IID& InterfaceId() noexcept { return IID_ICoreWebView2WebResourceRequestedEventHandler; }

    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2* webview,
                                     ICoreWebView2WebResourceRequestedEventArgs* args) noexcept override {
        return HandleResourceRequest(webview, args);
    }
};

class DocumentTitleChangedHandler final
    : public ComHandler<DocumentTitleChangedHandler, ICoreWebView2DocumentTitleChangedEventHandler> {
public:
    static const IID& InterfaceId() noexcept { return IID_ICoreWebView2DocumentTitleChangedEventHandler; }

    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2* sender, IUnknown*) noexcept override {
        LPWSTR raw = nullptr;
        if (SUCCEEDED(sender->get_DocumentTitle(&raw)) && raw != nullptr) {
            const std::wstring title = raw;
            ::CoTaskMemFree(raw);
            const std::wstring appName = AppDisplayName();
            // The page sets its own title to the same name, so that case is the
            // plain name rather than the name twice around a dash.
            const std::wstring windowTitle =
                title.empty() || title == appName ? appName : title + L" \u2014 " + appName;
            ::SetWindowTextW(g_app.window, windowTitle.c_str());
        }
        return S_OK;
    }
};

class NavigationCompletedHandler final
    : public ComHandler<NavigationCompletedHandler, ICoreWebView2NavigationCompletedEventHandler> {
public:
    static const IID& InterfaceId() noexcept { return IID_ICoreWebView2NavigationCompletedEventHandler; }

    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* args) noexcept override {
        BOOL success = FALSE;
        args->get_IsSuccess(&success);
        if (!success) {
            ::MessageBoxW(g_app.window,
                          L"The interface could not be loaded.\n\n"
                          L"Try running PepperStitch again, or delete\n"
                          L"%LOCALAPPDATA%\\PepperStitch\\assets and restart.",
                          kAppName, MB_ICONERROR | MB_OK);
        }
        return S_OK;
    }
};

class NewWindowRequestedHandler final
    : public ComHandler<NewWindowRequestedHandler, ICoreWebView2NewWindowRequestedEventHandler> {
public:
    static const IID& InterfaceId() noexcept { return IID_ICoreWebView2NewWindowRequestedEventHandler; }

    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) noexcept override {
        // Nothing in the interface opens a window; if something tries, hand the
        // address to the default browser instead.
        args->put_Handled(TRUE);
        LPWSTR raw = nullptr;
        if (SUCCEEDED(args->get_Uri(&raw)) && raw != nullptr) {
            const std::wstring target = raw;
            ::CoTaskMemFree(raw);
            if (target.rfind(L"https://", 0) == 0 || target.rfind(L"http://", 0) == 0) {
                ::ShellExecuteW(nullptr, L"open", target.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
            }
        }
        return S_OK;
    }
};

void SizeController() {
    if (!g_app.controller || g_app.window == nullptr) {
        return;
    }
    RECT bounds{};
    ::GetClientRect(g_app.window, &bounds);
    g_app.controller->put_Bounds(bounds);
}

HRESULT InitializePage(ICoreWebView2Controller* controller) {
    controller->AddRef();
    g_app.controller.Attach(controller);
    if (!g_app.controller) {
        return E_FAIL;
    }

    if (FAILED(controller->get_CoreWebView2(g_app.webview.Put())) || !g_app.webview) {
        return E_FAIL;
    }

    SizeController();

    ComPtr<ICoreWebView2Settings> settings;
    if (SUCCEEDED(g_app.webview->get_Settings(settings.Put())) && settings) {
        settings->put_AreDefaultContextMenusEnabled(FALSE);
        settings->put_AreDevToolsEnabled(TRUE);
        settings->put_IsStatusBarEnabled(FALSE);
        settings->put_IsZoomControlEnabled(FALSE);
        settings->put_IsBuiltInErrorPageEnabled(TRUE);

        ComPtr<ICoreWebView2Settings3> settings3;
        if (SUCCEEDED(settings->QueryInterface(
                IID_ICoreWebView2Settings3, reinterpret_cast<void**>(settings3.Put()))) && settings3) {
            // F5 and Ctrl+P are not useful here; the page handles its own keys.
            settings3->put_AreBrowserAcceleratorKeysEnabled(FALSE);
        }
    }

    if (FAILED(controller->put_IsVisible(TRUE))) {
        return E_FAIL;
    }

    ComPtr<ICoreWebView2Controller2> controller2;
    if (SUCCEEDED(controller->QueryInterface(
            IID_ICoreWebView2Controller2, reinterpret_cast<void**>(controller2.Put()))) && controller2) {
        const COREWEBVIEW2_COLOR background{
            255, GetRValue(kDarkBackground), GetGValue(kDarkBackground), GetBValue(kDarkBackground)};
        controller2->put_DefaultBackgroundColor(background);
    }

    ComPtr<ICoreWebView2Controller4> controller4;
    if (SUCCEEDED(controller->QueryInterface(
            IID_ICoreWebView2Controller4, reinterpret_cast<void**>(controller4.Put()))) && controller4) {
        // Dropping a file on the window becomes a normal HTML5 drop in the page.
        controller4->put_AllowExternalDrop(TRUE);
    } else {
        ::DragAcceptFiles(g_app.window, TRUE);
    }

    ComPtr<ICoreWebView2_3> webview3;
    if (SUCCEEDED(g_app.webview->QueryInterface(
            IID_ICoreWebView2_3, reinterpret_cast<void**>(webview3.Put()))) && webview3) {
        const HRESULT result = webview3->SetVirtualHostNameToFolderMapping(
            kAppHost, g_app.assetsDirectory.c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
        if (FAILED(result)) {
            return result;
        }
    } else {
        return E_FAIL;
    }

    EventRegistrationToken resourceToken{};
    auto* resourceHandler = new WebResourceRequestedHandler();
    if (FAILED(g_app.webview->add_WebResourceRequested(resourceHandler, &resourceToken))) {
        resourceHandler->Release();
        return E_FAIL;
    }
    resourceHandler->Release();

    const wchar_t* filters[] = {L"https://file.local/*", L"https://save.local/*", L"https://host.local/*"};
    for (const wchar_t* filter : filters) {
        g_app.webview->AddWebResourceRequestedFilter(filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
    }

    EventRegistrationToken titleToken{};
    auto* titleHandler = new DocumentTitleChangedHandler();
    const bool titleHooked = SUCCEEDED(g_app.webview->add_DocumentTitleChanged(titleHandler, &titleToken));
    titleHandler->Release();
    if (!titleHooked) {
        return E_FAIL;
    }

    EventRegistrationToken navigationToken{};
    auto* navigationHandler = new NavigationCompletedHandler();
    const bool navigationHooked = SUCCEEDED(g_app.webview->add_NavigationCompleted(navigationHandler, &navigationToken));
    navigationHandler->Release();
    if (!navigationHooked) {
        return E_FAIL;
    }

    auto* windowHandler = new NewWindowRequestedHandler();
    const bool windowHooked = SUCCEEDED(g_app.webview->add_NewWindowRequested(windowHandler, nullptr));
    windowHandler->Release();
    if (!windowHooked) {
        return E_FAIL;
    }

    std::wstring startUrl = std::wstring(L"https://") + kAppHost + kStartPath;
    startUrl += L"?v=";
    startUrl += VersionWide();

    if (FAILED(g_app.webview->Navigate(startUrl.c_str()))) {
        return E_FAIL;
    }
    return S_OK;
}

void ReportWebViewFailure(HRESULT result, const wchar_t* stage) {
    wchar_t message[1024] = {};
    std::swprintf(message, 1024,
                  L"PepperStitch could not start its interface (%s, 0x%08lX).\n\n"
                  L"PepperStitch needs the Microsoft Edge WebView2 Runtime, which ships\n"
                  L"with Windows 11 and current Windows 10 installations. It can be\n"
                  L"installed from:\n\n"
                  L"    https://go.microsoft.com/fwlink/p/?LinkId=2124703",
                  stage, static_cast<unsigned long>(result));
    ::MessageBoxW(g_app.window, message, kAppName, MB_ICONERROR | MB_OK);
}

class EnvironmentCompletedHandler final
    : public ComHandler<EnvironmentCompletedHandler, ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler> {
public:
    static const IID& InterfaceId() noexcept {
        return IID_ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler;
    }

    HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Environment* environment) noexcept override {
        if (FAILED(result) || environment == nullptr) {
            ReportWebViewFailure(result, L"environment");
            return S_OK;
        }
        environment->AddRef();
        g_app.environment.Attach(environment);
        g_app.environment->CreateCoreWebView2Controller(g_app.window, new ControllerCompletedHandler());
        return S_OK;
    }

private:
    class ControllerCompletedHandler final
        : public ComHandler<ControllerCompletedHandler, ICoreWebView2CreateCoreWebView2ControllerCompletedHandler> {
    public:
        static const IID& InterfaceId() noexcept {
            return IID_ICoreWebView2CreateCoreWebView2ControllerCompletedHandler;
        }

        HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Controller* controller) noexcept override {
            if (FAILED(result) || controller == nullptr) {
                ReportWebViewFailure(result, L"controller");
                return S_OK;
            }
            if (FAILED(InitializePage(controller))) {
                ReportWebViewFailure(E_FAIL, L"page");
            }
            return S_OK;
        }
    };
};

void CreateWebView() {
    ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    const std::wstring userData = JoinPath(g_app.dataDirectory, L"WebView2");
    (void)EnsureDirectory(userData);

    if (!PrepareLoader()) {
        ReportWebViewFailure(HRESULT_FROM_WIN32(ERROR_MOD_NOT_FOUND), L"loader");
        return;
    }

    const HRESULT started = g_createEnvironment(
        nullptr, userData.c_str(), nullptr, new EnvironmentCompletedHandler());

    if (FAILED(started)) {
        ReportWebViewFailure(started, L"startup");
    }
}

// ---------------------------------------------------------------------------
//  Window procedure
// ---------------------------------------------------------------------------

LRESULT CALLBACK WindowProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
    case WM_CREATE:
        g_app.window = window;
        ApplyTitleBarTheme(true);
        CreateWebView();
        return 0;

    case WM_SIZE:
        SizeController();
        return 0;

    case WM_GETMINMAXINFO: {
        auto* info = reinterpret_cast<MINMAXINFO*>(lParam);
        info->ptMinTrackSize.x = kMinWidth;
        info->ptMinTrackSize.y = kMinHeight;
        return 0;
    }

    case WM_DROPFILES: {
        // Only reached for drops on the window frame, or when the page-level
        // drop is unavailable (older WebView2). The page handles content drops.
        auto drop = reinterpret_cast<HDROP>(wParam);
        const UINT count = ::DragQueryFileW(drop, 0xFFFFFFFF, nullptr, 0);
        std::vector<std::wstring> paths;
        paths.reserve(count);
        for (UINT i = 0; i < count; ++i) {
            const UINT length = ::DragQueryFileW(drop, i, nullptr, 0);
            if (length == 0) {
                continue;
            }
            std::wstring path(length + 1, L'\0');
            ::DragQueryFileW(drop, i, path.data(), static_cast<UINT>(path.size()));
            path.resize(length);
            paths.push_back(path);
        }
        ::DragFinish(drop);
        SendFilesToPage(paths);
        ::SetForegroundWindow(window);
        return 0;
    }

    case kSaveFinishedMessage: {
        // The Save dialog has closed on its own thread; the response the page is
        // waiting for is completed here, on the window thread.
        SaveJob* job = reinterpret_cast<SaveJob*>(lParam);
        if (job != nullptr) {
            if (!job->savedPath.empty()) {
                g_app.lastSaveDirectory = DirectoryOf(job->savedPath);
            }
            RespondJson(job->args, SaveResultJson(*job));
            if (job->deferral != nullptr) {
                job->deferral->Complete();
            }
            delete job;
        }
        return 0;
    }

    case WM_CLOSE:
        SaveWindowPlacement();        if (g_app.controller != nullptr) {
            g_app.controller->Close();
            g_app.controller.Reset();
            g_app.webview.Reset();
            g_app.environment.Reset();
        }
        ::DestroyWindow(window);
        return 0;

    case WM_DESTROY:
        ::PostQuitMessage(0);
        return 0;

    default:
        return ::DefWindowProcW(window, message, wParam, lParam);
    }
}

// ---------------------------------------------------------------------------
//  Entry point
// ---------------------------------------------------------------------------

void EnableDpiAwareness() {
    // Per-monitor v2 first; the fallbacks cover Windows versions before 1703.
    if (::SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
        return;
    }
    if (::SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE)) {
        return;
    }
    ::SetProcessDPIAware();
}

[[nodiscard]] std::vector<std::wstring> FilesFromCommandLine() {
    std::vector<std::wstring> files;
    int count = 0;
    LPWSTR* arguments = ::CommandLineToArgvW(::GetCommandLineW(), &count);
    if (arguments == nullptr) {
        return files;
    }
    for (int i = 1; i < count; ++i) {
        const std::wstring argument = arguments[i];
        if (!argument.empty() && argument[0] != L'-' && FileExists(argument)) {
            files.push_back(argument);
        }
    }
    ::LocalFree(arguments);
    return files;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, LPWSTR, int showCommand) {
    (void)showCommand;
    EnableDpiAwareness();

    const std::wstring localAppData = EnvironmentVariable(L"LOCALAPPDATA");
    g_app.dataDirectory = localAppData.empty()
                              ? JoinPath(EnvironmentVariable(L"USERPROFILE"), L"PepperStitch")
                              : JoinPath(localAppData, L"PepperStitch");
    g_app.assetsDirectory = JoinPath(g_app.dataDirectory, L"assets");
    g_app.settingsDirectory = g_app.dataDirectory;

    if (!EnsureDirectory(g_app.dataDirectory) || !EnsureDirectory(g_app.assetsDirectory)) {
        ::MessageBoxW(nullptr,
                      L"PepperStitch could not create its settings folder under\n"
                      L"%LOCALAPPDATA%\\PepperStitch.",
                      kAppName, MB_ICONERROR | MB_OK);
        return 1;
    }

    if (!UnpackFrontEnd(g_app.assetsDirectory)) {
        ::MessageBoxW(nullptr,
                      L"The PepperStitch interface could not be unpacked. The executable\n"
                      L"may be damaged, or the settings folder may be read-only.",
                      kAppName, MB_ICONERROR | MB_OK);
        return 1;
    }

    g_app.pendingFiles = FilesFromCommandLine();

    const HICON icon = static_cast<HICON>(
        ::LoadImageW(instance, MAKEINTRESOURCEW(IDI_APPICON), IMAGE_ICON, 0, 0, LR_DEFAULTSIZE));

    WNDCLASSEXW windowClass{};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.style = CS_HREDRAW | CS_VREDRAW;
    windowClass.lpfnWndProc = WindowProcedure;
    windowClass.hInstance = instance;
    windowClass.hIcon = icon;
    windowClass.hIconSm = icon;
    windowClass.hCursor = ::LoadCursorW(nullptr, IDC_ARROW);
    windowClass.lpszClassName = L"PepperStitchWindow";
    ::RegisterClassExW(&windowClass);

    int x = 0;
    int y = 0;
    int width = kDefaultWidth;
    int height = kDefaultHeight;
    bool maximized = false;
    RestoreWindowPlacement(x, y, width, height, maximized);

    const std::wstring appName = AppDisplayName();
    const HWND window = ::CreateWindowExW(0, windowClass.lpszClassName, appName.c_str(),
                                          WS_OVERLAPPEDWINDOW, x, y, width, height,
                                          nullptr, nullptr, instance, nullptr);
    if (window == nullptr) {
        ::MessageBoxW(nullptr, L"PepperStitch could not open its window.", kAppName,
                      MB_ICONERROR | MB_OK);
        return 1;
    }

    ::ShowWindow(window, maximized ? SW_SHOWMAXIMIZED : SW_SHOWNORMAL);
    ::UpdateWindow(window);

    MSG message{};
    while (::GetMessageW(&message, nullptr, 0, 0) > 0) {
        ::TranslateMessage(&message);
        ::DispatchMessageW(&message);
    }
    return static_cast<int>(message.wParam);
}
