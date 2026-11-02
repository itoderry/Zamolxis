// Butler (WebView2 edition) - native C++ core + modern HTML/CSS UI.
//
// Native scan/catalog/install engine (no .NET, no runtime) with the UI rendered
// in an embedded WebView2 control. Single self-contained exe (static WebView2
// loader + static CRT); the WebView2 runtime ships in Windows 11.
//
// Build: build_app.bat (MSVC). Run: Butler.exe
// CLI:   --export [file] [--check] [--skipwu]    headless report
//        --auto                                  elevated auto-update run
//        --resume                                continue after a reboot

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#define INITGUID

#include <windows.h>
#include <setupapi.h>
#include <newdev.h>
#include <cfgmgr32.h>
#include <initguid.h>
#include <devpkey.h>
#include <wuapi.h>
#include <objbase.h>
#include <shellapi.h>
#include <shlobj.h>
#include <knownfolders.h>
#include <winhttp.h>
#include <srrestoreptapi.h>
#include <dwmapi.h>
#include <gdiplus.h>
#include <msi.h>
#include <wincodec.h>
#undef INITGUID  // DEVPKEY/FOLDERID GUIDs already allocated above; networking headers
                 // re-include devpkey.h, which must now be extern-only (no re-definition)
#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#include <icmpapi.h>
#include <winevt.h>
#include <wbemidl.h>
#include <comdef.h>
#include <psapi.h>
#include <powrprof.h>
#include <wlanapi.h>
#include <bcrypt.h>
#include <wintrust.h>
#include <softpub.h>
#include <lm.h>
#include <thread>
#include <mutex>
#include <wrl.h>
#include "WebView2.h"

#define APP_NAME L"Butler"
#define APP_TAGLINE L"system concierge"
// Version = major.minor.build (build is min 3 digits, auto-incremented by build_app.bat
// via /DAPP_VERSTR). Display adds the " Beta" stage suffix.
#ifndef APP_VERSTR
#define APP_VERSTR L"0.1.000"
#endif
#define APP_VERSION APP_VERSTR L" Beta"
#define IDI_BUTLER 1
#define IDR_UIHTML 101
#define IDR_OUIDB 102

#include <cwctype>
#include <regex>
#include <set>
#include <map>
#include <unordered_map>
#include <vector>
#include <string>
#include <algorithm>

#pragma comment(lib, "setupapi.lib")
#pragma comment(lib, "newdev.lib")
#pragma comment(lib, "cfgmgr32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "msi.lib")
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "version.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "iphlpapi.lib")
#pragma comment(lib, "wevtapi.lib")
#pragma comment(lib, "wbemuuid.lib")
#pragma comment(lib, "psapi.lib")
#pragma comment(lib, "wlanapi.lib")
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "wintrust.lib")
#pragma comment(lib, "netapi32.lib")
#pragma comment(lib, "WebView2LoaderStatic.lib")

using namespace Microsoft::WRL;

// ===========================================================================
// Data model
// ===========================================================================
struct DriverInfo {
    std::wstring device, devClass, version, date, provider, vendor, source, sourceUrl, flag;
    std::wstring hwKey, latest, latestDate, verdict, checkedVia, updateId, catalogUrl, hwId;
    int  ageDays = -1;
    bool isMicrosoft = false;
    bool stale = false;
    bool missing = false;   // device present but has no driver installed (Code 28/etc.)
};
struct ProblemDevice {
    std::wstring device, devClass, problemText, vendor, source, sourceUrl;
    int problemCode = 0;
};
struct SourceGroup { std::wstring tool, url; int count = 0; };
struct ScanResult {
    std::wstring model, bios, biosDate, os, scanned, oemTool, oemUrl;
    std::vector<DriverInfo>    drivers;
    std::vector<ProblemDevice> problems;
    std::vector<std::wstring>  wuOffered;
    std::wstring               wuStatus = L"skipped";
    std::vector<SourceGroup>   sources;
    int thirdPartyCount = 0;
};

static int g_staleMonths = 18;

// ===========================================================================
// Vendor + source maps
// ===========================================================================
static std::wstring VendorFromId(const std::wstring& id4) {
    static const std::map<std::wstring, std::wstring> m = {
        {L"8086",L"Intel"},{L"8087",L"Intel"},{L"10DE",L"NVIDIA"},
        {L"1002",L"AMD"},{L"1022",L"AMD"},{L"10EC",L"Realtek"},{L"0BDA",L"Realtek"},
        {L"14E4",L"Broadcom"},{L"168C",L"Qualcomm Atheros"},{L"1969",L"Qualcomm Atheros"},
        {L"17CB",L"Qualcomm"},{L"14C3",L"MediaTek"},{L"04F3",L"ELAN"},
        {L"06CB",L"Synaptics"},{L"27C6",L"Goodix"},{L"1B21",L"ASMedia"},
    };
    auto it = m.find(id4);
    return it == m.end() ? L"" : it->second;
}
struct Src { std::wstring tool, url; };
static bool VendorSource(const std::wstring& vendor, Src& out) {
    static const std::map<std::wstring, Src> m = {
        {L"Intel",  {L"Intel Driver and Support Assistant (auto-detect)", L"https://www.intel.com/content/www/us/en/support/detect.html"}},
        {L"NVIDIA", {L"NVIDIA App / GeForce drivers", L"https://www.nvidia.com/en-us/geforce/drivers/"}},
        {L"AMD",    {L"AMD Auto-Detect / Adrenalin", L"https://www.amd.com/en/support"}},
        {L"Realtek",{L"OEM support site (Realtek via system vendor)", L"https://www.realtek.com/Download"}},
        {L"Microsoft",{L"Windows Update", L"ms-settings:windowsupdate"}},
    };
    auto it = m.find(vendor);
    if (it == m.end()) return false;
    out = it->second; return true;
}
static bool OemSource(const std::wstring& manufacturer, Src& out) {
    struct E { const wchar_t* key; const wchar_t* tool; const wchar_t* url; };
    static const E e[] = {
        {L"ASUS",    L"MyASUS / Armoury Crate (Live Update)", L"https://www.asus.com/support/"},
        {L"ASUSTeK", L"MyASUS / Armoury Crate (Live Update)", L"https://www.asus.com/support/"},
        {L"Dell",    L"Dell SupportAssist", L"https://www.dell.com/support/home"},
        {L"HP",      L"HP Support Assistant", L"https://support.hp.com/us-en/drivers"},
        {L"Hewlett", L"HP Support Assistant", L"https://support.hp.com/us-en/drivers"},
        {L"Lenovo",  L"Lenovo Vantage / System Update", L"https://support.lenovo.com"},
    };
    for (const auto& x : e)
        if (manufacturer.find(x.key) != std::wstring::npos) { out = {x.tool, x.url}; return true; }
    return false;
}
static void ResolveSource(const std::wstring& vendorId, const std::wstring& mfg,
                          const std::wstring& oem, std::wstring& vendorOut,
                          std::wstring& toolOut, std::wstring& urlOut) {
    std::wstring vendor = VendorFromId(vendorId);
    if (vendor.empty() && (mfg.find(L"Microsoft") != std::wstring::npos ||
                           mfg.find(L"Standard") != std::wstring::npos))
        vendor = L"Microsoft";
    Src s;
    if (!vendor.empty() && VendorSource(vendor, s) && !s.url.empty()) {
        vendorOut = vendor; toolOut = s.tool; urlOut = s.url; return;
    }
    Src o;
    if (OemSource(oem, o)) {
        vendorOut = vendor.empty() ? L"Unknown" : vendor; toolOut = o.tool; urlOut = o.url; return;
    }
    vendorOut = vendor.empty() ? L"Unknown" : vendor;
    toolOut = L"System OEM support site / Windows Update"; urlOut = L"";
}

// ===========================================================================
// Helpers
// ===========================================================================
static std::wstring RegStr(HKEY root, const wchar_t* sub, const wchar_t* val) {
    wchar_t buf[512]; DWORD cb = sizeof(buf);
    if (RegGetValueW(root, sub, val, RRF_RT_REG_SZ, nullptr, buf, &cb) == ERROR_SUCCESS) return buf;
    return L"";
}
static std::wstring Trim(const std::wstring& s) {
    size_t a = s.find_first_not_of(L" \t\r\n\xA0");
    size_t b = s.find_last_not_of(L" \t\r\n\xA0");
    return a == std::wstring::npos ? L"" : s.substr(a, b - a + 1);
}
static std::wstring NormalizeBiosDate(const std::wstring& s) {
    int mm, dd, yy;
    if (swscanf_s(s.c_str(), L"%d/%d/%d", &mm, &dd, &yy) == 3) {
        wchar_t b[16]; swprintf_s(b, L"%04d-%02d-%02d", yy, mm, dd); return b;
    }
    return s;
}
static std::wstring GetDevString(HDEVINFO h, SP_DEVINFO_DATA* d, const DEVPROPKEY* key) {
    DEVPROPTYPE type = 0; DWORD req = 0;
    SetupDiGetDevicePropertyW(h, d, key, &type, nullptr, 0, &req, 0);
    if (req == 0) return L"";
    std::vector<BYTE> buf(req);
    if (!SetupDiGetDevicePropertyW(h, d, key, &type, buf.data(), req, &req, 0)) return L"";
    return std::wstring(reinterpret_cast<wchar_t*>(buf.data()));
}
static std::wstring GetHardwareIds(HDEVINFO h, SP_DEVINFO_DATA* d) {
    DEVPROPTYPE type = 0; DWORD req = 0;
    SetupDiGetDevicePropertyW(h, d, &DEVPKEY_Device_HardwareIds, &type, nullptr, 0, &req, 0);
    if (req == 0) return L"";
    std::vector<BYTE> buf(req);
    if (!SetupDiGetDevicePropertyW(h, d, &DEVPKEY_Device_HardwareIds, &type, buf.data(), req, &req, 0)) return L"";
    std::wstring all; const wchar_t* p = reinterpret_cast<wchar_t*>(buf.data());
    while (*p) { all += p; all += L";"; p += wcslen(p) + 1; }
    return all;
}
static std::wstring ParseVendorId(const std::wstring& ids) {
    std::wstring up = ids; std::transform(up.begin(), up.end(), up.begin(), towupper);
    for (const wchar_t* tag : {L"VEN_", L"VID_"}) {
        size_t pos = up.find(tag);
        if (pos != std::wstring::npos && pos + 8 <= up.size()) {
            std::wstring v = up.substr(pos + 4, 4);
            if (v.size() == 4 && std::all_of(v.begin(), v.end(), [](wchar_t c) { return iswxdigit(c); })) return v;
        }
    }
    return L"";
}
static std::wstring ParseHwKey(const std::wstring& ids) {
    std::wstring up = ids; std::transform(up.begin(), up.end(), up.begin(), towupper);
    auto hex4 = [&](size_t pos) {
        if (pos == std::wstring::npos || pos + 8 > up.size()) return false;
        for (size_t i = pos + 4; i < pos + 8; ++i) if (!iswxdigit(up[i])) return false;
        return true;
    };
    size_t v = up.find(L"VEN_"), d = up.find(L"DEV_");
    if (hex4(v) && hex4(d)) return up.substr(v, 8) + L"&" + up.substr(d, 8);
    size_t vi = up.find(L"VID_"), pi = up.find(L"PID_");
    if (hex4(vi) && hex4(pi)) return up.substr(vi, 8) + L"&" + up.substr(pi, 8);
    return L"";
}
static std::wstring ProblemText(int code) {
    switch (code) {
        case 1: return L"Not configured correctly"; case 3: return L"Driver may be corrupted";
        case 10: return L"Cannot start"; case 12: return L"Insufficient resources";
        case 14: return L"Needs a restart"; case 18: return L"Reinstall the drivers";
        case 19: return L"Registry config corrupted"; case 22: return L"Disabled";
        case 24: return L"Not present / not working"; case 28: return L"Drivers not installed";
        case 31: return L"Driver not loaded"; case 37: return L"DriverEntry failed";
        case 39: return L"Driver missing/corrupt"; case 43: return L"Reported a problem (Code 43)";
        case 45: return L"Device not connected"; case 52: return L"Signature not verified";
        default: { wchar_t b[64]; swprintf_s(b, L"Problem code %d", code); return b; }
    }
}
static void FileTimeToDate(const FILETIME& ft, std::wstring& dateOut, int& ageDaysOut) {
    dateOut = L""; ageDaysOut = -1;
    if (ft.dwLowDateTime == 0 && ft.dwHighDateTime == 0) return;
    SYSTEMTIME st; if (!FileTimeToSystemTime(&ft, &st)) return;
    if (st.wYear < 2000) return;
    wchar_t b[16]; swprintf_s(b, L"%04d-%02d-%02d", st.wYear, st.wMonth, st.wDay); dateOut = b;
    FILETIME now; GetSystemTimeAsFileTime(&now);
    ULARGE_INTEGER a, n; a.LowPart = ft.dwLowDateTime; a.HighPart = ft.dwHighDateTime;
    n.LowPart = now.dwLowDateTime; n.HighPart = now.dwHighDateTime;
    if (n.QuadPart > a.QuadPart) ageDaysOut = (int)((n.QuadPart - a.QuadPart) / 10000000ULL / 86400ULL);
}
static bool VersionLooksInbox(const std::wstring& v) {
    int a, b, c, d;
    if (swscanf_s(v.c_str(), L"%d.%d.%d.%d", &a, &b, &c, &d) == 4)
        return a == 10 && b == 0 && c >= 10000 && c <= 99999;
    return false;
}
static std::vector<int> ParseVer(const std::wstring& v) {
    std::vector<int> p; const wchar_t* s = v.c_str();
    while (*s && p.size() < 4) {
        if (iswdigit(*s)) { int a = 0; while (iswdigit(*s)) { a = a * 10 + (*s - L'0'); s++; } p.push_back(a); }
        else s++;
    }
    return p;
}
static int CmpVer(const std::wstring& a, const std::wstring& b) {
    auto pa = ParseVer(a), pb = ParseVer(b);
    for (size_t i = 0; i < 4; ++i) { int x = i < pa.size() ? pa[i] : 0, y = i < pb.size() ? pb[i] : 0; if (x != y) return x < y ? -1 : 1; }
    return 0;
}
static std::string UrlEncodeW(const std::wstring& w) {
    int len = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, nullptr, 0, nullptr, nullptr);
    std::string s(len > 0 ? len - 1 : 0, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, s.data(), len, nullptr, nullptr);
    std::string o;
    for (unsigned char c : s) {
        if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') o += (char)c;
        else { char b[4]; sprintf_s(b, "%%%02X", c); o += b; }
    }
    return o;
}
static std::wstring CatalogUrlFor(const std::wstring& hwKey) {
    if (hwKey.empty()) return L"";
    std::string e = UrlEncodeW(hwKey);
    return L"https://www.catalog.update.microsoft.com/Search.aspx?q=" + std::wstring(e.begin(), e.end());
}

// ===========================================================================
// HTTP (WinHTTP) - GET and POST
// ===========================================================================
static bool HttpRequest(const wchar_t* verb, const std::wstring& url,
                        const std::string& body, const wchar_t* headers, std::string& out) {
    out.clear();
    URL_COMPONENTS uc{}; uc.dwStructSize = sizeof(uc);
    wchar_t host[256] = L"", path[2048] = L"";
    uc.lpszHostName = host; uc.dwHostNameLength = 255;
    uc.lpszUrlPath = path; uc.dwUrlPathLength = 2047;
    if (!WinHttpCrackUrl(url.c_str(), 0, 0, &uc)) return false;
    bool https = uc.nScheme == INTERNET_SCHEME_HTTPS;
    INTERNET_PORT port = uc.nPort ? uc.nPort : (https ? INTERNET_DEFAULT_HTTPS_PORT : INTERNET_DEFAULT_HTTP_PORT);

    HINTERNET hs = WinHttpOpen(L"Butler/3.0", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                               WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hs) return false;
    WinHttpSetTimeouts(hs, 20000, 20000, 30000, 120000);
    bool ok = false;
    if (HINTERNET hc = WinHttpConnect(hs, host, port, 0)) {
        DWORD flags = https ? WINHTTP_FLAG_SECURE : 0;
        if (HINTERNET hr = WinHttpOpenRequest(hc, verb, path, nullptr, WINHTTP_NO_REFERER,
                                              WINHTTP_DEFAULT_ACCEPT_TYPES, flags)) {
            const wchar_t* hdr = headers ? headers : WINHTTP_NO_ADDITIONAL_HEADERS;
            DWORD hlen = headers ? (DWORD)-1L : 0;
            if (WinHttpSendRequest(hr, hdr, hlen, body.empty() ? WINHTTP_NO_REQUEST_DATA : (LPVOID)body.data(),
                                   (DWORD)body.size(), (DWORD)body.size(), 0) &&
                WinHttpReceiveResponse(hr, nullptr)) {
                DWORD avail = 0;
                do {
                    if (!WinHttpQueryDataAvailable(hr, &avail) || avail == 0) break;
                    std::string buf(avail, '\0'); DWORD read = 0;
                    if (!WinHttpReadData(hr, buf.data(), avail, &read)) break;
                    buf.resize(read); out += buf;
                } while (avail > 0);
                ok = true;
            }
            WinHttpCloseHandle(hr);
        }
        WinHttpCloseHandle(hc);
    }
    WinHttpCloseHandle(hs);
    return ok;
}
static std::wstring Utf8ToW(const std::string& s) {
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring w(n, L'\0'); MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), w.data(), n);
    return w;
}
static std::wstring StripTags(const std::wstring& s) {
    static const std::wregex tag(L"<[^>]*>");
    return Trim(std::regex_replace(s, tag, L" "));
}

// Catalog search -> highest version + its date + updateId (for download).
static bool CatalogLatest(const std::wstring& hwKey, std::wstring& latestVer,
                          std::wstring& latestDate, std::wstring& updateId) {
    latestVer.clear(); latestDate.clear(); updateId.clear();
    std::string raw;
    if (!HttpRequest(L"GET", CatalogUrlFor(hwKey), "", nullptr, raw)) return false;
    std::wstring html = Utf8ToW(raw);
    if (html.find(L"updateMatches") == std::wstring::npos) return false;

    static const std::wregex rowRe(L"<tr[^>]*>([\\s\\S]*?)</tr>");
    static const std::wregex cellRe(L"<td[^>]*>([\\s\\S]*?)</td>");
    static const std::wregex verRe(L"^\\d+(\\.\\d+){1,3}$");
    static const std::wregex dateRe(L"^\\d{1,2}/\\d{1,2}/\\d{4}$");
    static const std::wregex guidRe(L"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
    bool found = false;
    for (std::wsregex_iterator it(html.begin(), html.end(), rowRe), end; it != end; ++it) {
        std::wstring row = (*it)[1].str(), rowVer, rowDate;
        for (std::wsregex_iterator ci(row.begin(), row.end(), cellRe), cend; ci != cend; ++ci) {
            std::wstring cell = StripTags((*ci)[1].str());
            if (rowVer.empty() && std::regex_match(cell, verRe)) rowVer = cell;
            else if (rowDate.empty() && std::regex_match(cell, dateRe)) {
                int mo, dy, yr;
                if (swscanf_s(cell.c_str(), L"%d/%d/%d", &mo, &dy, &yr) == 3 && yr >= 2000) rowDate = cell;
            }
        }
        if (!rowVer.empty() && (!found || CmpVer(rowVer, latestVer) > 0)) {
            latestVer = rowVer; latestDate = rowDate; found = true;
            std::wsmatch gm;  // best-effort updateId (GUID anywhere in the row) for downloads
            updateId = std::regex_search(row, gm, guidRe) ? gm[0].str() : L"";
        }
    }
    return found;
}

// Resolve the actual downloadable file URL for a catalog updateId.
static bool ResolveDownloadUrl(const std::wstring& updateId, std::wstring& fileUrl) {
    fileUrl.clear();
    if (updateId.empty()) return false;
    std::wstring json = L"[{\"size\":0,\"languages\":\"\",\"uidInfo\":\"" + updateId + L"\",\"updateID\":\"" + updateId + L"\"}]";
    std::string body = "updateIDs=" + UrlEncodeW(json);
    std::string resp;
    const wchar_t* hdr = L"Content-Type: application/x-www-form-urlencoded\r\n";
    if (!HttpRequest(L"POST", L"https://www.catalog.update.microsoft.com/DownloadDialog.aspx",
                     body, hdr, resp)) return false;
    std::wstring w = Utf8ToW(resp);
    static const std::wregex urlRe(L"'(https?://[^']+\\.(?:cab|exe|msi|msu|zip))'");
    std::wsmatch m;
    if (std::regex_search(w, m, urlRe)) { fileUrl = m[1].str(); return true; }
    return false;
}

// ===========================================================================
// System identity + device enumeration + Windows Update
// ===========================================================================
static void ReadSystemInfo(ScanResult& r) {
    const wchar_t* bios = L"HARDWARE\\DESCRIPTION\\System\\BIOS";
    std::wstring mfg = RegStr(HKEY_LOCAL_MACHINE, bios, L"SystemManufacturer");
    std::wstring prod = RegStr(HKEY_LOCAL_MACHINE, bios, L"SystemProductName");
    r.model = Trim(mfg + L" " + prod);
    Src oem; if (OemSource(mfg, oem)) { r.oemTool = oem.tool; r.oemUrl = oem.url; }  // Lenovo/Dell/HP/... driver tool
    r.bios = RegStr(HKEY_LOCAL_MACHINE, bios, L"BIOSVersion");
    r.biosDate = NormalizeBiosDate(RegStr(HKEY_LOCAL_MACHINE, bios, L"BIOSReleaseDate"));
    const wchar_t* cv = L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";
    std::wstring name = RegStr(HKEY_LOCAL_MACHINE, cv, L"ProductName");
    std::wstring buildStr = RegStr(HKEY_LOCAL_MACHINE, cv, L"CurrentBuildNumber");
    std::wstring disp = RegStr(HKEY_LOCAL_MACHINE, cv, L"DisplayVersion");
    int build = _wtoi(buildStr.c_str());
    if (build >= 22000) { size_t p = name.find(L"Windows 10"); if (p != std::wstring::npos) name.replace(p, 10, L"Windows 11"); }
    r.os = name; if (!disp.empty()) r.os += L" " + disp; r.os += L" (build " + buildStr + L")";
    SYSTEMTIME st; GetLocalTime(&st);
    wchar_t b[32]; swprintf_s(b, L"%04d-%02d-%02d %02d:%02d:%02d", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    r.scanned = b;
}
static void EnumerateDrivers(ScanResult& r, const std::wstring& oem) {
    HDEVINFO h = SetupDiGetClassDevsW(nullptr, nullptr, nullptr, DIGCF_ALLCLASSES | DIGCF_PRESENT);
    if (h == INVALID_HANDLE_VALUE) return;
    SP_DEVINFO_DATA d; d.cbSize = sizeof(d);
    for (DWORD i = 0; SetupDiEnumDeviceInfo(h, i, &d); ++i) {
        std::wstring name = GetDevString(h, &d, &DEVPKEY_NAME);
        if (name.empty()) name = GetDevString(h, &d, &DEVPKEY_Device_DeviceDesc);
        std::wstring cls = GetDevString(h, &d, &DEVPKEY_Device_Class);
        std::wstring mfg = GetDevString(h, &d, &DEVPKEY_Device_Manufacturer);
        std::wstring ver = GetDevString(h, &d, &DEVPKEY_Device_DriverVersion);
        std::wstring prov = GetDevString(h, &d, &DEVPKEY_Device_DriverProvider);
        std::wstring hwids = GetHardwareIds(h, &d);
        std::wstring venId = ParseVendorId(hwids);
        std::wstring vendor, tool, url; ResolveSource(venId, mfg, oem, vendor, tool, url);

        ULONG status = 0, problem = 0;
        bool hasProblem = (CM_Get_DevNode_Status(&status, &problem, d.DevInst, 0) == CR_SUCCESS &&
                           (status & DN_HAS_PROBLEM) && problem != 0);
        if (hasProblem) {
            ProblemDevice pd; pd.device = name; pd.devClass = cls; pd.problemCode = (int)problem;
            pd.problemText = ProblemText((int)problem); pd.vendor = vendor; pd.source = tool; pd.sourceUrl = url;
            r.problems.push_back(pd);
        }
        if (ver.empty()) {
            // No driver installed. If it's a problem device with a hardware id, keep it as a
            // "missing driver" candidate so the catalog check can offer one; otherwise skip.
            std::wstring mk = ParseHwKey(hwids);
            if (!hasProblem || mk.empty()) continue;
            DriverInfo di;
            di.device = name; di.devClass = cls; di.vendor = vendor; di.source = tool; di.sourceUrl = url;
            di.hwKey = mk; di.catalogUrl = CatalogUrlFor(mk); di.hwId = hwids.substr(0, hwids.find(L';'));
            di.missing = true; di.flag = L"MISSING"; r.thirdPartyCount++;
            r.drivers.push_back(di);
            continue;
        }
        std::wstring dateStr; int ageDays = -1;
        DEVPROPTYPE type = 0; DWORD req = 0; FILETIME ft{};
        if (SetupDiGetDevicePropertyW(h, &d, &DEVPKEY_Device_DriverDate, &type, (PBYTE)&ft, sizeof(ft), &req, 0))
            FileTimeToDate(ft, dateStr, ageDays);
        bool isMs = prov.find(L"Microsoft") != std::wstring::npos || mfg.find(L"Microsoft") != std::wstring::npos ||
                    mfg.find(L"Standard") != std::wstring::npos || VersionLooksInbox(ver);
        bool stale = !isMs && ageDays >= 0 && ageDays > g_staleMonths * 30;
        DriverInfo di;
        di.device = name; di.devClass = cls; di.version = ver; di.date = dateStr;
        di.provider = prov; di.vendor = vendor; di.source = tool; di.sourceUrl = url;
        di.hwKey = ParseHwKey(hwids); di.catalogUrl = CatalogUrlFor(di.hwKey);
        di.hwId = hwids.substr(0, hwids.find(L';'));  // most-specific hardware id, for force-update
        di.ageDays = ageDays; di.isMicrosoft = isMs; di.stale = stale; di.flag = stale ? L"REVIEW" : L"OK";
        if (!isMs) r.thirdPartyCount++;
        r.drivers.push_back(di);
    }
    SetupDiDestroyDeviceInfoList(h);
    std::sort(r.drivers.begin(), r.drivers.end(), [](const DriverInfo& a, const DriverInfo& b) {
        if (a.devClass != b.devClass) return a.devClass < b.devClass; return a.device < b.device; });
    std::map<std::wstring, SourceGroup> g;
    for (const auto& di : r.drivers) {
        if (di.isMicrosoft || di.sourceUrl.empty()) continue;
        auto& e = g[di.source]; e.tool = di.source; e.url = di.sourceUrl; e.count++;
    }
    for (auto& kv : g) r.sources.push_back(kv.second);
    std::sort(r.sources.begin(), r.sources.end(), [](const SourceGroup& a, const SourceGroup& b) { return a.count > b.count; });
}
static void QueryWindowsUpdate(ScanResult& r) {
    HRESULT hrInit = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    bool inited = SUCCEEDED(hrInit);
    IUpdateSession* sess = nullptr;
    if (FAILED(CoCreateInstance(__uuidof(UpdateSession), nullptr, CLSCTX_INPROC_SERVER,
                                __uuidof(IUpdateSession), (void**)&sess)) || !sess) {
        r.wuStatus = L"failed"; if (inited) CoUninitialize(); return;
    }
    IUpdateSearcher* searcher = nullptr;
    if (SUCCEEDED(sess->CreateUpdateSearcher(&searcher)) && searcher) {
        BSTR crit = SysAllocString(L"IsInstalled=0 and Type='Driver'");
        ISearchResult* res = nullptr;
        HRESULT hr = searcher->Search(crit, &res); SysFreeString(crit);
        if (SUCCEEDED(hr) && res) {
            IUpdateCollection* coll = nullptr;
            if (SUCCEEDED(res->get_Updates(&coll)) && coll) {
                LONG n = 0; coll->get_Count(&n);
                for (LONG j = 0; j < n; ++j) {
                    IUpdate* u = nullptr;
                    if (SUCCEEDED(coll->get_Item(j, &u)) && u) {
                        BSTR t = nullptr; if (SUCCEEDED(u->get_Title(&t)) && t) { r.wuOffered.push_back(t); SysFreeString(t); }
                        u->Release();
                    }
                }
                coll->Release();
            }
            res->Release();
            wchar_t b[64]; swprintf_s(b, L"ok (%zu offered)", r.wuOffered.size()); r.wuStatus = b;
        } else r.wuStatus = L"failed";
        searcher->Release();
    } else r.wuStatus = L"failed";
    sess->Release();
    if (inited) CoUninitialize();
}

typedef void (*ProgressFn)(int done, int total, const std::wstring& text);

static ScanResult* RunScan(bool skipWu) {
    ScanResult* r = new ScanResult();
    ReadSystemInfo(*r);
    EnumerateDrivers(*r, r->model);
    if (!skipWu) QueryWindowsUpdate(*r);
    return r;
}
static void CheckLatestVersions(ScanResult& r, ProgressFn progress) {
    std::vector<std::wstring> keys; std::set<std::wstring> seen;
    for (const auto& d : r.drivers) {
        if (d.isMicrosoft || d.hwKey.empty()) continue;
        if (seen.insert(d.hwKey).second) keys.push_back(d.hwKey);
    }
    std::map<std::wstring, std::tuple<std::wstring, std::wstring, std::wstring>> latest;
    int total = (int)keys.size(), done = 0;
    if (progress) progress(0, total, L"Querying Microsoft Update Catalog");
    for (const auto& k : keys) {
        std::wstring v, dt, id;
        if (CatalogLatest(k, v, dt, id)) latest[k] = std::make_tuple(v, dt, id);
        if (progress) progress(++done, total, k);
        Sleep(120);
    }
    for (auto& d : r.drivers) {
        d.checkedVia = L"";
        if (d.isMicrosoft) { d.verdict = L"Inbox (Windows Update)"; continue; }
        if (d.hwKey.empty()) { d.verdict = L"No hardware id"; continue; }
        d.checkedVia = L"Microsoft Update Catalog";
        auto it = latest.find(d.hwKey);
        if (it == latest.end()) { d.verdict = L"Not in catalog"; continue; }
        d.latest = std::get<0>(it->second); d.latestDate = std::get<1>(it->second); d.updateId = std::get<2>(it->second);
        d.verdict = CmpVer(d.latest, d.version) > 0 ? L"UPDATE AVAILABLE" : L"Up to date";
    }
}

// ===========================================================================
// JSON serialization (C++ -> JS)
// ===========================================================================
static std::wstring JEsc(const std::wstring& s) {
    std::wstring o;
    for (wchar_t c : s) {
        switch (c) {
            case L'"': o += L"\\\""; break; case L'\\': o += L"\\\\"; break;
            case L'\n': o += L"\\n"; break; case L'\r': o += L"\\r"; break; case L'\t': o += L"\\t"; break;
            default: if (c < 0x20) { wchar_t b[8]; swprintf_s(b, L"\\u%04x", c); o += b; } else o += c;
        }
    }
    return o;
}
static std::wstring JS(const std::wstring& s) { return L"\"" + JEsc(s) + L"\""; }
static std::wstring JB(bool b) { return b ? L"true" : L"false"; }

static std::wstring DriverJson(const DriverInfo& d) {
    wchar_t age[16]; if (d.ageDays >= 0) swprintf_s(age, L"%.1f", d.ageDays / 30.0); else wcscpy_s(age, L"");
    std::wstring o = L"{";
    o += L"\"device\":" + JS(d.device);
    o += L",\"class\":" + JS(d.devClass);
    o += L",\"version\":" + JS(d.version);
    o += L",\"date\":" + JS(d.date);
    o += L",\"latest\":" + JS(d.latest);
    o += L",\"latestDate\":" + JS(d.latestDate);
    o += L",\"verdict\":" + JS(d.verdict);
    o += L",\"provider\":" + JS(d.provider);
    o += L",\"vendor\":" + JS(d.vendor);
    o += L",\"source\":" + JS(d.source);
    o += L",\"sourceUrl\":" + JS(d.sourceUrl);
    o += L",\"catalogUrl\":" + JS(d.catalogUrl);
    o += L",\"updateId\":" + JS(d.updateId);
    o += L",\"ageMonths\":" + JS(age);
    o += L",\"stale\":" + JB(d.stale);
    o += L",\"isMicrosoft\":" + JB(d.isMicrosoft);
    o += L",\"missing\":" + JB(d.missing);
    o += L"}";
    return o;
}
static std::wstring ScanJson(const ScanResult& r) {
    int updates = 0; for (const auto& d : r.drivers) if (d.verdict == L"UPDATE AVAILABLE") updates++;
    std::wstring o = L"{\"type\":\"scan\",\"data\":{";
    o += L"\"model\":" + JS(r.model);
    o += L",\"bios\":" + JS(r.bios);
    o += L",\"biosDate\":" + JS(r.biosDate);
    o += L",\"os\":" + JS(r.os);
    o += L",\"scanned\":" + JS(r.scanned);
    o += L",\"wuStatus\":" + JS(r.wuStatus);
    o += L",\"thirdParty\":" + std::to_wstring(r.thirdPartyCount);
    o += L",\"updates\":" + std::to_wstring(updates);
    o += L",\"oemTool\":" + JS(r.oemTool);
    o += L",\"oemUrl\":" + JS(r.oemUrl);
    o += L",\"drivers\":[";
    for (size_t i = 0; i < r.drivers.size(); ++i) { if (i) o += L","; o += DriverJson(r.drivers[i]); }
    o += L"],\"problems\":[";
    for (size_t i = 0; i < r.problems.size(); ++i) {
        if (i) o += L",";
        const auto& p = r.problems[i];
        o += L"{\"device\":" + JS(p.device) + L",\"class\":" + JS(p.devClass) +
             L",\"problem\":" + JS(p.problemText) + L",\"source\":" + JS(p.source) +
             L",\"sourceUrl\":" + JS(p.sourceUrl) + L"}";
    }
    o += L"],\"wu\":[";
    for (size_t i = 0; i < r.wuOffered.size(); ++i) { if (i) o += L","; o += JS(r.wuOffered[i]); }
    o += L"],\"sources\":[";
    for (size_t i = 0; i < r.sources.size(); ++i) {
        if (i) o += L",";
        o += L"{\"tool\":" + JS(r.sources[i].tool) + L",\"url\":" + JS(r.sources[i].url) +
             L",\"count\":" + std::to_wstring(r.sources[i].count) + L"}";
    }
    o += L"]}}";
    return o;
}

// ===========================================================================
// Installed-apps scanner (registry Uninstall + UserAssist last-used)
// ===========================================================================
struct AppInfo {
    std::wstring name, publisher, version, installDate, lastUsed, exe, uninstall, location;
    long long sizeKb = 0;
    bool unused = false, large = false;
};
static std::wstring Rot13(const std::wstring& s) {
    std::wstring o; o.reserve(s.size());
    for (wchar_t c : s) {
        if (c >= L'a' && c <= L'z') o += (wchar_t)(L'a' + (c - L'a' + 13) % 26);
        else if (c >= L'A' && c <= L'Z') o += (wchar_t)(L'A' + (c - L'A' + 13) % 26);
        else o += c;
    }
    return o;
}
static std::wstring BaseNameLower(std::wstring p) {
    if (!p.empty() && p[0] == L'"') { size_t q = p.find(L'"', 1); if (q != std::wstring::npos) p = p.substr(1, q - 1); }
    size_t slash = p.find_last_of(L"\\/");
    std::wstring base = (slash == std::wstring::npos) ? p : p.substr(slash + 1);
    size_t comma = base.find(L','); if (comma != std::wstring::npos) base = base.substr(0, comma);
    std::transform(base.begin(), base.end(), base.begin(), towlower);
    return base;
}
static std::wstring FtToDate(const FILETIME& ft) {
    SYSTEMTIME st; if (!FileTimeToSystemTime(&ft, &st) || st.wYear < 2000) return L"";
    wchar_t b[16]; swprintf_s(b, L"%04d-%02d-%02d", st.wYear, st.wMonth, st.wDay); return b;
}
static int DaysSince(const FILETIME& ft) {
    FILETIME now; GetSystemTimeAsFileTime(&now);
    ULARGE_INTEGER a, n; a.LowPart = ft.dwLowDateTime; a.HighPart = ft.dwHighDateTime;
    n.LowPart = now.dwLowDateTime; n.HighPart = now.dwHighDateTime;
    if (n.QuadPart <= a.QuadPart) return 0;
    return (int)((n.QuadPart - a.QuadPart) / 10000000ULL / 86400ULL);
}
// UserAssist entries: full lowercased exe/lnk paths + last-exec FILETIME (offset 60).
struct UaEntry { std::wstring path, base, stem; FILETIME ft; };
static std::wstring StemOf(const std::wstring& base) {
    size_t dot = base.find_last_of(L'.');
    return dot == std::wstring::npos ? base : base.substr(0, dot);
}
static void BuildUserAssist(std::vector<UaEntry>& out) {
    HKEY root;
    if (RegOpenKeyExW(HKEY_CURRENT_USER,
        L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist", 0, KEY_READ, &root) != ERROR_SUCCESS) return;
    wchar_t guid[128];
    for (DWORD gi = 0;; ++gi) {
        DWORD glen = 128;
        if (RegEnumKeyExW(root, gi, guid, &glen, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) break;
        HKEY ck;
        if (RegOpenKeyExW(root, (std::wstring(guid) + L"\\Count").c_str(), 0, KEY_READ, &ck) != ERROR_SUCCESS) continue;
        wchar_t vname[1024]; BYTE data[256];
        for (DWORD vi = 0;; ++vi) {
            DWORD vlen = 1024, dlen = sizeof(data), type = 0;
            LONG r = RegEnumValueW(ck, vi, vname, &vlen, nullptr, &type, data, &dlen);
            if (r == ERROR_NO_MORE_ITEMS) break;
            if (r != ERROR_SUCCESS || type != REG_BINARY || dlen < 68) continue;
            FILETIME ft; CopyMemory(&ft, data + 60, sizeof(FILETIME));
            if (ft.dwLowDateTime == 0 && ft.dwHighDateTime == 0) continue;
            std::wstring path = Rot13(vname);
            std::transform(path.begin(), path.end(), path.begin(), towlower);
            if (path.find(L".exe") == std::wstring::npos && path.find(L".lnk") == std::wstring::npos) continue;
            UaEntry e; e.path = path; e.base = BaseNameLower(path); e.stem = StemOf(e.base); e.ft = ft;
            out.push_back(e);
        }
        RegCloseKey(ck);
    }
    RegCloseKey(root);
}
// Best last-exec time for an app: match by install-location prefix, icon exe name,
// or a shortcut/exe stem that appears in the app's display name.
static bool MatchLastUsed(const std::vector<UaEntry>& ua, std::wstring loc, const std::wstring& iconExe,
                          const std::wstring& appNameLower, FILETIME& best) {
    std::transform(loc.begin(), loc.end(), loc.begin(), towlower);
    while (!loc.empty() && (loc.back() == L'\\' || loc.back() == L'/')) loc.pop_back();
    bool found = false;
    for (const auto& e : ua) {
        bool m = (loc.size() > 3 && e.path.rfind(loc, 0) == 0)
              || (!iconExe.empty() && e.base == iconExe)
              || (e.stem.size() >= 4 && appNameLower.find(e.stem) != std::wstring::npos);
        if (m && (!found || CompareFileTime(&e.ft, &best) > 0)) { best = e.ft; found = true; }
    }
    return found;
}
static std::wstring RegStrIn(HKEY k, const wchar_t* val) {
    wchar_t buf[1024]; DWORD cb = sizeof(buf);
    if (RegGetValueW(k, nullptr, val, RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ, nullptr, buf, &cb) == ERROR_SUCCESS) return buf;
    return L"";
}
static DWORD RegDwordIn(HKEY k, const wchar_t* val) {
    DWORD v = 0, cb = sizeof(v); RegGetValueW(k, nullptr, val, RRF_RT_REG_DWORD, nullptr, &v, &cb); return v;
}
static void EnumAppsFrom(HKEY root, REGSAM extra, const std::vector<UaEntry>& ua,
                         std::set<std::wstring>& seen, std::vector<AppInfo>& apps) {
    HKEY base;
    if (RegOpenKeyExW(root, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
                      0, KEY_READ | extra, &base) != ERROR_SUCCESS) return;
    wchar_t key[512];
    for (DWORD i = 0;; ++i) {
        DWORD klen = 512;
        if (RegEnumKeyExW(base, i, key, &klen, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) break;
        HKEY sk;
        if (RegOpenKeyExW(base, key, 0, KEY_READ | extra, &sk) != ERROR_SUCCESS) continue;
        std::wstring name = RegStrIn(sk, L"DisplayName");
        std::wstring rel = RegStrIn(sk, L"ReleaseType");
        if (!name.empty() && RegDwordIn(sk, L"SystemComponent") != 1 &&
            RegStrIn(sk, L"ParentKeyName").empty() &&
            rel.find(L"Update") == std::wstring::npos && rel.find(L"Hotfix") == std::wstring::npos) {
            std::wstring lname = name; std::transform(lname.begin(), lname.end(), lname.begin(), towlower);
            if (seen.insert(lname).second) {
                AppInfo a;
                a.name = name;
                a.publisher = RegStrIn(sk, L"Publisher");
                a.version = RegStrIn(sk, L"DisplayVersion");
                a.sizeKb = (long long)RegDwordIn(sk, L"EstimatedSize");
                std::wstring id = RegStrIn(sk, L"InstallDate");
                if (id.size() == 8) a.installDate = id.substr(0, 4) + L"-" + id.substr(4, 2) + L"-" + id.substr(6, 2);
                a.exe = BaseNameLower(RegStrIn(sk, L"DisplayIcon"));
                a.uninstall = RegStrIn(sk, L"QuietUninstallString");
                if (a.uninstall.empty()) a.uninstall = RegStrIn(sk, L"UninstallString");
                a.location = RegStrIn(sk, L"InstallLocation");
                FILETIME best{};
                if (MatchLastUsed(ua, RegStrIn(sk, L"InstallLocation"), a.exe, lname, best)) {
                    a.lastUsed = FtToDate(best); a.unused = DaysSince(best) > 180;
                }
                a.large = a.sizeKb > 512000;  // > ~500 MB
                apps.push_back(a);
            }
        }
        RegCloseKey(sk);
    }
    RegCloseKey(base);
}
static void EnumerateApps(std::vector<AppInfo>& apps) {
    std::vector<UaEntry> ua; BuildUserAssist(ua);
    std::set<std::wstring> seen;
    EnumAppsFrom(HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY, ua, seen, apps);
    EnumAppsFrom(HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY, ua, seen, apps);
    EnumAppsFrom(HKEY_CURRENT_USER, 0, ua, seen, apps);
    std::sort(apps.begin(), apps.end(), [](const AppInfo& a, const AppInfo& b) { return a.sizeKb > b.sizeKb; });
}
static std::wstring AppsJson(const std::vector<AppInfo>& apps) {
    std::wstring o = L"{\"type\":\"apps\",\"data\":{\"apps\":[";
    for (size_t i = 0; i < apps.size(); ++i) {
        if (i) o += L",";
        const auto& a = apps[i];
        o += L"{\"name\":" + JS(a.name) + L",\"publisher\":" + JS(a.publisher) + L",\"version\":" + JS(a.version) +
             L",\"sizeKb\":" + std::to_wstring(a.sizeKb) + L",\"installDate\":" + JS(a.installDate) +
             L",\"lastUsed\":" + JS(a.lastUsed.empty() ? L"-" : a.lastUsed) +
             L",\"uninstall\":" + JS(a.uninstall) + L",\"location\":" + JS(a.location) +
             L",\"unused\":" + JB(a.unused) + L",\"large\":" + JB(a.large) + L",\"recommend\":" + JB(a.unused) + L"}";
    }
    o += L"]}}";
    return o;
}

// ===========================================================================
// Local-network scanner (ping sweep + ARP + reverse DNS + port probe)
// ===========================================================================
struct NetDevice {
    std::wstring ip, name, mac, vendor, services, noteCode;
    std::vector<int> ports;
    bool isLocal = false, isGateway = false;
};
static const struct { const char* oui; const wchar_t* v; } kOui[] = {
    {"B827EB",L"Raspberry Pi"},{"DCA632",L"Raspberry Pi"},{"E45F01",L"Raspberry Pi"},{"2CCF67",L"Raspberry Pi"},
    {"001451",L"Apple"},{"AC87A3",L"Apple"},{"F0F61C",L"Apple"},{"3C0754",L"Apple"},{"D0817A",L"Apple"},{"A4C361",L"Apple"},
    {"001632",L"Samsung"},{"5CE8EB",L"Samsung"},{"E8508B",L"Samsung"},{"8425DB",L"Samsung"},
    {"24FD52",L"Amazon"},{"68543D",L"Amazon"},{"FC65DE",L"Amazon"},{"44650D",L"Amazon"},{"50DCE7",L"Amazon"},
    {"5CCF7F",L"Espressif (IoT)"},{"240AC4",L"Espressif (IoT)"},{"A020A6",L"Espressif (IoT)"},{"7C9EBD",L"Espressif (IoT)"},
    {"D83134",L"TP-Link"},{"50C7BF",L"TP-Link"},{"EC086B",L"TP-Link"},{"AC84C6",L"TP-Link"},
    {"00000C",L"Cisco"},{"FCFBFB",L"Cisco"},{"00095B",L"Netgear"},{"A040A0",L"Netgear"},{"2C3033",L"Netgear"},
    {"001517",L"Intel"},{"3CA9F4",L"Intel"},{"8C1645",L"Intel"},{"A0C589",L"Intel"},
    {"001DD8",L"Microsoft"},{"7C1E52",L"Microsoft"},{"002241",L"Microsoft"},{"485073",L"Google"},{"F4F5E8",L"Google"},
    {"000C29",L"VMware"},{"080027",L"VirtualBox"},{"DC0856",L"Ubiquiti"},{"FCECDA",L"Ubiquiti"},{"788A20",L"Ubiquiti"},
    {"7470FD",L"Synology"},{"0011D8",L"Asustek"},{"04D4C4",L"Asustek"},{"2C56DC",L"Asustek"},{"1C872C",L"Asustek"},
    {"D46A6A",L"Asustek"},{"BC2411",L"Asustek"},{"704D7B",L"Asustek"},{"000F60",L"Dell"},{"18DBF2",L"Dell"},{"B083FE",L"Dell"},
    {"D89EF3",L"Dell"},{"F8BC12",L"Dell"},{"3CD92B",L"HP"},{"308D99",L"HP"},{"9CB6D0",L"HP"},{"643150",L"HP"},
    {"E4E749",L"HP"},{"001A2B",L"Ayecom"},{"001E58",L"D-Link"},{"1CBDB9",L"D-Link"},{"C8D3A3",L"D-Link"},
    {"6C72E7",L"Sonos"},{"949F3E",L"Sonos"},{"B8E937",L"Sonos"},{"000E58",L"Sonos"},
    {"E0763B",L"Roku"},{"CC6DA0",L"Roku"},{"B0A737",L"Roku"},{"D052A8",L"Physical Graph (SmartThings)"},
    {"18B430",L"Nest"},{"641666",L"Nest"},{"F4F5D8",L"Google"},{"A47733",L"Google"},{"D8EB46",L"Google"},
    {"3C2EFF",L"Wyze"},{"2CAA8E",L"Wyze"},{"7CB94C",L"Tuya/Smart Life"},{"D8F15B",L"Espressif (IoT)"},{"C82B96",L"Espressif (IoT)"},
    {"BCDDC2",L"Espressif (IoT)"},{"3C71BF",L"Espressif (IoT)"},{"001788",L"Philips Hue"},{"ECB5FA",L"Philips Hue"},
    {"0017880",L"Philips Hue"},{"DCA4CA",L"Apple"},{"F0DBF8",L"Apple"},{"A8667F",L"Apple"},{"9C207B",L"Apple"},
    {"E0B9BA",L"Apple"},{"BCD074",L"Sony"},{"FCF152",L"Sony"},{"3495DB",L"Sony"},{"0024BE",L"Lenovo"},{"54EE75",L"Lenovo"},
    {"8C16D9",L"Xiaomi"},{"640980",L"Xiaomi"},{"F8A45F",L"Xiaomi"},{"286C07",L"Xiaomi"},
};
static std::wstring MacToStr(const BYTE* m) {
    wchar_t b[24]; swprintf_s(b, L"%02X:%02X:%02X:%02X:%02X:%02X", m[0], m[1], m[2], m[3], m[4], m[5]); return b;
}
// Full IEEE OUI database, loaded once from the embedded resource (OUI<TAB>vendor).
static std::unordered_map<std::string, std::wstring> g_ouiDb;
static void EnsureOuiDb() {
    if (!g_ouiDb.empty()) return;
    HRSRC res = FindResourceW(nullptr, MAKEINTRESOURCEW(IDR_OUIDB), RT_RCDATA);
    if (!res) return;
    HGLOBAL h = LoadResource(nullptr, res);
    DWORD sz = SizeofResource(nullptr, res);
    const char* data = (const char*)LockResource(h);
    if (!data || !sz) return;
    g_ouiDb.reserve(40000);
    const char* p = data; const char* end = data + sz;
    while (p < end) {
        const char* nl = (const char*)memchr(p, '\n', end - p);
        const char* lineEnd = nl ? nl : end;
        const char* tab = (const char*)memchr(p, '\t', lineEnd - p);
        if (tab && tab - p == 6) {
            std::string key(p, 6);
            std::string val(tab + 1, lineEnd - (tab + 1));
            int wlen = MultiByteToWideChar(CP_UTF8, 0, val.c_str(), (int)val.size(), nullptr, 0);
            std::wstring wv(wlen, L'\0');
            MultiByteToWideChar(CP_UTF8, 0, val.c_str(), (int)val.size(), wv.data(), wlen);
            g_ouiDb.emplace(std::move(key), std::move(wv));
        }
        if (!nl) break; p = nl + 1;
    }
}
static std::wstring OuiVendor(const BYTE* m) {
    char p[7]; sprintf_s(p, "%02X%02X%02X", m[0], m[1], m[2]);
    for (auto& e : kOui) if (_stricmp(e.oui, p) == 0) return e.v;  // curated, nicer names first
    auto it = g_ouiDb.find(std::string(p, 6));
    return it == g_ouiDb.end() ? L"" : it->second;
}
static std::wstring RevDns(DWORD ipNet) {
    sockaddr_in sa{}; sa.sin_family = AF_INET; sa.sin_addr.S_un.S_addr = ipNet;
    wchar_t host[NI_MAXHOST];
    if (GetNameInfoW((sockaddr*)&sa, sizeof(sa), host, NI_MAXHOST, nullptr, 0, NI_NAMEREQD) == 0) {
        std::wstring h = host; size_t dot = h.find(L'.');  // strip domain suffix
        return dot == std::wstring::npos ? h : h.substr(0, dot);
    }
    return L"";
}
static bool PortOpen(DWORD ipNet, u_short port, int ms) {
    SOCKET s = socket(AF_INET, SOCK_STREAM, 0); if (s == INVALID_SOCKET) return false;
    u_long nb = 1; ioctlsocket(s, FIONBIO, &nb);
    sockaddr_in sa{}; sa.sin_family = AF_INET; sa.sin_addr.S_un.S_addr = ipNet; sa.sin_port = htons(port);
    connect(s, (sockaddr*)&sa, sizeof(sa));
    fd_set wf; FD_ZERO(&wf); FD_SET(s, &wf);
    timeval tv{ ms / 1000, (ms % 1000) * 1000 };
    bool ok = false;
    if (select(0, nullptr, &wf, nullptr, &tv) > 0) {
        int err = 0, len = sizeof(err); getsockopt(s, SOL_SOCKET, SO_ERROR, (char*)&err, &len); ok = (err == 0);
    }
    closesocket(s); return ok;
}
static std::wstring ProbeServices(DWORD ipNet, std::vector<int>& openPorts) {
    struct { u_short p; const wchar_t* n; } ports[] = {
        {80,L"web"},{443,L"web (HTTPS)"},{445,L"file sharing (SMB)"},{22,L"SSH"},{23,L"Telnet"},{8080,L"web (8080)"} };
    std::wstring out;
    for (auto& pp : ports) if (PortOpen(ipNet, pp.p, 280)) { openPorts.push_back(pp.p); if (!out.empty()) out += L", "; out += pp.n; }
    return out;
}
static bool PingHost(DWORD ipNet, int ms) {
    HANDLE h = IcmpCreateFile(); if (h == INVALID_HANDLE_VALUE) return false;
    char payload[1] = { 0 }; BYTE reply[sizeof(ICMP_ECHO_REPLY) + 8];
    DWORD r = IcmpSendEcho(h, ipNet, payload, 1, nullptr, reply, sizeof(reply), ms);
    IcmpCloseHandle(h); return r > 0;
}
static bool GetLocalNet(DWORD& localN, DWORD& gwN, DWORD& base) {
    ULONG sz = 16000; std::vector<BYTE> buf(sz);
    ULONG flags = GAA_FLAG_INCLUDE_GATEWAYS;
    if (GetAdaptersAddresses(AF_INET, flags, nullptr, (IP_ADAPTER_ADDRESSES*)buf.data(), &sz) == ERROR_BUFFER_OVERFLOW) {
        buf.resize(sz);
        if (GetAdaptersAddresses(AF_INET, flags, nullptr, (IP_ADAPTER_ADDRESSES*)buf.data(), &sz) != NO_ERROR) return false;
    }
    for (auto a = (IP_ADAPTER_ADDRESSES*)buf.data(); a; a = a->Next) {
        if (a->OperStatus != IfOperStatusUp || a->IfType == IF_TYPE_SOFTWARE_LOOPBACK) continue;
        if (!a->FirstGatewayAddress || !a->FirstUnicastAddress) continue;
        localN = ((sockaddr_in*)a->FirstUnicastAddress->Address.lpSockaddr)->sin_addr.S_un.S_addr;
        gwN = ((sockaddr_in*)a->FirstGatewayAddress->Address.lpSockaddr)->sin_addr.S_un.S_addr;
        base = localN & 0x00FFFFFF;   // a.b.c.0 (last octet is the high byte in network order)
        return true;
    }
    return false;
}
static std::wstring IpStr(DWORD ipNet) {
    in_addr a; a.S_un.S_addr = ipNet; wchar_t b[24]; InetNtopW(AF_INET, &a, b, 24); return b;
}
static void ScanNetwork(std::vector<NetDevice>& out) {
    WSADATA w; WSAStartup(MAKEWORD(2, 2), &w);
    EnsureOuiDb();  // load once, single-threaded, before the parallel workers read it
    DWORD localN = 0, gwN = 0, base = 0;
    if (!GetLocalNet(localN, gwN, base)) { WSACleanup(); return; }

    std::mutex mtx;
    auto worker = [&](int from, int to) {
        for (int host = from; host <= to; ++host) {
            DWORD ip = base | ((DWORD)host << 24);
            if (!PingHost(ip, 350)) continue;
            NetDevice d; d.ip = IpStr(ip);
            BYTE mac[8]; ULONG mlen = 6;
            if (SendARP(ip, 0, mac, &mlen) == NO_ERROR && mlen == 6) { d.mac = MacToStr(mac); d.vendor = OuiVendor(mac); }
            d.name = RevDns(ip);
            d.services = ProbeServices(ip, d.ports);
            if (std::find(d.ports.begin(), d.ports.end(), 23) != d.ports.end()) d.noteCode = L"telnet";
            { std::lock_guard<std::mutex> lk(mtx); out.push_back(d); }
        }
    };
    const int N = 24;
    std::vector<std::thread> ts;
    int per = (254 + N - 1) / N;
    for (int i = 0; i < N; ++i) {
        int from = 1 + i * per, to = (from + per - 1 < 254) ? from + per - 1 : 254;
        if (from > 254) break;
        ts.emplace_back(worker, from, to);
    }
    for (auto& t : ts) t.join();

    // Ensure this PC and the gateway are present, and tag roles.
    auto findOrAdd = [&](DWORD ipN) -> NetDevice* {
        std::wstring s = IpStr(ipN);
        for (auto& d : out) if (d.ip == s) return &d;
        NetDevice d; d.ip = s; out.push_back(d); return &out.back();
    };
    NetDevice* loc = findOrAdd(localN); loc->isLocal = true;
    NetDevice* gw = findOrAdd(gwN); gw->isGateway = true;

    std::sort(out.begin(), out.end(), [](const NetDevice& a, const NetDevice& b) {
        // sort by last octet (high byte of network-order address)
        return (a.ip.size() && b.ip.size()) ? (_wtoi(a.ip.substr(a.ip.find_last_of(L'.') + 1).c_str())
                                             < _wtoi(b.ip.substr(b.ip.find_last_of(L'.') + 1).c_str())) : false;
    });
    WSACleanup();
}
static std::wstring NetJson(const std::vector<NetDevice>& devs) {
    std::wstring o = L"{\"type\":\"network\",\"data\":{\"devices\":[";
    for (size_t i = 0; i < devs.size(); ++i) {
        if (i) o += L",";
        const auto& d = devs[i];
        std::wstring portsArr; for (size_t pi = 0; pi < d.ports.size(); ++pi) { if (pi) portsArr += L","; portsArr += std::to_wstring(d.ports[pi]); }
        o += L"{\"ip\":" + JS(d.ip) + L",\"name\":" + JS(d.name) + L",\"mac\":" + JS(d.mac) +
             L",\"vendor\":" + JS(d.vendor) + L",\"services\":" + JS(d.services) + L",\"noteCode\":" + JS(d.noteCode) +
             L",\"ports\":[" + portsArr + L"]" +
             L",\"isLocal\":" + JB(d.isLocal) + L",\"isGateway\":" + JB(d.isGateway) + L"}";
    }
    o += L"]}}";
    return o;
}
static std::wstring ScanNetworkJson() { std::vector<NetDevice> d; ScanNetwork(d); return NetJson(d); }

// ===========================================================================
// System alerts & errors (Windows Event Log + disk space)
// ===========================================================================
struct SysAlert { std::wstring time, source, level, message; int eventId = 0; int count = 1; };
struct DiskWarn { std::wstring drive; int pctFree = 0; std::wstring freeStr, totalStr; };

static std::wstring RegexFirst(const std::wstring& s, const std::wregex& re) {
    std::wsmatch m; return std::regex_search(s, m, re) ? m[1].str() : L"";
}
static std::wstring FormatEvtMessage(EVT_HANDLE meta, EVT_HANDLE ev) {
    if (!meta) return L"";
    DWORD used = 0;
    EvtFormatMessage(meta, ev, 0, 0, nullptr, EvtFormatMessageEvent, 0, nullptr, &used);
    if (used == 0) return L"";
    std::vector<wchar_t> buf(used);
    if (!EvtFormatMessage(meta, ev, 0, 0, nullptr, EvtFormatMessageEvent, used, buf.data(), &used)) return L"";
    std::wstring m = buf.data();
    size_t nl = m.find_first_of(L"\r\n");           // first line only
    if (nl != std::wstring::npos) m = m.substr(0, nl);
    if (m.size() > 160) m = m.substr(0, 160) + L"...";
    return Trim(m);
}
static void QuerySysLog(const wchar_t* channel, std::vector<SysAlert>& out,
                        std::map<std::wstring, EVT_HANDLE>& metaCache, int maxN) {
    static const std::wregex reProv(L"<Provider Name='([^']*)'");
    static const std::wregex reId(L"<EventID[^>]*>([0-9]+)</EventID>");
    static const std::wregex reLvl(L"<Level>([0-9]+)</Level>");
    static const std::wregex reTime(L"SystemTime='([^']*)'");
    const wchar_t* q = L"*[System[(Level=1 or Level=2) and TimeCreated[timediff(@SystemTime) <= 604800000]]]";
    EVT_HANDLE h = EvtQuery(nullptr, channel, q, EvtQueryChannelPath | EvtQueryReverseDirection);
    if (!h) return;
    EVT_HANDLE evs[12]; DWORD ret = 0; int n = 0;
    while (n < maxN && EvtNext(h, 12, evs, 3000, 0, &ret)) {
        for (DWORD i = 0; i < ret; ++i) {
            DWORD used = 0, props = 0;
            EvtRender(nullptr, evs[i], EvtRenderEventXml, 0, nullptr, &used, &props);
            std::wstring xml;
            if (used) { std::vector<wchar_t> xb(used / sizeof(wchar_t) + 1, 0);
                if (EvtRender(nullptr, evs[i], EvtRenderEventXml, used, xb.data(), &used, &props)) xml = xb.data(); }
            if (!xml.empty()) {
                SysAlert a;
                a.source = RegexFirst(xml, reProv);
                a.eventId = _wtoi(RegexFirst(xml, reId).c_str());
                a.level = RegexFirst(xml, reLvl) == L"1" ? L"Critical" : L"Error";
                std::wstring t = RegexFirst(xml, reTime);
                size_t dot = t.find(L'.'); if (dot != std::wstring::npos) t = t.substr(0, dot);
                size_t T = t.find(L'T'); if (T != std::wstring::npos) t[T] = L' ';
                a.time = t;
                if (!a.source.empty()) {
                    auto it = metaCache.find(a.source);
                    EVT_HANDLE meta = (it != metaCache.end()) ? it->second
                        : (metaCache[a.source] = EvtOpenPublisherMetadata(nullptr, a.source.c_str(), nullptr, 0, 0));
                    a.message = FormatEvtMessage(meta, evs[i]);
                }
                out.push_back(a); ++n;
            }
            EvtClose(evs[i]);
            if (n >= maxN) break;
        }
    }
    EvtClose(h);
}
// --- WMI helper: run a query in a namespace, return rows of selected props ---
static bool WmiQuery(const wchar_t* ns, const wchar_t* query, const std::vector<std::wstring>& props,
                     std::vector<std::vector<std::wstring>>& rows) {
    IWbemLocator* loc = nullptr;
    if (FAILED(CoCreateInstance(CLSID_WbemLocator, nullptr, CLSCTX_INPROC_SERVER, IID_IWbemLocator, (void**)&loc)) || !loc)
        return false;
    IWbemServices* svc = nullptr;
    bool ok = false;
    if (SUCCEEDED(loc->ConnectServer(_bstr_t(ns), nullptr, nullptr, nullptr, 0, nullptr, nullptr, &svc)) && svc) {
        CoSetProxyBlanket(svc, RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, nullptr, RPC_C_AUTHN_LEVEL_CALL,
                          RPC_C_IMP_LEVEL_IMPERSONATE, nullptr, EOAC_NONE);
        IEnumWbemClassObject* en = nullptr;
        if (SUCCEEDED(svc->ExecQuery(_bstr_t(L"WQL"), _bstr_t(query),
                      WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY, nullptr, &en)) && en) {
            IWbemClassObject* obj = nullptr; ULONG ret = 0;
            while (en->Next(2000, 1, &obj, &ret) == S_OK && obj) {
                std::vector<std::wstring> row;
                for (const auto& p : props) {
                    VARIANT v; VariantInit(&v);
                    std::wstring val;
                    if (SUCCEEDED(obj->Get(p.c_str(), 0, &v, nullptr, nullptr))) {
                        if (v.vt == VT_BSTR && v.bstrVal) val = v.bstrVal;
                        else if (v.vt == VT_I4) val = std::to_wstring(v.lVal);
                        else if (v.vt == VT_UI4) val = std::to_wstring(v.ulVal);
                        else if (v.vt == VT_BOOL) val = v.boolVal ? L"1" : L"0";
                    }
                    VariantClear(&v); row.push_back(val);
                }
                row.push_back(L"");  // sentinel
                rows.push_back(row);
                obj->Release(); obj = nullptr;
            }
            en->Release(); ok = true;
        }
        svc->Release();
    }
    loc->Release();
    return ok;
}
static DWORD RegDw(HKEY root, const wchar_t* sub, const wchar_t* val, DWORD def = 0) {
    DWORD v = def, cb = sizeof(v);
    if (RegGetValueW(root, sub, val, RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY, nullptr, &v, &cb) != ERROR_SUCCESS) return def;
    return v;
}
static bool KeyExists(HKEY root, const wchar_t* sub) {
    HKEY k; if (RegOpenKeyExW(root, sub, 0, KEY_READ, &k) == ERROR_SUCCESS) { RegCloseKey(k); return true; } return false;
}

struct SecInfo {
    std::wstring av; bool avOn = false, avUpToDate = true;
    int fwOn = 0;            // count of profiles with firewall on (0..3)
    bool uac = true, pendingReboot = false;
    std::wstring bitlocker;  // "On"/"Off"/"" (unknown)
};
static void GatherSecurity(SecInfo& s) {
    // Antivirus via SecurityCenter2.
    std::vector<std::vector<std::wstring>> rows;
    if (WmiQuery(L"ROOT\\SecurityCenter2", L"SELECT displayName,productState FROM AntiVirusProduct",
                 {L"displayName", L"productState"}, rows) && !rows.empty()) {
        s.av = rows[0][0];
        int ps = _wtoi(rows[0][1].c_str());
        s.avOn = (ps & 0x1000) != 0;
        s.avUpToDate = (ps & 0x10) == 0;
    }
    // Firewall profiles (registry).
    const wchar_t* base = L"SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy\\";
    for (const wchar_t* prof : {L"StandardProfile", L"PublicProfile", L"DomainProfile"})
        if (RegDw(HKEY_LOCAL_MACHINE, (std::wstring(base) + prof).c_str(), L"EnableFirewall", 1)) s.fwOn++;
    // UAC.
    s.uac = RegDw(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System", L"EnableLUA", 1) != 0;
    // Pending reboot.
    s.pendingReboot =
        KeyExists(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending") ||
        KeyExists(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired");
    // BitLocker (best-effort; needs admin).
    std::vector<std::vector<std::wstring>> bl;
    if (WmiQuery(L"ROOT\\CIMV2\\Security\\MicrosoftVolumeEncryption",
                 L"SELECT DriveLetter,ProtectionStatus FROM Win32_EncryptableVolume",
                 {L"DriveLetter", L"ProtectionStatus"}, bl)) {
        for (auto& r : bl) if (r[0] == L"C:") s.bitlocker = (r[1] == L"1") ? L"On" : L"Off";
    }
}

struct StartupItem { std::wstring name, command, location, kind; bool disabled = false; };  // kind: hkcu/hklm64/hklm32/folder
static void GatherStartupFrom(HKEY root, const wchar_t* sub, REGSAM extra, const wchar_t* label, const wchar_t* kind, std::vector<StartupItem>& out) {
    HKEY k;
    if (RegOpenKeyExW(root, sub, 0, KEY_READ | extra, &k) != ERROR_SUCCESS) return;
    wchar_t name[256]; BYTE data[2048];
    for (DWORD i = 0;; ++i) {
        DWORD nlen = 256, dlen = sizeof(data), type = 0;
        LONG r = RegEnumValueW(k, i, name, &nlen, nullptr, &type, data, &dlen);
        if (r == ERROR_NO_MORE_ITEMS) break;
        if (r != ERROR_SUCCESS || (type != REG_SZ && type != REG_EXPAND_SZ)) continue;
        StartupItem it; it.name = name; it.command = (wchar_t*)data; it.location = label; it.kind = kind;
        out.push_back(it);
    }
    RegCloseKey(k);
}
static void GatherStartupFolder(int csidl, const wchar_t* label, std::vector<StartupItem>& out) {
    wchar_t path[MAX_PATH];
    if (FAILED(SHGetFolderPathW(nullptr, csidl, nullptr, 0, path))) return;
    std::wstring pat = std::wstring(path) + L"\\*";
    WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW(pat.c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return;
    do {
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
        std::wstring fn = fd.cFileName;
        if (fn == L"desktop.ini") continue;
        StartupItem it; it.command = std::wstring(path) + L"\\" + fn; it.location = label; it.kind = L"folder";
        // A folder item we disabled is renamed "<name>.disabled" so Windows ignores it
        // but it still shows in the list with an Enable button.
        const std::wstring suf = L".disabled";
        if (fn.size() > suf.size() && fn.compare(fn.size() - suf.size(), suf.size(), suf) == 0) {
            it.name = fn.substr(0, fn.size() - suf.size()); it.disabled = true;
        } else { it.name = fn; }
        out.push_back(it);
    } while (FindNextFileW(h, &fd));
    FindClose(h);
}
// Disabled registry Run entries are backed up under
// HKCU\Software\Butler\DisabledStartup\<kind>\<name> = <command>. List them as
// disabled items so the user can re-enable them.
static void GatherDisabledStartup(std::vector<StartupItem>& out) {
    const wchar_t* kinds[] = { L"hkcu", L"hklm64", L"hklm32" };
    for (const wchar_t* kind : kinds) {
        std::wstring sub = std::wstring(L"Software\\Butler\\DisabledStartup\\") + kind;
        HKEY k; if (RegOpenKeyExW(HKEY_CURRENT_USER, sub.c_str(), 0, KEY_READ, &k) != ERROR_SUCCESS) continue;
        wchar_t name[256]; BYTE data[2048];
        for (DWORD i = 0;; ++i) {
            DWORD nlen = 256, dlen = sizeof(data), type = 0;
            if (RegEnumValueW(k, i, name, &nlen, nullptr, &type, data, &dlen) != ERROR_SUCCESS) break;
            StartupItem it; it.name = name; it.command = (wchar_t*)data; it.kind = kind; it.disabled = true;
            it.location = L"Disabled";
            out.push_back(it);
        }
        RegCloseKey(k);
    }
}
static void GatherStartup(std::vector<StartupItem>& out) {
    const wchar_t* run = L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";
    GatherStartupFrom(HKEY_CURRENT_USER, run, 0, L"This user (registry)", L"hkcu", out);
    GatherStartupFrom(HKEY_LOCAL_MACHINE, run, KEY_WOW64_64KEY, L"All users (registry)", L"hklm64", out);
    GatherStartupFrom(HKEY_LOCAL_MACHINE, run, KEY_WOW64_32KEY, L"All users (registry, 32-bit)", L"hklm32", out);
    GatherStartupFolder(CSIDL_STARTUP, L"This user (Startup folder)", out);
    GatherStartupFolder(CSIDL_COMMON_STARTUP, L"All users (Startup folder)", out);
    GatherDisabledStartup(out);
}
// Stop an app from launching at startup. Registry entries are backed up under
// HKCU\Software\Butler\DisabledStartup before removal; folder shortcuts go to
// the Recycle Bin (so both are recoverable).
static bool DisableStartup(const std::wstring& kind, const std::wstring& name, const std::wstring& command) {
    if (kind == L"folder") {
        // Rename the shortcut to "<file>.disabled" so Windows ignores it but it stays
        // listed (recoverable by renaming back). command is the full path.
        std::wstring dst = command + L".disabled";
        return MoveFileExW(command.c_str(), dst.c_str(), MOVEFILE_REPLACE_EXISTING) != 0;
    }
    HKEY bk;  // back up under DisabledStartup\<kind>\<name> = command so we can re-enable
    std::wstring bksub = std::wstring(L"Software\\Butler\\DisabledStartup\\") + kind;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, bksub.c_str(), 0, nullptr, 0, KEY_WRITE, nullptr, &bk, nullptr) == ERROR_SUCCESS) {
        RegSetValueExW(bk, name.c_str(), 0, REG_SZ, (const BYTE*)command.c_str(), (DWORD)((command.size() + 1) * sizeof(wchar_t)));
        RegCloseKey(bk);
    }
    HKEY root = (kind == L"hkcu") ? HKEY_CURRENT_USER : HKEY_LOCAL_MACHINE;
    REGSAM extra = (kind == L"hklm32") ? KEY_WOW64_32KEY : (kind == L"hklm64" ? KEY_WOW64_64KEY : 0);
    HKEY k;
    if (RegOpenKeyExW(root, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run", 0, KEY_SET_VALUE | extra, &k) != ERROR_SUCCESS) return false;
    LONG r = RegDeleteValueW(k, name.c_str()); RegCloseKey(k);
    return r == ERROR_SUCCESS;
}
// Re-enable a previously disabled startup item. For folders, command is the path the
// item should have (without .disabled); we rename "<path>.disabled" back.
static bool EnableStartup(const std::wstring& kind, const std::wstring& name, const std::wstring& command) {
    if (kind == L"folder") {
        std::wstring src = command + L".disabled";
        return MoveFileExW(src.c_str(), command.c_str(), MOVEFILE_REPLACE_EXISTING) != 0;
    }
    // Read the backed-up command, restore it to the Run key, then remove the backup.
    std::wstring bksub = std::wstring(L"Software\\Butler\\DisabledStartup\\") + kind;
    wchar_t data[2048] = L""; DWORD dlen = sizeof(data);
    std::wstring cmd = command;
    if (cmd.empty() && RegGetValueW(HKEY_CURRENT_USER, bksub.c_str(), name.c_str(), RRF_RT_REG_SZ, nullptr, data, &dlen) == ERROR_SUCCESS)
        cmd = data;
    HKEY root = (kind == L"hkcu") ? HKEY_CURRENT_USER : HKEY_LOCAL_MACHINE;
    REGSAM extra = (kind == L"hklm32") ? KEY_WOW64_32KEY : (kind == L"hklm64" ? KEY_WOW64_64KEY : 0);
    HKEY k;
    if (RegOpenKeyExW(root, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run", 0, KEY_SET_VALUE | extra, &k) == ERROR_SUCCESS) {
        RegSetValueExW(k, name.c_str(), 0, REG_SZ, (const BYTE*)cmd.c_str(), (DWORD)((cmd.size() + 1) * sizeof(wchar_t)));
        RegCloseKey(k);
    }
    HKEY bk;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, bksub.c_str(), 0, KEY_SET_VALUE, &bk) == ERROR_SUCCESS) {
        RegDeleteValueW(bk, name.c_str()); RegCloseKey(bk);
    }
    return true;
}
// Re-list startup items and push them to the UI (used after enable/disable so the
// list updates without a full system rescan).
static void PushJson(const std::wstring& json);  // defined later
static void PushStartup() {
    std::vector<StartupItem> startup; GatherStartup(startup);
    std::wstring o = L"{\"type\":\"startup\",\"startup\":[";
    for (size_t i = 0; i < startup.size(); ++i) {
        if (i) o += L",";
        o += L"{\"name\":" + JS(startup[i].name) + L",\"command\":" + JS(startup[i].command) +
             L",\"location\":" + JS(startup[i].location) + L",\"kind\":" + JS(startup[i].kind) +
             L",\"disabled\":" + JB(startup[i].disabled) + L"}";
    }
    o += L"]}"; PushJson(o);
}

struct RestorePt { std::wstring desc, when; int seq = 0; };
static void GatherRestorePoints(std::vector<RestorePt>& out) {
    std::vector<std::vector<std::wstring>> rows;
    if (WmiQuery(L"ROOT\\DEFAULT", L"SELECT Description,CreationTime,SequenceNumber FROM SystemRestore",
                 {L"Description", L"CreationTime", L"SequenceNumber"}, rows)) {
        for (auto& r : rows) {
            RestorePt p; p.desc = r[0]; p.seq = _wtoi(r[2].c_str());
            std::wstring t = r[1];  // WMI datetime yyyymmddHHMMSS...
            if (t.size() >= 14) p.when = t.substr(0, 4) + L"-" + t.substr(4, 2) + L"-" + t.substr(6, 2) + L" " + t.substr(8, 2) + L":" + t.substr(10, 2);
            out.push_back(p);
        }
        std::sort(out.begin(), out.end(), [](const RestorePt& a, const RestorePt& b) { return a.seq > b.seq; });
    }
}

static void ScanSystem(std::vector<SysAlert>& alerts, std::vector<DiskWarn>& disks) {
    std::map<std::wstring, EVT_HANDLE> metaCache;
    QuerySysLog(L"System", alerts, metaCache, 60);
    QuerySysLog(L"Application", alerts, metaCache, 60);
    for (auto& kv : metaCache) if (kv.second) EvtClose(kv.second);
    std::sort(alerts.begin(), alerts.end(), [](const SysAlert& a, const SysAlert& b) { return a.time > b.time; });

    // Low-disk-space warnings (fixed drives under 12% free).
    wchar_t drives[256]; DWORD len = GetLogicalDriveStringsW(256, drives);
    for (wchar_t* d = drives; *d; d += wcslen(d) + 1) {
        if (GetDriveTypeW(d) != DRIVE_FIXED) continue;
        ULARGE_INTEGER freeB{}, totalB{};
        if (GetDiskFreeSpaceExW(d, &freeB, &totalB, nullptr) && totalB.QuadPart > 0) {
            int pct = (int)((freeB.QuadPart * 100) / totalB.QuadPart);
            if (pct < 12) {
                DiskWarn w; w.drive = d; w.pctFree = pct;
                wchar_t b[32];
                swprintf_s(b, L"%.1f GB", freeB.QuadPart / 1073741824.0); w.freeStr = b;
                swprintf_s(b, L"%.0f GB", totalB.QuadPart / 1073741824.0); w.totalStr = b;
                disks.push_back(w);
            }
        }
    }
}
static std::wstring SysJson(const std::vector<SysAlert>& alerts, const std::vector<DiskWarn>& disks,
                           const SecInfo& sec, const std::vector<StartupItem>& startup, const std::vector<RestorePt>& restore) {
    std::wstring o = L"{\"type\":\"system\",\"data\":{\"alerts\":[";
    for (size_t i = 0; i < alerts.size(); ++i) {
        if (i) o += L",";
        const auto& a = alerts[i];
        o += L"{\"time\":" + JS(a.time) + L",\"source\":" + JS(a.source) + L",\"level\":" + JS(a.level) +
             L",\"eventId\":" + std::to_wstring(a.eventId) + L",\"message\":" + JS(a.message) + L"}";
    }
    o += L"],\"disks\":[";
    for (size_t i = 0; i < disks.size(); ++i) {
        if (i) o += L",";
        const auto& d = disks[i];
        o += L"{\"drive\":" + JS(d.drive) + L",\"pctFree\":" + std::to_wstring(d.pctFree) +
             L",\"free\":" + JS(d.freeStr) + L",\"total\":" + JS(d.totalStr) + L"}";
    }
    o += L"],\"security\":{\"av\":" + JS(sec.av) + L",\"avOn\":" + JB(sec.avOn) + L",\"avUpToDate\":" + JB(sec.avUpToDate) +
         L",\"fwOn\":" + std::to_wstring(sec.fwOn) + L",\"uac\":" + JB(sec.uac) +
         L",\"pendingReboot\":" + JB(sec.pendingReboot) + L",\"bitlocker\":" + JS(sec.bitlocker) + L"}";
    o += L",\"startup\":[";
    for (size_t i = 0; i < startup.size(); ++i) {
        if (i) o += L",";
        o += L"{\"name\":" + JS(startup[i].name) + L",\"command\":" + JS(startup[i].command) + L",\"location\":" + JS(startup[i].location) + L",\"kind\":" + JS(startup[i].kind) + L",\"disabled\":" + JB(startup[i].disabled) + L"}";
    }
    o += L"],\"restore\":[";
    for (size_t i = 0; i < restore.size(); ++i) {
        if (i) o += L",";
        o += L"{\"desc\":" + JS(restore[i].desc) + L",\"when\":" + JS(restore[i].when) + L"}";
    }
    o += L"]}}";
    return o;
}
static std::wstring ScanSystemJson() {
    std::vector<SysAlert> a; std::vector<DiskWarn> d; ScanSystem(a, d);  // event log + disk (no COM)
    SecInfo sec; std::vector<StartupItem> startup; std::vector<RestorePt> restore;
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    bool inited = SUCCEEDED(hr) || hr == RPC_E_CHANGED_MODE;
    GatherSecurity(sec); GatherStartup(startup); GatherRestorePoints(restore);
    if (SUCCEEDED(hr)) CoUninitialize();
    return SysJson(a, d, sec, startup, restore);
}

// ===========================================================================
// Health Score: roll the key checks into one 0-100 score + a prioritized,
// plain-language action list. Each finding carries an id + params (so the UI
// renders it in the user's language) and a cat/sub (so "Show me" deep-links to
// the tab that fixes it). Reuses the existing gatherers - no new probing.
// ===========================================================================
static std::wstring HF(const wchar_t* id, const wchar_t* sev, const std::wstring& params,
                       const wchar_t* cat, const wchar_t* sub, const wchar_t* fix) {
    std::wstring o = L"{\"id\":\""; o += id; o += L"\",\"sev\":\""; o += sev; o += L"\"";
    if (!params.empty()) { o += L","; o += params; }
    o += L",\"cat\":"; o += (cat ? JS(std::wstring(cat)) : std::wstring(L"null"));
    o += L",\"sub\":"; o += (sub ? JS(std::wstring(sub)) : std::wstring(L"null"));
    o += L",\"fix\":"; o += (fix ? JS(std::wstring(fix)) : std::wstring(L"null"));
    o += L"}";
    return o;
}
static std::wstring HealthJson() {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    bool comInit = SUCCEEDED(hr);
    SecInfo sec; GatherSecurity(sec);
    std::vector<StartupItem> startup; GatherStartup(startup);
    std::vector<RestorePt> restore; GatherRestorePoints(restore);
    if (comInit) CoUninitialize();

    int score = 100;
    std::vector<std::wstring> reds, oranges, greens;
    auto emit = [&](std::vector<std::wstring>& bucket, int penalty, const wchar_t* id,
                    const wchar_t* sev, const std::wstring& params,
                    const wchar_t* cat, const wchar_t* sub, const wchar_t* fix) {
        bucket.push_back(HF(id, sev, params, cat, sub, fix));
        score -= penalty;
    };

    // Disk space on each fixed drive.
    {
        wchar_t drives[256]; GetLogicalDriveStringsW(256, drives);
        bool low = false;
        for (wchar_t* d = drives; *d; d += wcslen(d) + 1) {
            if (GetDriveTypeW(d) != DRIVE_FIXED) continue;
            ULARGE_INTEGER freeB{}, totalB{};
            if (GetDiskFreeSpaceExW(d, &freeB, &totalB, nullptr) && totalB.QuadPart > 0) {
                int pct = (int)((freeB.QuadPart * 100) / totalB.QuadPart);
                wchar_t gbs[32]; swprintf_s(gbs, L"%.1f", freeB.QuadPart / 1073741824.0);
                std::wstring p = L"\"drive\":" + JS(std::wstring(d)) + L",\"gb\":\"" + gbs + L"\",\"pct\":" + std::to_wstring(pct);
                if (pct < 10)      { emit(reds, 22, L"disklow", L"red", p, L"system", L"cleanup", nullptr); low = true; }
                else if (pct < 15) { emit(oranges, 10, L"disklow", L"orange", p, L"system", L"cleanup", nullptr); low = true; }
            }
        }
        if (!low) greens.push_back(HF(L"diskok", L"green", L"", L"system", L"cleanup", nullptr));
    }
    // Startup load (count of enabled startup entries).
    {
        int n = 0; for (auto& it : startup) if (!it.disabled) n++;
        std::wstring p = L"\"n\":" + std::to_wstring(n);
        if (n > 25)      emit(reds, 12, L"startupmany", L"red", p, L"system", L"startup", nullptr);
        else if (n > 12) emit(oranges, 7, L"startupmany", L"orange", p, L"system", L"startup", nullptr);
        else             greens.push_back(HF(L"startupok", L"green", p, L"system", L"startup", nullptr));
    }
    // Antivirus.
    {
        std::wstring avname = sec.av.empty() ? L"Microsoft Defender" : sec.av;
        std::wstring p = L"\"av\":" + JS(avname);
        if (!sec.avOn)            emit(reds, 25, L"avoff", L"red", p, L"system", L"security", nullptr);
        else if (!sec.avUpToDate) emit(oranges, 8, L"avstale", L"orange", p, L"system", L"security", nullptr);
        else                      greens.push_back(HF(L"avok", L"green", p, L"system", L"security", nullptr));
    }
    // Firewall (profiles enabled, 0..3).
    {
        std::wstring p = L"\"n\":" + std::to_wstring(sec.fwOn);
        if (sec.fwOn == 0)     emit(reds, 18, L"fwoff", L"red", p, L"system", L"security", nullptr);
        else if (sec.fwOn < 3) emit(oranges, 8, L"fwsome", L"orange", p, L"system", L"security", nullptr);
        else                   greens.push_back(HF(L"fwok", L"green", L"", L"system", L"security", nullptr));
    }
    // UAC.
    if (!sec.uac) emit(oranges, 10, L"uacoff", L"orange", L"", L"system", L"security", nullptr);
    // Pending reboot.
    if (sec.pendingReboot) emit(oranges, 6, L"reboot", L"orange", L"", L"system", L"security", nullptr);
    // Restore points.
    if (restore.empty()) emit(oranges, 8, L"norestore", L"orange", L"", L"system", L"restore", L"createrestore");
    else                 greens.push_back(HF(L"restoreok", L"green", L"", L"system", L"restore", nullptr));
    // BitLocker (only when known).
    if (sec.bitlocker == L"Off")     emit(oranges, 5, L"bloff", L"orange", L"", L"system", L"security", nullptr);
    else if (sec.bitlocker == L"On") greens.push_back(HF(L"blok", L"green", L"", L"system", L"security", nullptr));

    if (score < 0) score = 0;
    if (score > 100) score = 100;
    const wchar_t* grade = score >= 85 ? L"good" : (score >= 60 ? L"fair" : L"poor");

    std::wstring o = L"{\"type\":\"health\",\"data\":{\"score\":" + std::to_wstring(score) +
                     L",\"grade\":\"" + grade + L"\",\"findings\":[";
    bool first = true;
    auto dump = [&](std::vector<std::wstring>& v) { for (auto& s : v) { if (!first) o += L","; o += s; first = false; } };
    dump(reds); dump(oranges); dump(greens);
    o += L"]}}";
    return o;
}

// ===========================================================================
// Install engine: elevation, restore point, download, install, reboot/resume
// ===========================================================================
static std::wstring ExePathFull() { wchar_t b[MAX_PATH]; GetModuleFileNameW(nullptr, b, MAX_PATH); return b; }
static std::wstring ExeDir() { std::wstring p = ExePathFull(); size_t s = p.find_last_of(L"\\/"); return s == std::wstring::npos ? L"." : p.substr(0, s); }

// ===========================================================================
// Self-contained installer (--install / --uninstall): copies to Program Files,
// creates Start Menu + Desktop shortcuts, and a real Add/Remove Programs entry.
// ===========================================================================
static std::wstring ProgDataDir();  // defined below
static std::wstring InstallDir() {
    wchar_t pf[MAX_PATH] = L"C:\\Program Files"; SHGetFolderPathW(nullptr, CSIDL_PROGRAM_FILES, nullptr, 0, pf);
    return std::wstring(pf) + L"\\Butler";
}
static const wchar_t* kArpKey = L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Butler";
static bool CreateShortcut(const std::wstring& target, const std::wstring& lnk, const std::wstring& desc) {
    IShellLinkW* sl = nullptr;
    if (FAILED(CoCreateInstance(__uuidof(ShellLink), nullptr, CLSCTX_INPROC_SERVER, __uuidof(IShellLinkW), (void**)&sl)) || !sl) return false;
    sl->SetPath(target.c_str());
    std::wstring dir = target.substr(0, target.find_last_of(L"\\"));
    sl->SetWorkingDirectory(dir.c_str());
    sl->SetDescription(desc.c_str());
    sl->SetIconLocation(target.c_str(), 0);
    IPersistFile* pf = nullptr; bool ok = false;
    if (SUCCEEDED(sl->QueryInterface(__uuidof(IPersistFile), (void**)&pf)) && pf) { ok = SUCCEEDED(pf->Save(lnk.c_str(), TRUE)); pf->Release(); }
    sl->Release(); return ok;
}
static int InstallApp() {
    std::wstring dir = InstallDir(); CreateDirectoryW(dir.c_str(), nullptr);
    std::wstring dst = dir + L"\\Butler.exe", self = ExePathFull();
    if (_wcsicmp(self.c_str(), dst.c_str()) != 0 && !CopyFileW(self.c_str(), dst.c_str(), FALSE)) {
        MessageBoxW(nullptr, L"Could not copy Butler to Program Files.\nPlease run this installer as administrator.",
                    L"Butler Setup", MB_OK | MB_ICONERROR);
        return 1;
    }
    wchar_t p[MAX_PATH];
    if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_COMMON_PROGRAMS, nullptr, 0, p)))
        CreateShortcut(dst, std::wstring(p) + L"\\Butler.lnk", APP_NAME L" - " APP_TAGLINE);
    if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_COMMON_DESKTOPDIRECTORY, nullptr, 0, p)))
        CreateShortcut(dst, std::wstring(p) + L"\\Butler.lnk", APP_NAME L" - " APP_TAGLINE);
    HKEY k;
    if (RegCreateKeyExW(HKEY_LOCAL_MACHINE, kArpKey, 0, nullptr, 0, KEY_WRITE, nullptr, &k, nullptr) == ERROR_SUCCESS) {
        auto S = [&](const wchar_t* n, const std::wstring& v) { RegSetValueExW(k, n, 0, REG_SZ, (const BYTE*)v.c_str(), (DWORD)((v.size() + 1) * sizeof(wchar_t))); };
        S(L"DisplayName", APP_NAME); S(L"DisplayVersion", APP_VERSTR); S(L"Publisher", APP_NAME);
        S(L"DisplayIcon", dst); S(L"InstallLocation", dir);
        S(L"UninstallString", L"\"" + dst + L"\" --uninstall");
        DWORD one = 1; RegSetValueExW(k, L"NoModify", 0, REG_DWORD, (const BYTE*)&one, 4);
        RegSetValueExW(k, L"NoRepair", 0, REG_DWORD, (const BYTE*)&one, 4);
        DWORD est = 0; HANDLE f = CreateFileW(dst.c_str(), 0, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
        if (f != INVALID_HANDLE_VALUE) { LARGE_INTEGER li; if (GetFileSizeEx(f, &li)) est = (DWORD)(li.QuadPart / 1024); CloseHandle(f); }
        RegSetValueExW(k, L"EstimatedSize", 0, REG_DWORD, (const BYTE*)&est, 4);
        RegCloseKey(k);
    }
    if (MessageBoxW(nullptr, APP_NAME L" " APP_VERSION L" was installed.\n\nStart-menu and desktop shortcuts were created.\nLaunch it now?",
                    L"Butler Setup", MB_YESNO | MB_ICONINFORMATION) == IDYES)
        ShellExecuteW(nullptr, L"open", dst.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    return 0;
}
static int UninstallApp() {
    if (MessageBoxW(nullptr, L"Remove " APP_NAME L" " APP_VERSION L" from this PC?", L"Butler Uninstall",
                    MB_YESNO | MB_ICONQUESTION) != IDYES) return 0;
    wchar_t p[MAX_PATH];
    if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_COMMON_PROGRAMS, nullptr, 0, p))) DeleteFileW((std::wstring(p) + L"\\Butler.lnk").c_str());
    if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_COMMON_DESKTOPDIRECTORY, nullptr, 0, p))) DeleteFileW((std::wstring(p) + L"\\Butler.lnk").c_str());
    RegDeleteTreeW(HKEY_LOCAL_MACHINE, kArpKey);
    RegDeleteTreeW(HKEY_CURRENT_USER, L"Software\\Butler");                 // settings
    // remove scheduled health check + ProgramData; self-delete the install dir
    std::wstring dir = InstallDir(), pdata = ProgDataDir();
    std::wstring cmd = L"cmd /c \"schtasks /delete /tn Butler_HealthCheck /f >nul 2>&1 & ping 127.0.0.1 -n 3 >nul "
                       L"& rmdir /s /q \"" + pdata + L"\" >nul 2>&1 & rmdir /s /q \"" + dir + L"\"\"";
    STARTUPINFOW si{}; si.cb = sizeof(si); si.dwFlags = STARTF_USESHOWWINDOW; si.wShowWindow = SW_HIDE; PROCESS_INFORMATION pi{};
    std::wstring c = cmd;
    if (CreateProcessW(nullptr, c.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) { CloseHandle(pi.hThread); CloseHandle(pi.hProcess); }
    MessageBoxW(nullptr, APP_NAME L" has been removed.", L"Butler Uninstall", MB_OK | MB_ICONINFORMATION);
    return 0;
}
static std::wstring ProgDataDir() {
    wchar_t* p = nullptr; std::wstring dir = L"C:\\ProgramData";
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_ProgramData, 0, nullptr, &p)) && p) { dir = p; CoTaskMemFree(p); }
    dir += L"\\Butler"; CreateDirectoryW(dir.c_str(), nullptr); return dir;
}
static bool IsElevated() {
    BOOL elevated = FALSE; HANDLE tok = nullptr;
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tok)) {
        TOKEN_ELEVATION te; DWORD cb = sizeof(te);
        if (GetTokenInformation(tok, TokenElevation, &te, sizeof(te), &cb)) elevated = te.TokenIsElevated;
        CloseHandle(tok);
    }
    return elevated == TRUE;
}
static bool RelaunchElevated(const std::wstring& args) {
    SHELLEXECUTEINFOW sei{}; sei.cbSize = sizeof(sei); sei.lpVerb = L"runas";
    std::wstring exe = ExePathFull(); sei.lpFile = exe.c_str(); sei.lpParameters = args.c_str();
    sei.nShow = SW_SHOWNORMAL;
    return ShellExecuteExW(&sei) == TRUE;
}

// System Restore point via dynamically-loaded SRSetRestorePointW (needs admin).
static bool CreateRestorePoint(const std::wstring& desc) {
    HMODULE h = LoadLibraryW(L"srclient.dll");
    if (!h) return false;
    typedef BOOL (WINAPI *PFN)(PRESTOREPOINTINFOW, PSTATEMGRSTATUS);
    PFN fn = (PFN)GetProcAddress(h, "SRSetRestorePointW");
    bool ok = false;
    if (fn) {
        RESTOREPOINTINFOW info{}; STATEMGRSTATUS st{};
        info.dwEventType = BEGIN_SYSTEM_CHANGE;
        info.dwRestorePtType = DEVICE_DRIVER_INSTALL;
        info.llSequenceNumber = 0;
        wcsncpy_s(info.szDescription, desc.c_str(), _TRUNCATE);
        ok = fn(&info, &st) && st.nStatus == ERROR_SUCCESS;
    }
    FreeLibrary(h);
    return ok;
}

static bool DownloadToFile(const std::wstring& url, const std::wstring& dest) {
    std::string body;
    if (!HttpRequest(L"GET", url, "", nullptr, body) || body.empty()) return false;
    HANDLE f = CreateFileW(dest.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE) return false;
    DWORD wr = 0; BOOL w = WriteFile(f, body.data(), (DWORD)body.size(), &wr, nullptr);
    CloseHandle(f);
    return w && wr == body.size();
}
// Run a process, wait, return exit code (-1 on launch failure).
static DWORD RunProcess(const std::wstring& cmdline) {
    STARTUPINFOW si{}; si.cb = sizeof(si); si.dwFlags = STARTF_USESHOWWINDOW; si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi{};
    std::wstring cmd = cmdline;
    if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi))
        return (DWORD)-1;
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0; GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    return code;
}
// Download + install one update. Returns true on success; sets needsReboot.
// Force-install every INF under a folder onto matching present devices, even if
// Windows would otherwise keep its current driver (DIIRFLAG_FORCE_INF). Returns
// how many actually applied; sets reboot if any needs a restart.
static int ForceInstallInfs(const std::wstring& root, bool& reboot) {
    reboot = false; int applied = 0;
    std::vector<std::wstring> dirs{ root };
    while (!dirs.empty()) {
        std::wstring d = dirs.back(); dirs.pop_back();
        WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW((d + L"\\*").c_str(), &fd);
        if (h == INVALID_HANDLE_VALUE) continue;
        do {
            std::wstring n = fd.cFileName; if (n == L"." || n == L"..") continue;
            std::wstring full = d + L"\\" + n;
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) { dirs.push_back(full); continue; }
            std::wstring low = n; std::transform(low.begin(), low.end(), low.begin(), towlower);
            if (low.size() > 4 && low.substr(low.size() - 4) == L".inf") {
                BOOL rb = FALSE;
                if (DiInstallDriverW(nullptr, full.c_str(), DIIRFLAG_FORCE_INF, &rb)) { applied++; if (rb) reboot = true; }
            }
        } while (FindNextFileW(h, &fd));
        FindClose(h);
    }
    return applied;
}
// Force the new driver onto THE specific device (by hardware id), overriding
// Windows' ranking. This is what actually replaces an in-use GPU/chipset driver
// (DiInstallDriver only stages to the store). Tries each extracted INF.
static bool ForceUpdateDevice(const std::wstring& hwId, const std::wstring& root, bool& reboot) {
    reboot = false; if (hwId.empty()) return false;
    std::vector<std::wstring> infs, dirs{ root };
    while (!dirs.empty()) {
        std::wstring d = dirs.back(); dirs.pop_back();
        WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW((d + L"\\*").c_str(), &fd);
        if (h == INVALID_HANDLE_VALUE) continue;
        do {
            std::wstring n = fd.cFileName; if (n == L"." || n == L"..") continue;
            std::wstring full = d + L"\\" + n;
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) dirs.push_back(full);
            else { std::wstring low = n; std::transform(low.begin(), low.end(), low.begin(), towlower);
                if (low.size() > 4 && low.substr(low.size() - 4) == L".inf") infs.push_back(full); }
        } while (FindNextFileW(h, &fd));
        FindClose(h);
    }
    for (auto& inf : infs) {
        BOOL rb = FALSE;
        if (UpdateDriverForPlugAndPlayDevicesW(nullptr, hwId.c_str(), inf.c_str(),
                INSTALLFLAG_FORCE | INSTALLFLAG_NONINTERACTIVE, &rb)) { if (rb) reboot = true; return true; }
    }
    return false;
}
// Read the CURRENT (live) driver version of the present device matching hwId,
// so we can verify an install actually took effect (laptop GPUs/OEM often refuse
// catalog drivers even when the install API reports success).
static std::wstring GetDeviceDriverVersion(const std::wstring& hwId) {
    if (hwId.empty()) return L"";
    HDEVINFO h = SetupDiGetClassDevsW(nullptr, nullptr, nullptr, DIGCF_ALLCLASSES | DIGCF_PRESENT);
    if (h == INVALID_HANDLE_VALUE) return L"";
    std::wstring result, target = hwId; std::transform(target.begin(), target.end(), target.begin(), towlower);
    SP_DEVINFO_DATA d{ sizeof(d) };
    for (DWORD i = 0; SetupDiEnumDeviceInfo(h, i, &d); ++i) {
        std::wstring ids = GetHardwareIds(h, &d); std::transform(ids.begin(), ids.end(), ids.begin(), towlower);
        if (ids.find(target) == std::wstring::npos) continue;
        DEVPROPTYPE t = 0; wchar_t buf[128] = L""; DWORD req = 0;
        if (SetupDiGetDevicePropertyW(h, &d, &DEVPKEY_Device_DriverVersion, &t, (PBYTE)buf, sizeof(buf), &req, 0)) result = buf;
        break;
    }
    SetupDiDestroyDeviceInfoList(h);
    return result;
}
static bool InstallUpdate(const DriverInfo& d, bool& needsReboot, std::wstring& logLine) {
    needsReboot = false;
    std::wstring fileUrl;
    if (!ResolveDownloadUrl(d.updateId, fileUrl)) { logLine = L"could not resolve download URL"; return false; }
    std::wstring tmp = ProgDataDir() + L"\\dl"; CreateDirectoryW(tmp.c_str(), nullptr);
    std::wstring fname = fileUrl.substr(fileUrl.find_last_of(L'/') + 1);
    std::wstring local = tmp + L"\\" + fname;
    if (!DownloadToFile(fileUrl, local)) { logLine = L"download failed: " + fileUrl; return false; }

    std::wstring lower = local; std::transform(lower.begin(), lower.end(), lower.begin(), towlower);
    if (lower.size() > 4 && lower.substr(lower.size() - 4) == L".cab") {
        // Driver package: expand, stage to the store, then FORCE the driver onto
        // the actual device by hardware id (UpdateDriverForPlugAndPlayDevices) so
        // it really replaces Windows' current driver - merely staging does not.
        std::wstring outdir = local + L".d"; CreateDirectoryW(outdir.c_str(), nullptr);
        RunProcess(L"expand.exe \"" + local + L"\" -F:* \"" + outdir + L"\"");
        RunProcess(L"pnputil.exe /add-driver \"" + outdir + L"\\*.inf\" /subdirs");  // stage to driver store
        bool rb = false;
        ForceUpdateDevice(d.hwId, outdir, rb);   // try to bind the new driver to the device
        ForceInstallInfs(outdir, rb);            // also try whole-package force as a fallback
        needsReboot = rb;
        // VERIFY it actually took: did the device's live driver version become the target?
        std::wstring nowVer = GetDeviceDriverVersion(d.hwId);
        if (!nowVer.empty() && nowVer == d.latest) { logLine = L"installed"; return true; }
        if (rb) { logLine = L"installed - restart needed to take effect"; return true; }
        logLine = L"kept - Windows/OEM refused the catalog driver (use the vendor tool in Sources)";
        return false;
    }
    DWORD rc = 0;
    if (lower.size() > 4 && lower.substr(lower.size() - 4) == L".exe") {
        rc = RunProcess(L"\"" + local + L"\" /s");
    } else if (lower.size() > 4 && lower.substr(lower.size() - 4) == L".msi") {
        rc = RunProcess(L"msiexec.exe /i \"" + local + L"\" /qn /norestart");
    } else { logLine = L"unsupported package: " + fname; return false; }
    needsReboot = (rc == 3010);
    logLine = (rc == 0) ? L"installed" : (rc == 3010) ? L"installed - restart needed"
            : (rc == (DWORD)-1) ? L"failed to launch the installer" : L"may not have applied (code " + std::to_wstring(rc) + L")";
    return rc == 0 || rc == 3010;
}

static void SetRunOnceResume(bool on) {
    HKEY k;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce",
                      0, KEY_SET_VALUE, &k) == ERROR_SUCCESS) {
        if (on) {
            std::wstring cmd = L"\"" + ExePathFull() + L"\" --resume";
            RegSetValueExW(k, L"ButlerResume", 0, REG_SZ, (const BYTE*)cmd.c_str(),
                           (DWORD)((cmd.size() + 1) * sizeof(wchar_t)));
        } else RegDeleteValueW(k, L"ButlerResume");
        RegCloseKey(k);
    }
}
static bool RebootSystem() {
    HANDLE tok; TOKEN_PRIVILEGES tp{};
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &tok)) {
        LookupPrivilegeValueW(nullptr, SE_SHUTDOWN_NAME, &tp.Privileges[0].Luid);
        tp.PrivilegeCount = 1; tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
        AdjustTokenPrivileges(tok, FALSE, &tp, 0, nullptr, nullptr); CloseHandle(tok);
    }
    return InitiateSystemShutdownExW(nullptr, (LPWSTR)L"Butler is restarting to finish driver installation.",
                                     5, TRUE, TRUE,
                                     SHTDN_REASON_MAJOR_HARDWARE | SHTDN_REASON_MINOR_INSTALLATION) == TRUE;
}

// ===========================================================================
// HTML report export (for the Export button)
// ===========================================================================
static std::wstring HEsc(const std::wstring& s) {
    std::wstring o; for (wchar_t c : s) { if (c == L'&') o += L"&amp;"; else if (c == L'<') o += L"&lt;"; else if (c == L'>') o += L"&gt;"; else o += c; } return o;
}
static bool WriteUtf8(const std::wstring& path, const std::wstring& text) {
    int len = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), -1, nullptr, 0, nullptr, nullptr);
    std::string u(len > 0 ? len - 1 : 0, '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.c_str(), -1, u.data(), len, nullptr, nullptr);
    HANDLE f = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE) return false;
    DWORD wr; WriteFile(f, u.data(), (DWORD)u.size(), &wr, nullptr); CloseHandle(f); return true;
}
static bool WriteReport(const ScanResult& r, const std::wstring& path) {
    std::wstring h = L"<!doctype html><meta charset='utf-8'><title>Driver Report</title>";
    h += L"<style>body{font-family:Segoe UI,Arial,sans-serif;margin:24px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #ccc;padding:4px 8px;text-align:left}th{background:#f3f3f3}.w{color:#b06000}</style>";
    h += L"<h1>Driver Scan Report</h1><p>" + HEsc(r.model) + L"<br>BIOS " + HEsc(r.bios) + L" (" + HEsc(r.biosDate) + L")<br>" + HEsc(r.os) + L"<br>Scanned " + HEsc(r.scanned) + L"</p>";
    h += L"<h2>Updates available</h2><table><tr><th>Device</th><th>Installed</th><th>Latest</th><th>Date</th></tr>";
    for (const auto& d : r.drivers) if (d.verdict == L"UPDATE AVAILABLE")
        h += L"<tr><td class='w'>" + HEsc(d.device) + L"</td><td>" + HEsc(d.version) + L"</td><td><b>" + HEsc(d.latest) + L"</b></td><td>" + HEsc(d.latestDate) + L"</td></tr>";
    h += L"</table><h2>All drivers</h2><table><tr><th>Device</th><th>Class</th><th>Installed</th><th>Latest</th><th>Verdict</th><th>Source</th></tr>";
    for (const auto& d : r.drivers)
        h += L"<tr><td>" + HEsc(d.device) + L"</td><td>" + HEsc(d.devClass) + L"</td><td>" + HEsc(d.version) + L"</td><td>" + HEsc(d.latest) + L"</td><td>" + HEsc(d.verdict) + L"</td><td>" + HEsc(d.source) + L"</td></tr>";
    h += L"</table>";
    int len = WideCharToMultiByte(CP_UTF8, 0, h.c_str(), -1, nullptr, 0, nullptr, nullptr);
    std::string u(len > 0 ? len - 1 : 0, '\0'); WideCharToMultiByte(CP_UTF8, 0, h.c_str(), -1, u.data(), len, nullptr, nullptr);
    HANDLE f = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE) return false;
    const unsigned char bom[] = {0xEF, 0xBB, 0xBF}; DWORD wr;
    WriteFile(f, bom, 3, &wr, nullptr); WriteFile(f, u.data(), (DWORD)u.size(), &wr, nullptr); CloseHandle(f);
    return true;
}

// ===========================================================================
// Performance / Battery / Windows Update / Cleanup / Driver backup / Net diag
// ===========================================================================
static std::wstring PerfJson() {
    MEMORYSTATUSEX ms{ sizeof(ms) }; GlobalMemoryStatusEx(&ms);
    FILETIME i0, k0, u0, i1, k1, u1; GetSystemTimes(&i0, &k0, &u0); Sleep(300); GetSystemTimes(&i1, &k1, &u1);
    auto d = [](FILETIME a, FILETIME b) { ULARGE_INTEGER x, y; x.LowPart = a.dwLowDateTime; x.HighPart = a.dwHighDateTime; y.LowPart = b.dwLowDateTime; y.HighPart = b.dwHighDateTime; return (double)(y.QuadPart - x.QuadPart); };
    double idle = d(i0, i1), tot = d(k0, k1) + d(u0, u1); int cpu = tot > 0 ? (int)((1.0 - idle / tot) * 100.0 + 0.5) : 0;
    DWORD pids[2048], cb = 0; std::vector<std::pair<SIZE_T, std::wstring>> procs;
    if (EnumProcesses(pids, sizeof(pids), &cb)) {
        for (int i = 0; i < (int)(cb / sizeof(DWORD)); ++i) {
            if (!pids[i]) continue;
            HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, FALSE, pids[i]);
            if (!h) continue;
            PROCESS_MEMORY_COUNTERS pmc; wchar_t name[MAX_PATH] = L"";
            if (GetProcessMemoryInfo(h, &pmc, sizeof(pmc)) && GetModuleBaseNameW(h, nullptr, name, MAX_PATH))
                procs.push_back({ pmc.WorkingSetSize, name });
            CloseHandle(h);
        }
    }
    std::sort(procs.begin(), procs.end(), [](auto& a, auto& b) { return a.first > b.first; });
    std::wstring o = L"{\"type\":\"perf\",\"data\":{\"cpu\":" + std::to_wstring(cpu) +
        L",\"ramTotal\":" + std::to_wstring(ms.ullTotalPhys / 1048576) +
        L",\"ramUsed\":" + std::to_wstring((ms.ullTotalPhys - ms.ullAvailPhys) / 1048576) +
        L",\"ramPct\":" + std::to_wstring(ms.dwMemoryLoad) + L",\"procs\":[";
    for (int i = 0; i < (int)procs.size() && i < 7; ++i) { if (i) o += L","; o += L"{\"name\":" + JS(procs[i].second) + L",\"memMb\":" + std::to_wstring(procs[i].first / 1048576) + L"}"; }
    return o + L"]}}";
}
// Disk health (S.M.A.R.T.). Win32_DiskDrive.Status reflects the SMART verdict:
// "OK" healthy, else "Pred Fail"/"Degraded"/"Error". Caller inits COM.
static std::wstring DiskHealthJson() {
    std::wstring o = L"{\"type\":\"diskhealth\",\"data\":[";
    std::vector<std::vector<std::wstring>> r;
    if (WmiQuery(L"ROOT\\CIMV2", L"SELECT Model,Status,Size,MediaType FROM Win32_DiskDrive",
                 { L"Model", L"Status", L"Size", L"MediaType" }, r)) {
        bool first = true;
        for (auto& row : r) {
            if (row[0].empty()) continue;
            bool ok = (row[1] == L"OK" || row[1].empty());
            long long bytes = _wtoi64(row[2].c_str());
            int gb = (int)((bytes + 536870912LL) / 1073741824LL);
            std::wstring type = L"Internal";
            if (row[3].find(L"External") != std::wstring::npos) type = L"External";
            else if (row[3].find(L"Removable") != std::wstring::npos) type = L"Removable";
            if (!first) o += L","; first = false;
            o += L"{\"model\":" + JS(row[0]) + L",\"ok\":" + JB(ok) + L",\"status\":" + JS(row[1]) +
                 L",\"gb\":" + std::to_wstring(gb) + L",\"type\":" + JS(type) + L"}";
        }
    }
    return o + L"]}";
}
static std::wstring BatteryJson() {  // caller inits COM (uses WMI ROOT\WMI)
    SYSTEM_POWER_STATUS sps{}; GetSystemPowerStatus(&sps);
    bool present = sps.BatteryFlag != 128 && sps.BatteryFlag != 255;
    int percent = sps.BatteryLifePercent <= 100 ? sps.BatteryLifePercent : -1;
    long designed = 0, full = 0;
    std::vector<std::vector<std::wstring>> r1, r2;
    if (WmiQuery(L"ROOT\\WMI", L"SELECT DesignedCapacity FROM BatteryStaticData", {L"DesignedCapacity"}, r1) && !r1.empty()) designed = _wtol(r1[0][0].c_str());
    if (WmiQuery(L"ROOT\\WMI", L"SELECT FullChargedCapacity FROM BatteryFullChargedCapacity", {L"FullChargedCapacity"}, r2) && !r2.empty()) full = _wtol(r2[0][0].c_str());
    int wear = (designed > 0 && full > 0) ? (int)((1.0 - (double)full / designed) * 100.0 + 0.5) : -1;
    return L"{\"type\":\"battery\",\"data\":{\"present\":" + JB(present) + L",\"percent\":" + std::to_wstring(percent) +
        L",\"ac\":" + JB(sps.ACLineStatus == 1) + L",\"designed\":" + std::to_wstring(designed) +
        L",\"full\":" + std::to_wstring(full) + L",\"wear\":" + std::to_wstring(wear) + L"}}";
}
static std::wstring WinUpdateJson() {  // caller inits COM (WUA)
    std::wstring last = RegStr(HKEY_LOCAL_MACHINE,
        L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\Results\\Detect", L"LastSuccessTime");
    int count = 0; std::vector<std::wstring> titles;
    IUpdateSession* sess = nullptr;
    if (SUCCEEDED(CoCreateInstance(__uuidof(UpdateSession), nullptr, CLSCTX_INPROC_SERVER, __uuidof(IUpdateSession), (void**)&sess)) && sess) {
        IUpdateSearcher* sr = nullptr;
        if (SUCCEEDED(sess->CreateUpdateSearcher(&sr)) && sr) {
            BSTR crit = SysAllocString(L"IsInstalled=0"); ISearchResult* res = nullptr;
            if (SUCCEEDED(sr->Search(crit, &res)) && res) {
                IUpdateCollection* c = nullptr;
                if (SUCCEEDED(res->get_Updates(&c)) && c) {
                    LONG n = 0; c->get_Count(&n); count = n;
                    for (LONG j = 0; j < n && j < 25; ++j) { IUpdate* u = nullptr; if (SUCCEEDED(c->get_Item(j, &u)) && u) { BSTR t = nullptr; if (SUCCEEDED(u->get_Title(&t)) && t) { titles.push_back(t); SysFreeString(t); } u->Release(); } }
                    c->Release();
                }
                res->Release();
            }
            SysFreeString(crit); sr->Release();
        }
        sess->Release();
    }
    std::wstring o = L"{\"type\":\"winupdate\",\"data\":{\"count\":" + std::to_wstring(count) + L",\"lastChecked\":" + JS(last) + L",\"items\":[";
    for (size_t i = 0; i < titles.size(); ++i) { if (i) o += L","; o += JS(titles[i]); }
    return o + L"]}}";
}
static unsigned long long FolderSize(const std::wstring& dir, int depth = 0) {
    if (depth > 6) return 0;
    unsigned long long total = 0; WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW((dir + L"\\*").c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return 0;
    do {
        std::wstring n = fd.cFileName; if (n == L"." || n == L"..") continue;
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) total += FolderSize(dir + L"\\" + n, depth + 1);
        else total += ((unsigned long long)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
    } while (FindNextFileW(h, &fd));
    FindClose(h); return total;
}
static std::wstring UserTemp() { wchar_t t[MAX_PATH]; GetTempPathW(MAX_PATH, t); std::wstring s = t; if (!s.empty() && s.back() == L'\\') s.pop_back(); return s; }
// GPU shader caches (safe to delete - regenerate on next launch). From kudu.
static std::vector<std::wstring> ShaderDirs() {
    wchar_t la[MAX_PATH] = L""; if (!GetEnvironmentVariableW(L"LOCALAPPDATA", la, MAX_PATH)) return {};
    std::wstring L = la;
    return { L + L"\\D3DSCache", L + L"\\NVIDIA\\DXCache", L + L"\\NVIDIA\\GLCache", L + L"\\AMD\\DxCache", L + L"\\AMD\\DxcCache" };
}
static unsigned long long ShaderSize() { unsigned long long t = 0; for (auto& d : ShaderDirs()) t += FolderSize(d); return t; }
static std::wstring CleanupJson() {
    SHQUERYRBINFO rb{ sizeof(rb) }; SHQueryRecycleBinW(nullptr, &rb);
    struct It { const wchar_t* name; unsigned long long sz; };
    std::vector<It> items = {
        {L"temp_user", FolderSize(UserTemp())},
        {L"temp_win", FolderSize(L"C:\\Windows\\Temp")},
        {L"wu_cache", FolderSize(L"C:\\Windows\\SoftwareDistribution\\Download")},
        {L"shader", ShaderSize()},
        {L"recycle", (unsigned long long)rb.i64Size},
    };
    unsigned long long total = 0; for (auto& i : items) total += i.sz;
    std::wstring o = L"{\"type\":\"cleanup\",\"data\":{\"items\":[";
    for (size_t i = 0; i < items.size(); ++i) { if (i) o += L","; o += L"{\"key\":" + JS(items[i].name) + L",\"sizeKb\":" + std::to_wstring(items[i].sz / 1024) + L"}"; }
    return o + L"],\"totalKb\":" + std::to_wstring(total / 1024) + L"}}";
}
static void DeleteContents(const std::wstring& dir, int depth = 0) {
    if (depth > 6) return;
    WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW((dir + L"\\*").c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return;
    do {
        std::wstring n = fd.cFileName; if (n == L"." || n == L"..") continue;
        std::wstring p = dir + L"\\" + n;
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) { DeleteContents(p, depth + 1); RemoveDirectoryW(p.c_str()); }
        else { SetFileAttributesW(p.c_str(), FILE_ATTRIBUTE_NORMAL); DeleteFileW(p.c_str()); }
    } while (FindNextFileW(h, &fd));
    FindClose(h);
}
static std::wstring DoCleanup() {
    DeleteContents(UserTemp());
    DeleteContents(L"C:\\Windows\\Temp");
    for (auto& d : ShaderDirs()) DeleteContents(d);  // GPU shader caches
    SHEmptyRecycleBinW(nullptr, nullptr, SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND);
    std::wstring j = CleanupJson(); j.replace(j.find(L"\"type\":\"cleanup\""), 16, L"\"type\":\"cleanupdone\"");
    return j;
}
static std::wstring DriverBackupJson() {
    wchar_t docs[MAX_PATH] = L""; SHGetFolderPathW(nullptr, CSIDL_PERSONAL, nullptr, 0, docs);
    std::wstring base = std::wstring(docs) + L"\\Butler Driver Backup";
    CreateDirectoryW(base.c_str(), nullptr);
    SYSTEMTIME st; GetLocalTime(&st);
    wchar_t sub[32]; swprintf_s(sub, L"\\%04d%02d%02d-%02d%02d%02d", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    std::wstring folder = base + sub; CreateDirectoryW(folder.c_str(), nullptr);
    DWORD rc = RunProcess(L"pnputil.exe /export-driver * \"" + folder + L"\"");
    return L"{\"type\":\"driverbackup\",\"ok\":" + JB(rc == 0) + L",\"path\":" + JS(folder) + L"}";
}
static int PingMs(DWORD ipNet) {
    HANDLE h = IcmpCreateFile(); if (h == INVALID_HANDLE_VALUE) return -1;
    char payload[1] = { 0 }; BYTE reply[sizeof(ICMP_ECHO_REPLY) + 8];
    DWORD r = IcmpSendEcho(h, ipNet, payload, 1, nullptr, reply, sizeof(reply), 1000);
    int ms = -1; if (r > 0) ms = (int)((ICMP_ECHO_REPLY*)reply)->RoundTripTime;
    IcmpCloseHandle(h); return ms;
}
static void WifiInfo(std::wstring& ssid, int& signal, int& rxMbps) {
    signal = -1; rxMbps = -1;
    HANDLE h = nullptr; DWORD ver = 0;
    if (WlanOpenHandle(2, nullptr, &ver, &h) != ERROR_SUCCESS) return;
    PWLAN_INTERFACE_INFO_LIST list = nullptr;
    if (WlanEnumInterfaces(h, nullptr, &list) == ERROR_SUCCESS && list) {
        for (DWORD i = 0; i < list->dwNumberOfItems; ++i) {
            if (list->InterfaceInfo[i].isState != wlan_interface_state_connected) continue;
            PWLAN_CONNECTION_ATTRIBUTES attr = nullptr; DWORD sz = 0; WLAN_OPCODE_VALUE_TYPE vt;
            if (WlanQueryInterface(h, &list->InterfaceInfo[i].InterfaceGuid, wlan_intf_opcode_current_connection,
                                   nullptr, &sz, (PVOID*)&attr, &vt) == ERROR_SUCCESS && attr) {
                auto& a = attr->wlanAssociationAttributes;
                ssid.assign((char*)a.dot11Ssid.ucSSID, (char*)a.dot11Ssid.ucSSID + a.dot11Ssid.uSSIDLength);
                // ucSSID is UTF-8/ASCII bytes; widen:
                std::string s((char*)a.dot11Ssid.ucSSID, a.dot11Ssid.uSSIDLength);
                int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
                std::wstring w(n, 0); MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), w.data(), n); ssid = w;
                signal = a.wlanSignalQuality;          // 0..100
                rxMbps = (int)(a.ulRxRate / 1000);     // kbps -> Mbps
                WlanFreeMemory(attr);
            }
            break;
        }
        WlanFreeMemory(list);
    }
    WlanCloseHandle(h, nullptr);
}
// One WinHTTP GET that reads until `deadline` (ms tick) and returns bytes read.
// Used by the duration-bounded speed test so it never hangs and can measure
// gigabit links. Discards the data (only counts bytes).
static long long SpeedDownloadUntil(const std::wstring& url, ULONGLONG deadline) {
    URL_COMPONENTS uc{}; uc.dwStructSize = sizeof(uc);
    wchar_t host[256] = L"", path[2048] = L"";
    uc.lpszHostName = host; uc.dwHostNameLength = 255;
    uc.lpszUrlPath = path; uc.dwUrlPathLength = 2047;
    if (!WinHttpCrackUrl(url.c_str(), 0, 0, &uc)) return 0;
    bool https = uc.nScheme == INTERNET_SCHEME_HTTPS;
    INTERNET_PORT port = uc.nPort ? uc.nPort : (https ? INTERNET_DEFAULT_HTTPS_PORT : INTERNET_DEFAULT_HTTP_PORT);
    HINTERNET hs = WinHttpOpen(L"Butler/3.0", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                               WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hs) return 0;
    WinHttpSetTimeouts(hs, 6000, 6000, 6000, 6000);
    long long total = 0;
    if (HINTERNET hc = WinHttpConnect(hs, host, port, 0)) {
        if (HINTERNET hr = WinHttpOpenRequest(hc, L"GET", path, nullptr, WINHTTP_NO_REFERER,
                                              WINHTTP_DEFAULT_ACCEPT_TYPES, https ? WINHTTP_FLAG_SECURE : 0)) {
            if (WinHttpSendRequest(hr, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
                WinHttpReceiveResponse(hr, nullptr)) {
                std::vector<char> buf(262144); DWORD avail = 0;
                do {
                    if (GetTickCount64() >= deadline) break;
                    if (!WinHttpQueryDataAvailable(hr, &avail) || avail == 0) break;
                    DWORD chunk = avail > buf.size() ? (DWORD)buf.size() : avail, rd = 0;
                    if (!WinHttpReadData(hr, buf.data(), chunk, &rd) || rd == 0) break;
                    total += rd;
                } while (true);
            }
            WinHttpCloseHandle(hr);
        }
        WinHttpCloseHandle(hc);
    }
    WinHttpCloseHandle(hs);
    return total;
}
// ===========================================================================
// App self-update: compare against butler.com and install the latest build
// ===========================================================================
static std::string HttpGetText(const std::wstring& url) {
    URL_COMPONENTS uc{}; uc.dwStructSize = sizeof(uc); wchar_t host[256] = L"", path[2048] = L"";
    uc.lpszHostName = host; uc.dwHostNameLength = 255; uc.lpszUrlPath = path; uc.dwUrlPathLength = 2047;
    std::string out; if (!WinHttpCrackUrl(url.c_str(), 0, 0, &uc)) return out;
    bool https = uc.nScheme == INTERNET_SCHEME_HTTPS; INTERNET_PORT port = uc.nPort ? uc.nPort : (https ? INTERNET_DEFAULT_HTTPS_PORT : INTERNET_DEFAULT_HTTP_PORT);
    HINTERNET hs = WinHttpOpen(L"Butler/3.0", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0); if (!hs) return out;
    WinHttpSetTimeouts(hs, 8000, 8000, 8000, 8000);
    if (HINTERNET hc = WinHttpConnect(hs, host, port, 0)) {
        if (HINTERNET hr = WinHttpOpenRequest(hc, L"GET", path, nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, https ? WINHTTP_FLAG_SECURE : 0)) {
            if (WinHttpSendRequest(hr, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) && WinHttpReceiveResponse(hr, nullptr)) {
                DWORD avail = 0; std::vector<char> buf(65536);
                do { if (!WinHttpQueryDataAvailable(hr, &avail) || avail == 0) break; DWORD chunk = avail > buf.size() ? (DWORD)buf.size() : avail, rd = 0;
                    if (!WinHttpReadData(hr, buf.data(), chunk, &rd) || rd == 0) break; out.append(buf.data(), rd); if (out.size() > 1000000) break; } while (true);
            }
            WinHttpCloseHandle(hr);
        }
        WinHttpCloseHandle(hc);
    }
    WinHttpCloseHandle(hs); return out;
}
static bool HttpDownloadFile(const std::wstring& url, const std::wstring& dest) {
    URL_COMPONENTS uc{}; uc.dwStructSize = sizeof(uc); wchar_t host[256] = L"", path[2048] = L"";
    uc.lpszHostName = host; uc.dwHostNameLength = 255; uc.lpszUrlPath = path; uc.dwUrlPathLength = 2047;
    if (!WinHttpCrackUrl(url.c_str(), 0, 0, &uc)) return false;
    bool https = uc.nScheme == INTERNET_SCHEME_HTTPS; INTERNET_PORT port = uc.nPort ? uc.nPort : (https ? INTERNET_DEFAULT_HTTPS_PORT : INTERNET_DEFAULT_HTTP_PORT);
    HINTERNET hs = WinHttpOpen(L"Butler/3.0", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0); if (!hs) return false;
    WinHttpSetTimeouts(hs, 15000, 15000, 30000, 30000); bool ok = false;
    if (HINTERNET hc = WinHttpConnect(hs, host, port, 0)) {
        if (HINTERNET hr = WinHttpOpenRequest(hc, L"GET", path, nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, https ? WINHTTP_FLAG_SECURE : 0)) {
            if (WinHttpSendRequest(hr, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) && WinHttpReceiveResponse(hr, nullptr)) {
                DWORD code = 0, cl = sizeof(code); WinHttpQueryHeaders(hr, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &code, &cl, WINHTTP_NO_HEADER_INDEX);
                if (code == 200) {
                    HANDLE f = CreateFileW(dest.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
                    if (f != INVALID_HANDLE_VALUE) { DWORD avail = 0; std::vector<char> buf(262144); ok = true;
                        do { if (!WinHttpQueryDataAvailable(hr, &avail) || avail == 0) break; DWORD chunk = avail > buf.size() ? (DWORD)buf.size() : avail, rd = 0;
                            if (!WinHttpReadData(hr, buf.data(), chunk, &rd) || rd == 0) break; DWORD wr; WriteFile(f, buf.data(), rd, &wr, nullptr); } while (true);
                        CloseHandle(f);
                    }
                }
            }
            WinHttpCloseHandle(hr);
        }
        WinHttpCloseHandle(hc);
    }
    WinHttpCloseHandle(hs); return ok;
}
static long long VerNum(const std::wstring& v) {
    long long parts[4] = { 0,0,0,0 }; int pi = 0; std::wstring cur;
    for (size_t i = 0; i <= v.size(); i++) { wchar_t c = i < v.size() ? v[i] : L'.';
        if (c == L'.') { if (pi < 4) parts[pi++] = _wtoll(cur.c_str()); cur.clear(); }
        else if (iswdigit(c)) cur += c; }
    return parts[0] * 1000000LL + parts[1] * 1000LL + parts[2];
}
static bool g_runUpdate = false;
static DWORD WINAPI UpdateCheckThread(LPVOID) {
    std::string body = HttpGetText(L"https://butler.com/version.js");
    std::wstring latest; size_t p = body.find("BUTLER_VERSION");
    if (p != std::string::npos) { size_t q = body.find('"', p);
        if (q != std::string::npos) { size_t e = body.find('"', q + 1);
            if (e != std::string::npos) { std::string s = body.substr(q + 1, e - q - 1); latest.assign(s.begin(), s.end()); } } }
    std::wstring cur = APP_VERSTR;
    bool newer = !latest.empty() && VerNum(latest) > VerNum(cur);
    PushJson(L"{\"type\":\"updatecheck\",\"current\":" + JS(cur) + L",\"latest\":" + JS(latest) + L",\"newer\":" + JB(newer) + L",\"ok\":" + JB(!latest.empty()) + L"}");
    g_runUpdate = false; return 0;
}
static DWORD WINAPI SelfUpdateThread(LPVOID) {
    wchar_t t[MAX_PATH]; GetTempPathW(MAX_PATH, t); std::wstring tmp = std::wstring(t) + L"Butler-Setup.exe";
    PushJson(L"{\"type\":\"updatestatus\",\"phase\":\"download\"}");
    bool ok = HttpDownloadFile(L"https://butler.com/downloads/Butler-Setup.exe", tmp);
    if (ok) {
        PushJson(L"{\"type\":\"updatedone\",\"ok\":true}");
        // Wait for this instance to close, kill any leftover, then run the setup
        // (its name contains "setup" so it self-installs; elevation is inherited).
        std::wstring args = L"/c ping 127.0.0.1 -n 3 >nul & taskkill /F /IM Butler.exe >nul 2>&1 & \"" + tmp + L"\"";
        ShellExecuteW(nullptr, L"open", L"cmd.exe", args.c_str(), nullptr, SW_HIDE);
    } else {
        PushJson(L"{\"type\":\"updatedone\",\"ok\":false}");
    }
    g_runUpdate = false; return 0;
}
// Deferred "update when I close Butler": download the setup now and arm it; the
// WM_DESTROY handler launches it as the app exits (no force-kill needed).
static bool g_updateOnExit = false;
static std::wstring g_updateSetupPath;
static DWORD WINAPI UpdateDownloadThread(LPVOID) {
    wchar_t t[MAX_PATH]; GetTempPathW(MAX_PATH, t); std::wstring tmp = std::wstring(t) + L"Butler-Setup.exe";
    PushJson(L"{\"type\":\"updatestatus\",\"phase\":\"download\"}");
    if (HttpDownloadFile(L"https://butler.com/downloads/Butler-Setup.exe", tmp)) {
        g_updateSetupPath = tmp; g_updateOnExit = true;
        PushJson(L"{\"type\":\"updatequeued\",\"ok\":true}");
    } else {
        PushJson(L"{\"type\":\"updatequeued\",\"ok\":false}");
    }
    g_runUpdate = false; return 0;
}
static std::wstring NetDiagJson() {
    std::wstring ssid; int signal = -1, rx = -1; WifiInfo(ssid, signal, rx);
    DWORD localN = 0, gwN = 0, base = 0;
    WSADATA w; WSAStartup(MAKEWORD(2, 2), &w);
    GetLocalNet(localN, gwN, base);
    int pgw = gwN ? PingMs(gwN) : -1;
    int pnet = PingMs(inet_addr("1.1.1.1"));
    // Download speed test: 6 PARALLEL streams from the Cachefly CDN for ~6 seconds
    // (duration-bounded, so it never hangs and can measure gigabit links). Each
    // thread re-downloads a 100 MB CDN file until the shared deadline. Cachefly
    // has POPs worldwide and doesn't block our user-agent (Cloudflare's __down
    // now 403s; OVH was too far for fast links).
    int downMbps = -1;
    {
        const int N = 6;
        const ULONGLONG t0 = GetTickCount64();
        const ULONGLONG deadline = t0 + 6000;
        std::vector<long long> got(N, 0);
        std::vector<std::thread> ts;
        for (int i = 0; i < N; ++i) ts.emplace_back([&got, i, deadline] {
            long long tot = 0;
            while (GetTickCount64() < deadline)
                tot += SpeedDownloadUntil(L"https://cachefly.cachefly.net/100mb.test", deadline);
            got[i] = tot;
        });
        for (auto& t : ts) t.join();
        ULONGLONG ms = GetTickCount64() - t0;
        long long total = 0; for (auto g : got) total += g;
        if (ms > 0 && total > 1000000) downMbps = (int)((double)total * 8.0 / 1000.0 / (double)ms);
    }
    WSACleanup();
    return L"{\"type\":\"netdiag\",\"data\":{\"ssid\":" + JS(ssid) + L",\"signal\":" + std::to_wstring(signal) +
        L",\"rx\":" + std::to_wstring(rx) + L",\"pingGw\":" + std::to_wstring(pgw) + L",\"pingNet\":" + std::to_wstring(pnet) +
        L",\"downMbps\":" + std::to_wstring(downMbps) + L"}}";
}
// ===========================================================================
// Duplicate-picture finder (Photos category)
// Groups image files by exact content: bucket by file size, then SHA-256 the
// candidates in each bucket. Identical hash => byte-identical duplicate.
// ===========================================================================
static bool HashFileHex(const std::wstring& path, std::string& hexOut) {
    HANDLE f = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                           OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
    if (f == INVALID_HANDLE_VALUE) return false;
    BCRYPT_ALG_HANDLE alg = nullptr; BCRYPT_HASH_HANDLE h = nullptr; bool ok = false;
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0) {
        DWORD objLen = 0, cb = 0;
        BCryptGetProperty(alg, BCRYPT_OBJECT_LENGTH, (PUCHAR)&objLen, sizeof(objLen), &cb, 0);
        std::vector<BYTE> obj(objLen);
        if (BCryptCreateHash(alg, &h, obj.data(), objLen, nullptr, 0, 0) == 0) {
            std::vector<BYTE> buf(1 << 20); DWORD rd = 0; ok = true;
            while (ReadFile(f, buf.data(), (DWORD)buf.size(), &rd, nullptr) && rd) {
                if (BCryptHashData(h, buf.data(), rd, 0) != 0) { ok = false; break; }
            }
            if (ok) {
                BYTE dig[32];
                if (BCryptFinishHash(h, dig, 32, 0) == 0) {
                    char hx[65]; for (int i = 0; i < 32; i++) sprintf_s(hx + i * 2, 3, "%02x", dig[i]);
                    hexOut = hx;
                } else ok = false;
            }
            BCryptDestroyHash(h);
        }
        BCryptCloseAlgorithmProvider(alg, 0);
    }
    CloseHandle(f); return ok;
}
static bool IsImageName(const std::wstring& name) {
    static const wchar_t* ext[] = { L".jpg",L".jpeg",L".png",L".gif",L".bmp",L".webp",L".tif",L".tiff",L".heic",L".jfif" };
    std::wstring n = name; std::transform(n.begin(), n.end(), n.begin(), towlower);
    for (auto e : ext) { size_t L = wcslen(e); if (n.size() > L && n.compare(n.size() - L, L, e) == 0) return true; }
    return false;
}
static void EnumImages(const std::wstring& dir, std::vector<std::pair<std::wstring, ULONGLONG>>& out, int depth = 0) {
    if (depth > 40 || out.size() > 60000) return;
    WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW((dir + L"\\*").c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return;
    do {
        std::wstring n = fd.cFileName; if (n == L"." || n == L"..") continue;
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) continue;
        std::wstring p = dir + L"\\" + n;
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) EnumImages(p, out, depth + 1);
        else if (IsImageName(n)) {
            ULONGLONG sz = ((ULONGLONG)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
            if (sz > 0) out.push_back({ p, sz });
        }
    } while (FindNextFileW(h, &fd));
    FindClose(h);
}
static std::string Base64(const BYTE* d, size_t n) {
    static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string o; o.reserve((n + 2) / 3 * 4);
    for (size_t i = 0; i < n; i += 3) {
        int v = d[i] << 16; if (i + 1 < n) v |= d[i + 1] << 8; if (i + 2 < n) v |= d[i + 2];
        o += T[(v >> 18) & 63]; o += T[(v >> 12) & 63];
        o += (i + 1 < n) ? T[(v >> 6) & 63] : '='; o += (i + 2 < n) ? T[v & 63] : '=';
    }
    return o;
}
// Real downscaled thumbnail via GDI+ (works for any size, unlike embedding raw
// bytes). maxDim caps the largest side; JPEG-encoded then base64 data URI.
static ULONG_PTR g_gdipTok = 0;
static void EnsureGdiplus() {
    if (!g_gdipTok) { Gdiplus::GdiplusStartupInput in; Gdiplus::GdiplusStartup(&g_gdipTok, &in, nullptr); }
}
static int GdipJpegEncoder(CLSID* out) {
    UINT num = 0, size = 0; Gdiplus::GetImageEncodersSize(&num, &size); if (!size) return -1;
    std::vector<BYTE> buf(size); auto* p = (Gdiplus::ImageCodecInfo*)buf.data();
    Gdiplus::GetImageEncoders(num, size, p);
    for (UINT i = 0; i < num; ++i) if (wcscmp(p[i].MimeType, L"image/jpeg") == 0) { *out = p[i].Clsid; return (int)i; }
    return -1;
}
static std::wstring EncodeBmpDataUri(Gdiplus::Bitmap* dst) {
    CLSID clsid; if (GdipJpegEncoder(&clsid) < 0) return L"";
    IStream* st = nullptr; if (CreateStreamOnHGlobal(nullptr, TRUE, &st) != S_OK) return L"";
    ULONG q = 82; Gdiplus::EncoderParameters ep; ep.Count = 1;
    ep.Parameter[0].Guid = Gdiplus::EncoderQuality; ep.Parameter[0].Type = Gdiplus::EncoderParameterValueTypeLong;
    ep.Parameter[0].NumberOfValues = 1; ep.Parameter[0].Value = &q;
    if (dst->Save(st, &clsid, &ep) != Gdiplus::Ok) { st->Release(); return L""; }
    HGLOBAL hg = nullptr; GetHGlobalFromStream(st, &hg);
    SIZE_T sz = GlobalSize(hg); BYTE* pdata = (BYTE*)GlobalLock(hg);
    std::string b64 = Base64(pdata, (size_t)sz); GlobalUnlock(hg); st->Release();
    return L"data:image/jpeg;base64," + std::wstring(b64.begin(), b64.end());
}
static std::wstring GdiThumbDataUri(const std::wstring& path, int maxDim) {
    EnsureGdiplus();
    Gdiplus::Bitmap src(path.c_str());
    if (src.GetLastStatus() != Gdiplus::Ok) return L"";
    UINT w = src.GetWidth(), h = src.GetHeight(); if (!w || !h) return L"";
    double sc = (double)maxDim / (w > h ? w : h); if (sc > 1.0) sc = 1.0;
    int tw = (int)(w * sc + 0.5), th = (int)(h * sc + 0.5); if (tw < 1) tw = 1; if (th < 1) th = 1;
    Gdiplus::Bitmap dst(tw, th, PixelFormat24bppRGB);
    { Gdiplus::Graphics g(&dst); g.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
      g.DrawImage(&src, 0, 0, tw, th); }
    return EncodeBmpDataUri(&dst);
}
// Decode via WIC - uses the installed codecs (HEIF/HEVC extensions decode HEIC,
// camera-RAW codecs decode RAW, etc.) which GDI+ does not support natively.
static std::wstring WicThumbDataUri(const std::wstring& path, int maxDim) {
    IWICImagingFactory* fac = nullptr;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&fac))) || !fac) return L"";
    std::wstring uri;
    IWICBitmapDecoder* dec = nullptr;
    if (SUCCEEDED(fac->CreateDecoderFromFilename(path.c_str(), nullptr, GENERIC_READ, WICDecodeMetadataCacheOnDemand, &dec)) && dec) {
        IWICBitmapFrameDecode* fr = nullptr;
        if (SUCCEEDED(dec->GetFrame(0, &fr)) && fr) {
            UINT w = 0, h = 0; fr->GetSize(&w, &h);
            if (w && h) {
                double sc = (double)maxDim / (w > h ? w : h); if (sc > 1.0) sc = 1.0;
                UINT tw = (UINT)(w * sc + 0.5), th = (UINT)(h * sc + 0.5); if (!tw) tw = 1; if (!th) th = 1;
                IWICBitmapScaler* sca = nullptr;
                if (SUCCEEDED(fac->CreateBitmapScaler(&sca)) && sca) {
                    if (SUCCEEDED(sca->Initialize(fr, tw, th, WICBitmapInterpolationModeFant))) {
                        IWICFormatConverter* cv = nullptr;
                        if (SUCCEEDED(fac->CreateFormatConverter(&cv)) && cv) {
                            if (SUCCEEDED(cv->Initialize(sca, GUID_WICPixelFormat24bppBGR, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeMedianCut))) {
                                EnsureGdiplus();
                                Gdiplus::Bitmap bmp(tw, th, PixelFormat24bppRGB);  // 24bppRGB is BGR in memory == WIC 24bppBGR
                                Gdiplus::Rect rc(0, 0, (INT)tw, (INT)th); Gdiplus::BitmapData bd;
                                if (bmp.LockBits(&rc, Gdiplus::ImageLockModeWrite, PixelFormat24bppRGB, &bd) == Gdiplus::Ok) {
                                    cv->CopyPixels(nullptr, bd.Stride, bd.Stride * th, (BYTE*)bd.Scan0);
                                    bmp.UnlockBits(&bd);
                                    uri = EncodeBmpDataUri(&bmp);
                                }
                            }
                            cv->Release();
                        }
                    }
                    sca->Release();
                }
            }
            fr->Release();
        }
        dec->Release();
    }
    fac->Release();
    return uri;
}
// Thumbnail via the Windows Shell thumbnail providers - handles HEIC/HEIF, RAW,
// PDF, video, etc. (anything with a registered provider), which GDI+ cannot.
static std::wstring ShellThumbDataUri(const std::wstring& path, int maxDim) {
    IShellItemImageFactory* f = nullptr;
    if (FAILED(SHCreateItemFromParsingName(path.c_str(), nullptr, IID_PPV_ARGS(&f))) || !f) return L"";
    SIZE sz = { maxDim, maxDim }; HBITMAP hb = nullptr;
    HRESULT hr = f->GetImage(sz, SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK, &hb);
    f->Release();
    if (FAILED(hr) || !hb) return L"";
    EnsureGdiplus();
    Gdiplus::Bitmap* bmp = Gdiplus::Bitmap::FromHBITMAP(hb, nullptr);
    DeleteObject(hb);
    if (!bmp) return L"";
    std::wstring uri = EncodeBmpDataUri(bmp); delete bmp; return uri;
}
static std::wstring ThumbDataUri(const std::wstring& path, ULONGLONG size) {
    std::wstring g = GdiThumbDataUri(path, 256);  // proper downscaled thumbnail
    if (!g.empty()) return g;
    g = WicThumbDataUri(path, 256);               // HEIC/RAW via installed WIC codecs
    if (!g.empty()) return g;
    g = ShellThumbDataUri(path, 256);             // last resort: shell thumbnail provider
    if (!g.empty()) return g;
    if (size > 2u * 1024 * 1024) return L"";  // fallback: embed small files raw
    HANDLE f = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    if (f == INVALID_HANDLE_VALUE) return L"";
    std::vector<BYTE> buf((size_t)size); DWORD rd = 0;
    BOOL ok = ReadFile(f, buf.data(), (DWORD)size, &rd, nullptr); CloseHandle(f);
    if (!ok || rd == 0) return L"";
    std::string b64 = Base64(buf.data(), rd);
    std::wstring lp = path; std::transform(lp.begin(), lp.end(), lp.begin(), towlower);
    std::wstring mime = L"image/jpeg";
    if (lp.find(L".png") != std::wstring::npos) mime = L"image/png";
    else if (lp.find(L".gif") != std::wstring::npos) mime = L"image/gif";
    else if (lp.find(L".webp") != std::wstring::npos) mime = L"image/webp";
    else if (lp.find(L".bmp") != std::wstring::npos) mime = L"image/bmp";
    return L"data:" + mime + L";base64," + std::wstring(b64.begin(), b64.end());
}
// Full-resolution data URI for the in-app full-screen viewer (higher cap than the
// grid thumbnail). Returns "" if the file is missing or too large.
static std::wstring FullImageDataUri(const std::wstring& path) {
    std::wstring g = GdiThumbDataUri(path, 2000);  // crisp full-screen view, but light
    if (!g.empty()) return g;
    g = WicThumbDataUri(path, 2000);               // HEIC/RAW via installed WIC codecs
    if (!g.empty()) return g;
    g = ShellThumbDataUri(path, 1920);             // last resort: shell thumbnail provider
    if (!g.empty()) return g;
    // Fallback (e.g. WebP, which GDI+ doesn't decode): embed raw bytes up to 40 MB.
    HANDLE f = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    if (f == INVALID_HANDLE_VALUE) return L"";
    LARGE_INTEGER sz{}; GetFileSizeEx(f, &sz);
    if (sz.QuadPart <= 0 || sz.QuadPart > 40ll * 1024 * 1024) { CloseHandle(f); return L""; }
    std::vector<BYTE> buf((size_t)sz.QuadPart); DWORD rd = 0;
    BOOL ok = ReadFile(f, buf.data(), (DWORD)sz.QuadPart, &rd, nullptr); CloseHandle(f);
    if (!ok || rd == 0) return L"";
    std::string b64 = Base64(buf.data(), rd);
    std::wstring lp = path; std::transform(lp.begin(), lp.end(), lp.begin(), towlower);
    std::wstring mime = L"image/jpeg";
    if (lp.find(L".png") != std::wstring::npos) mime = L"image/png";
    else if (lp.find(L".gif") != std::wstring::npos) mime = L"image/gif";
    else if (lp.find(L".webp") != std::wstring::npos) mime = L"image/webp";
    else if (lp.find(L".bmp") != std::wstring::npos) mime = L"image/bmp";
    return L"data:" + mime + L";base64," + std::wstring(b64.begin(), b64.end());
}
static int g_dupMax = 500;  // max duplicate groups to display (0 = all)
static std::wstring DupScanJson(const std::wstring& folder) {
    std::vector<std::pair<std::wstring, ULONGLONG>> files; EnumImages(folder, files);
    std::map<ULONGLONG, std::vector<std::wstring>> bySize;
    for (auto& f : files) bySize[f.second].push_back(f.first);
    struct Grp { ULONGLONG size; std::vector<std::wstring> files; };
    std::vector<Grp> groups;
    for (auto& kv : bySize) {
        if (kv.second.size() < 2) continue;
        std::map<std::string, std::vector<std::wstring>> byHash;
        for (auto& p : kv.second) { std::string hx; if (HashFileHex(p, hx)) byHash[hx].push_back(p); }
        for (auto& hv : byHash) if (hv.second.size() > 1) groups.push_back({ kv.first, hv.second });
    }
    ULONGLONG waste = 0; for (auto& g : groups) waste += g.size * (g.files.size() - 1);
    std::sort(groups.begin(), groups.end(), [](const Grp& a, const Grp& b) { return a.size > b.size; });
    std::wstring o = L"{\"type\":\"dupscan\",\"data\":{\"folder\":" + JS(folder) +
        L",\"wasteKb\":" + std::to_wstring(waste / 1024) + L",\"total\":" + std::to_wstring((int)groups.size()) + L",\"groups\":[";
    int shown = 0;
    for (auto& g : groups) {
        if (g_dupMax > 0 && shown >= g_dupMax) break; if (shown) o += L",";
        o += L"{\"sizeKb\":" + std::to_wstring(g.size / 1024) +
             L",\"thumb\":" + JS(ThumbDataUri(g.files[0], g.size)) + L",\"files\":[";
        for (size_t i = 0; i < g.files.size(); ++i) { if (i) o += L","; o += L"{\"path\":" + JS(g.files[i]) + L"}"; }
        o += L"]}"; shown++;
    }
    o += L"]}}";
    return o;
}
static void DupDelete(const std::wstring& pipePaths) {
    std::wstring buf; size_t p = 0;
    while (p < pipePaths.size()) {
        size_t c = pipePaths.find(L'|', p);
        std::wstring one = pipePaths.substr(p, c == std::wstring::npos ? std::wstring::npos : c - p);
        if (!one.empty()) { buf += one; buf.push_back(L'\0'); }
        if (c == std::wstring::npos) break; p = c + 1;
    }
    if (buf.empty()) return; buf.push_back(L'\0');  // double-null terminate
    SHFILEOPSTRUCTW op{}; op.wFunc = FO_DELETE; op.pFrom = buf.c_str();
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT;  // ALLOWUNDO => Recycle Bin
    SHFileOperationW(&op);
}

static void SetSchedule(bool on) {
    if (on) {
        std::wstring cmd = L"schtasks /create /tn Butler_HealthCheck /tr \"\\\"" + ExePathFull() +
            L"\\\" --healthcheck\" /sc WEEKLY /d SUN /st 12:00 /rl HIGHEST /f";
        RunProcess(cmd);
    } else RunProcess(L"schtasks /delete /tn Butler_HealthCheck /f");
}

// ===========================================================================
// The embedded HTML/CSS/JS UI
// ===========================================================================
// The web UI lives in ui.html, embedded as an RCDATA resource (no source-size
// limits, easy to edit). Loaded at runtime and handed to WebView2.
static std::wstring LoadUiHtml() {
    HRSRC res = FindResourceW(nullptr, MAKEINTRESOURCEW(IDR_UIHTML), RT_RCDATA);
    if (!res) return L"<html><body>UI resource missing</body></html>";
    HGLOBAL h = LoadResource(nullptr, res);
    DWORD sz = SizeofResource(nullptr, res);
    const char* data = (const char*)LockResource(h);
    if (!data || !sz) return L"<html><body>UI resource empty</body></html>";
    return Utf8ToW(std::string(data, sz));
}

// ===========================================================================
// WebView2 host + message bridge
// ===========================================================================
static HWND g_hwnd = nullptr;
static ComPtr<ICoreWebView2Controller> g_controller;
static ComPtr<ICoreWebView2> g_webview;
static ScanResult* g_result = nullptr;
static bool g_runDrv = false, g_runApps = false, g_runNet = false, g_runSys = false, g_runPhotos = false, g_runDebloat = false, g_runInstall = false, g_runReg = false, g_runHealth = false;
static std::wstring g_regRestoreDir;
static std::wstring g_debloatAction;
static bool g_skipWu = false;     // CLI --skipwu, also applies to GUI scans
static bool g_autoScan = false;   // CLI --autoscan, scan automatically on launch
static bool g_autoCheck = true;   // scan automatically runs the online check (Settings)
static bool g_autoUpdate = false; // check for a Butler app update at startup (Settings)
static bool g_schedule = false;   // weekly scheduled health check (Settings)
static std::wstring g_lang = L"en";
static std::wstring g_theme = L"auto";  // UI theme: auto (follow Windows) / light / dark (Settings)
static bool g_autoRestore = true;       // Auto Update creates a System Restore point first (Settings default)
static std::wstring g_startTab;   // CLI --tab=, navigate to a category on launch
static std::wstring g_startSub;   // CLI --sub=, navigate to a sub-tab on launch
static std::wstring g_dupFolder;  // folder chosen for the duplicate-picture scan
static std::wstring g_dupPaths;   // pipe-separated paths queued for deletion
static std::wstring g_importFolder; // folder chosen for driver import (restore after reinstall)
static bool g_resumeAuto = false; // launched via RunOnce after a reboot: continue the driver install
static int g_winX = CW_USEDEFAULT, g_winY = CW_USEDEFAULT, g_winW = 1200, g_winH = 780;
static bool g_winSaved = false;

// Native menu command IDs (category-based)
enum {
    ID_DRV_SCAN = 2001, ID_DRV_EXPORT,
    ID_APPS_SCAN, ID_NET_SCAN, ID_SYS_SCAN,
    ID_SETTINGS, ID_HELP, ID_ABOUT, ID_EXIT,
    // Top-level navigation (the menu bar is the single nav now; no pill row).
    ID_NAV_DRIVERS, ID_NAV_APPS, ID_NAV_NETWORK, ID_NAV_SYSTEM, ID_NAV_PHOTOS,
    ID_NAV_TWEAKS, ID_NAV_REGISTRY, ID_NAV_DEBLOAT,
    ID_LANG_BASE = 2100  // + index into kLangs
};
struct Lang { const wchar_t* code; const wchar_t* name; };
static const Lang kLangs[] = {
    {L"en", L"English"}, {L"fr", L"Francais"}, {L"de", L"Deutsch"}, {L"it", L"Italiano"},
    {L"pl", L"Polski"}, {L"uk", L"Ukrainska"}, {L"es", L"Espanol"}, {L"pt", L"Portugues"},
    {L"ro", L"Romana"},
};
static const int kLangCount = (int)(sizeof(kLangs) / sizeof(kLangs[0]));
static void RebuildMenu();  // rebuilds the native menu in the current language

// Settings persistence (HKCU\Software\Butler).
static void LoadSettings() {
    HKEY k;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Butler", 0, KEY_READ, &k) != ERROR_SUCCESS) return;
    wchar_t buf[16]; DWORD cb = sizeof(buf);
    if (RegGetValueW(k, nullptr, L"Language", RRF_RT_REG_SZ, nullptr, buf, &cb) == ERROR_SUCCESS) {
        std::wstring c = buf;
        for (int i = 0; i < kLangCount; ++i) if (c == kLangs[i].code) g_lang = c;
    }
    DWORD v = 1, cbv = sizeof(v);
    if (RegGetValueW(k, nullptr, L"AutoCheck", RRF_RT_REG_DWORD, nullptr, &v, &cbv) == ERROR_SUCCESS) g_autoCheck = (v != 0);
    DWORD au = 0, cbau = sizeof(au);
    if (RegGetValueW(k, nullptr, L"AutoUpdate", RRF_RT_REG_DWORD, nullptr, &au, &cbau) == ERROR_SUCCESS) g_autoUpdate = (au != 0);
    DWORD sc = 0, cbs = sizeof(sc);
    if (RegGetValueW(k, nullptr, L"Schedule", RRF_RT_REG_DWORD, nullptr, &sc, &cbs) == ERROR_SUCCESS) g_schedule = (sc != 0);
    wchar_t th[16]; DWORD cbt = sizeof(th);
    if (RegGetValueW(k, nullptr, L"Theme", RRF_RT_REG_SZ, nullptr, th, &cbt) == ERROR_SUCCESS) {
        std::wstring t = th; if (t == L"light" || t == L"dark" || t == L"auto") g_theme = t;
    }
    DWORD ar = 1, cbar = sizeof(ar);
    if (RegGetValueW(k, nullptr, L"AutoRestore", RRF_RT_REG_DWORD, nullptr, &ar, &cbar) == ERROR_SUCCESS) g_autoRestore = (ar != 0);
    // Window placement.
    DWORD wx, wy, ww, wh, cb4 = sizeof(DWORD);
    if (RegGetValueW(k, nullptr, L"WinW", RRF_RT_REG_DWORD, nullptr, &ww, &cb4) == ERROR_SUCCESS && (int)ww >= 400 &&
        RegGetValueW(k, nullptr, L"WinH", RRF_RT_REG_DWORD, nullptr, &wh, &(cb4 = sizeof(DWORD))) == ERROR_SUCCESS && (int)wh >= 300 &&
        RegGetValueW(k, nullptr, L"WinX", RRF_RT_REG_DWORD, nullptr, &wx, &(cb4 = sizeof(DWORD))) == ERROR_SUCCESS &&
        RegGetValueW(k, nullptr, L"WinY", RRF_RT_REG_DWORD, nullptr, &wy, &(cb4 = sizeof(DWORD))) == ERROR_SUCCESS) {
        int x = (int)wx, y = (int)wy, w = (int)ww, h = (int)wh;
        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if (x >= vx - 50 && y >= vy - 50 && x < vx + vw - 100 && y < vy + vh - 50) {  // still on a visible screen
            g_winX = x; g_winY = y; g_winW = w; g_winH = h; g_winSaved = true;
        }
    }
    RegCloseKey(k);
}
static void SaveSettings() {
    HKEY k;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, L"Software\\Butler", 0, nullptr, 0, KEY_WRITE, nullptr, &k, nullptr) != ERROR_SUCCESS) return;
    RegSetValueExW(k, L"Language", 0, REG_SZ, (const BYTE*)g_lang.c_str(), (DWORD)((g_lang.size() + 1) * sizeof(wchar_t)));
    DWORD v = g_autoCheck ? 1 : 0;
    RegSetValueExW(k, L"AutoCheck", 0, REG_DWORD, (const BYTE*)&v, sizeof(v));
    DWORD au = g_autoUpdate ? 1 : 0;
    RegSetValueExW(k, L"AutoUpdate", 0, REG_DWORD, (const BYTE*)&au, sizeof(au));
    DWORD sc = g_schedule ? 1 : 0;
    RegSetValueExW(k, L"Schedule", 0, REG_DWORD, (const BYTE*)&sc, sizeof(sc));
    RegSetValueExW(k, L"Theme", 0, REG_SZ, (const BYTE*)g_theme.c_str(), (DWORD)((g_theme.size() + 1) * sizeof(wchar_t)));
    DWORD ar = g_autoRestore ? 1 : 0;
    RegSetValueExW(k, L"AutoRestore", 0, REG_DWORD, (const BYTE*)&ar, sizeof(ar));
    RegCloseKey(k);
}
static void SaveWindowRect(HWND hwnd) {
    WINDOWPLACEMENT wp{}; wp.length = sizeof(wp);
    if (!GetWindowPlacement(hwnd, &wp)) return;
    RECT r = wp.rcNormalPosition;
    HKEY k;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, L"Software\\Butler", 0, nullptr, 0, KEY_WRITE, nullptr, &k, nullptr) != ERROR_SUCCESS) return;
    DWORD x = (DWORD)r.left, y = (DWORD)r.top, w = (DWORD)(r.right - r.left), h = (DWORD)(r.bottom - r.top);
    RegSetValueExW(k, L"WinX", 0, REG_DWORD, (const BYTE*)&x, sizeof(x));
    RegSetValueExW(k, L"WinY", 0, REG_DWORD, (const BYTE*)&y, sizeof(y));
    RegSetValueExW(k, L"WinW", 0, REG_DWORD, (const BYTE*)&w, sizeof(w));
    RegSetValueExW(k, L"WinH", 0, REG_DWORD, (const BYTE*)&h, sizeof(h));
    RegCloseKey(k);
}

#define WM_PUSH_JSON (WM_APP + 10)

static void PushJson(const std::wstring& json) {
    PostMessageW(g_hwnd, WM_PUSH_JSON, 0, (LPARAM)new std::wstring(json));
}
static void PushLog(const std::wstring& text) {
    PushJson(L"{\"type\":\"log\",\"text\":" + JS(text) + L"}");
}
static void PushProgress(int done, int total, const std::wstring& text) {
    PushJson(L"{\"type\":\"progress\",\"done\":" + std::to_wstring(done) + L",\"total\":" +
             std::to_wstring(total) + L",\"text\":" + JS(text) + L"}");
}
static std::wstring LastScanPath();  // defined with the auto-job persistence helpers

static DWORD WINAPI ScanThread(LPVOID) {
    ScanResult* r = RunScan(g_skipWu);
    if (g_result) delete g_result; g_result = r;
    PushJson(ScanJson(*r));  // 'scan' = inventory ready
    if (g_autoCheck)
        CheckLatestVersions(*r, [](int d, int t, const std::wstring&) { PushProgress(d, t, L"Checking Microsoft Update Catalog"); });
    std::wstring j = ScanJson(*r); j.replace(j.find(L"\"type\":\"scan\""), 13, L"\"type\":\"checkDone\""); PushJson(j);
    WriteUtf8(LastScanPath(), j);  // remember the scan across restarts
    g_runDrv = false; return 0;
}
static DWORD WINAPI CheckThread(LPVOID) {
    if (g_result) {
        CheckLatestVersions(*g_result, [](int d, int t, const std::wstring& tx){ PushProgress(d, t, L"Checking Microsoft Update Catalog"); });
        std::wstring j = ScanJson(*g_result); j.replace(j.find(L"\"type\":\"scan\""), 13, L"\"type\":\"checkDone\""); PushJson(j);
        WriteUtf8(LastScanPath(), j);  // remember the scan across restarts
    }
    g_runDrv = false; return 0;
}
static DWORD WINAPI AppsThread(LPVOID) {
    std::vector<AppInfo> apps; EnumerateApps(apps);
    PushJson(AppsJson(apps)); g_runApps = false; return 0;
}
static DWORD WINAPI NetThread(LPVOID) {
    std::vector<NetDevice> devs; ScanNetwork(devs);
    PushJson(NetJson(devs)); g_runNet = false; return 0;
}
static DWORD WINAPI SysThread(LPVOID) {
    PushJson(ScanSystemJson()); g_runSys = false; return 0;
}
static DWORD WINAPI CreateRestoreThread(LPVOID) {
    bool ok = CreateRestorePoint(L"Butler - manual restore point");
    PushJson(L"{\"type\":\"restoredone\",\"ok\":" + std::wstring(ok ? L"true" : L"false") + L"}");
    PushJson(ScanSystemJson());  // refresh the list
    g_runSys = false; return 0;
}
static DWORD WINAPI PerfThread(LPVOID) {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);  // WMI disk-health query
    PushJson(PerfJson());
    if (SUCCEEDED(hr)) CoUninitialize();
    g_runSys = false; return 0;
}
static DWORD WINAPI BatteryThread(LPVOID) {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    PushJson(BatteryJson());
    if (SUCCEEDED(hr)) CoUninitialize();
    g_runSys = false; return 0;
}
static DWORD WINAPI DiskHealthThread(LPVOID) {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);  // WMI disk query
    PushJson(DiskHealthJson());
    if (SUCCEEDED(hr)) CoUninitialize();
    g_runSys = false; return 0;
}
static DWORD WINAPI WinUpdateThread(LPVOID) {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    PushJson(WinUpdateJson());
    if (SUCCEEDED(hr)) CoUninitialize();
    g_runSys = false; return 0;
}
// Real in-app Windows Update install: search -> download -> install via WUA COM.
static DWORD WINAPI WuInstallThread(LPVOID) {
    auto phase = [](const wchar_t* p) { PushJson(std::wstring(L"{\"type\":\"wustatus\",\"phase\":\"") + p + L"\"}"); };
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    bool reboot = false; int n = 0; bool ok = false;
    IUpdateSession* sess = nullptr;
    if (SUCCEEDED(CoCreateInstance(__uuidof(UpdateSession), nullptr, CLSCTX_INPROC_SERVER, __uuidof(IUpdateSession), (void**)&sess)) && sess) {
        IUpdateSearcher* sr = nullptr;
        if (SUCCEEDED(sess->CreateUpdateSearcher(&sr)) && sr) {
            phase(L"searching");
            BSTR crit = SysAllocString(L"IsInstalled=0 and IsHidden=0"); ISearchResult* res = nullptr;
            if (SUCCEEDED(sr->Search(crit, &res)) && res) {
                IUpdateCollection* found = nullptr; res->get_Updates(&found);
                LONG cnt = 0; if (found) found->get_Count(&cnt);
                if (found && cnt > 0) {
                    IUpdateCollection* toInst = nullptr;
                    CoCreateInstance(__uuidof(UpdateCollection), nullptr, CLSCTX_INPROC_SERVER, __uuidof(IUpdateCollection), (void**)&toInst);
                    for (LONG i = 0; toInst && i < cnt; ++i) {
                        IUpdate* u = nullptr; if (SUCCEEDED(found->get_Item(i, &u)) && u) {
                            VARIANT_BOOL eula = VARIANT_FALSE; u->get_EulaAccepted(&eula); if (eula == VARIANT_FALSE) u->AcceptEula();
                            LONG idx = 0; toInst->Add(u, &idx); u->Release();
                        }
                    }
                    n = (int)cnt;
                    if (toInst) {
                        phase(L"downloading");
                        IUpdateDownloader* dl = nullptr;
                        if (SUCCEEDED(sess->CreateUpdateDownloader(&dl)) && dl) {
                            dl->put_Updates(toInst); IDownloadResult* dr = nullptr; dl->Download(&dr); if (dr) dr->Release(); dl->Release();
                        }
                        phase(L"installing");
                        IUpdateInstaller* inst = nullptr;
                        if (SUCCEEDED(sess->CreateUpdateInstaller(&inst)) && inst) {
                            inst->put_Updates(toInst); IInstallationResult* ir = nullptr;
                            if (SUCCEEDED(inst->Install(&ir)) && ir) {
                                VARIANT_BOOL rb = VARIANT_FALSE; ir->get_RebootRequired(&rb); reboot = (rb == VARIANT_TRUE);
                                OperationResultCode rc = orcNotStarted; ir->get_ResultCode(&rc);
                                ok = (rc == orcSucceeded || rc == orcSucceededWithErrors);
                                ir->Release();
                            }
                            inst->Release();
                        }
                        toInst->Release();
                    }
                } else { ok = true; n = 0; }  // nothing to install
                if (found) found->Release();
                res->Release();
            }
            SysFreeString(crit); sr->Release();
        }
        sess->Release();
    }
    PushJson(WinUpdateJson());  // refresh the pending count
    PushJson(L"{\"type\":\"wuinstalldone\",\"ok\":" + JB(ok) + L",\"reboot\":" + JB(reboot) + L",\"n\":" + std::to_wstring(n) + L"}");
    if (SUCCEEDED(hr)) CoUninitialize();
    g_runSys = false; return 0;
}
static DWORD WINAPI CleanupThread(LPVOID) { PushJson(CleanupJson()); g_runSys = false; return 0; }
static DWORD WINAPI HealthThread(LPVOID) { PushJson(HealthJson()); g_runHealth = false; return 0; }
static DWORD WINAPI CleanRunThread(LPVOID) { PushJson(DoCleanup()); g_runSys = false; return 0; }
static DWORD WINAPI DriverBackupThread(LPVOID) { PushJson(DriverBackupJson()); g_runDrv = false; return 0; }
static DWORD WINAPI DriverImportThread(LPVOID) {  // restore drivers from a backup folder (after a fresh Windows)
    DWORD rc = RunProcess(L"pnputil.exe /add-driver \"" + g_importFolder + L"\\*.inf\" /subdirs /install");
    PushJson(L"{\"type\":\"driverimport\",\"ok\":" + JB(rc == 0 || rc == 3010) + L",\"path\":" + JS(g_importFolder) + L"}");
    g_runDrv = false; return 0;
}
static DWORD WINAPI NetDiagThread(LPVOID) { PushJson(NetDiagJson()); g_runNet = false; return 0; }
static DWORD WINAPI DupScanThread(LPVOID) {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);  // shell thumbnail API
    PushJson(DupScanJson(g_dupFolder));
    if (SUCCEEDED(hr)) CoUninitialize();
    g_runPhotos = false; return 0;
}
static DWORD WINAPI DupDeleteThread(LPVOID) {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    DupDelete(g_dupPaths);
    if (SUCCEEDED(hr)) CoUninitialize();
    PushJson(L"{\"type\":\"dupdeletedone\"}");
    g_runPhotos = false; return 0;
}
// Folder picker (runs on the UI thread, which has COM initialised by WebView2).
static std::wstring PickFolder() {
    std::wstring result;
    IFileOpenDialog* dlg = nullptr;
    if (SUCCEEDED(CoCreateInstance(__uuidof(FileOpenDialog), nullptr, CLSCTX_INPROC_SERVER,
                                   __uuidof(IFileOpenDialog), (void**)&dlg)) && dlg) {
        DWORD opt = 0; dlg->GetOptions(&opt);
        dlg->SetOptions(opt | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
        if (SUCCEEDED(dlg->Show(g_hwnd))) {
            IShellItem* it = nullptr;
            if (SUCCEEDED(dlg->GetResult(&it)) && it) {
                PWSTR p = nullptr;
                if (SUCCEEDED(it->GetDisplayName(SIGDN_FILESYSPATH, &p)) && p) { result = p; CoTaskMemFree(p); }
                it->Release();
            }
        }
        dlg->Release();
    }
    return result;
}
// --- Auto-update job persistence (survives a machine reboot mid-install) -------
static std::wstring AutoJobPath()  { return ProgDataDir() + L"\\autojob.txt"; }
static std::wstring LastScanPath() { return ProgDataDir() + L"\\lastscan.json"; }

static bool ReadUtf8File(const std::wstring& path, std::wstring& out) {
    HANDLE f = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE) return false;
    DWORD sz = GetFileSize(f, nullptr); std::string buf(sz, '\0'); DWORD rd = 0;
    BOOL ok = ReadFile(f, buf.data(), sz, &rd, nullptr); CloseHandle(f);
    if (!ok) return false;
    int wl = MultiByteToWideChar(CP_UTF8, 0, buf.data(), (int)rd, nullptr, 0);
    out.assign(wl, L'\0');
    if (wl) MultiByteToWideChar(CP_UTF8, 0, buf.data(), (int)rd, out.data(), wl);
    return true;
}

struct AutoItem { std::wstring updateId, device, latest, hwId; int status; };  // 0=pending 1=done 2=failed
static void SaveAutoJob(const std::vector<AutoItem>& job, bool restore) {
    std::wstring o = L"restore=" + std::wstring(restore ? L"1" : L"0") + L"\n";
    for (const auto& it : job)
        o += L"item\t" + it.updateId + L"\t" + std::to_wstring(it.status) + L"\t" + it.device + L"\t" + it.latest + L"\t" + it.hwId + L"\n";
    WriteUtf8(AutoJobPath(), o);
}
static bool LoadAutoJob(std::vector<AutoItem>& job, bool& restore) {
    std::wstring txt; if (!ReadUtf8File(AutoJobPath(), txt)) return false;
    job.clear(); restore = true;
    size_t p = 0;
    while (p < txt.size()) {
        size_t nl = txt.find(L'\n', p);
        std::wstring line = txt.substr(p, nl == std::wstring::npos ? std::wstring::npos : nl - p);
        p = (nl == std::wstring::npos) ? txt.size() : nl + 1;
        if (!line.empty() && line.back() == L'\r') line.pop_back();
        if (line.rfind(L"restore=", 0) == 0) { restore = (line.substr(8) == L"1"); continue; }
        if (line.rfind(L"item\t", 0) != 0) continue;
        std::vector<std::wstring> f; size_t q = 5;  // skip "item\t"
        while (true) { size_t t = line.find(L'\t', q); f.push_back(line.substr(q, t == std::wstring::npos ? std::wstring::npos : t - q));
            if (t == std::wstring::npos) break; q = t + 1; }
        if (f.size() >= 4) job.push_back({ f[0], f[2], f[3], (f.size() > 4 ? f[4] : L""), _wtoi(f[1].c_str()) });
    }
    return !job.empty();
}
static void ClearAutoJob() { DeleteFileW(AutoJobPath().c_str()); }

// Log to the on-screen Auto-update log AND append to a persistent file.
static void AutoLog(const std::wstring& s) {
    PushLog(s);
    HANDLE f = CreateFileW((ProgDataDir() + L"\\autoupdate.log").c_str(), FILE_APPEND_DATA, FILE_SHARE_READ,
                           nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE) return;
    std::wstring line = s + L"\r\n";
    int len = WideCharToMultiByte(CP_UTF8, 0, line.c_str(), -1, nullptr, 0, nullptr, nullptr);
    std::string u(len > 0 ? len - 1 : 0, '\0');
    WideCharToMultiByte(CP_UTF8, 0, line.c_str(), -1, u.data(), len, nullptr, nullptr);
    SetFilePointer(f, 0, nullptr, FILE_END); DWORD w; WriteFile(f, u.data(), (DWORD)u.size(), &w, nullptr);
    CloseHandle(f);
}
// Fresh driver scan + catalog check; refreshes g_result and the UI list so that
// drivers that actually updated drop off the "update available" list.
static void RescanAndPush() {
    AutoLog(L"Re-scanning to confirm what changed (this takes a minute)...");
    ScanResult* r = RunScan(g_skipWu);
    if (g_result) delete g_result; g_result = r;
    CheckLatestVersions(*r, [](int d, int t, const std::wstring&) { PushProgress(d, t, L"Re-checking Microsoft Update Catalog"); });
    std::wstring j = ScanJson(*r);
    size_t p = j.find(L"\"type\":\"scan\""); if (p != std::wstring::npos) j.replace(p, 13, L"\"type\":\"checkDone\"");
    PushJson(j); WriteUtf8(LastScanPath(), j);
}

struct AutoArgs { bool restore; std::wstring ids; bool resume; };
static DWORD WINAPI AutoThread(LPVOID param) {
    AutoArgs* a = (AutoArgs*)param;
    std::vector<AutoItem> job; bool restore = a->restore;

    if (a->resume) {
        if (!LoadAutoJob(job, restore)) {
            PushJson(L"{\"type\":\"autoDone\",\"text\":\"Nothing to resume.\"}");
            delete a; g_runDrv = false; return 0;
        }
        AutoLog(L"--- Resuming driver installation after restart ---");
    } else {
        // If the list was restored from disk on launch, g_result is empty: scan first
        // so the auto-update has live driver info (updateId/hwId). This makes "Start
        // Auto Update" work straight from the restored list, without a manual scan.
        if (!g_result) {
            AutoLog(L"Scanning drivers first (no fresh scan in memory)...");
            ScanResult* r = RunScan(g_skipWu);
            CheckLatestVersions(*r, [](int d, int t, const std::wstring&) { PushProgress(d, t, L"Checking Microsoft Update Catalog"); });
            g_result = r;
        }
        // Build the job from the current scan + the user's selection (empty => all).
        std::set<std::wstring> sel;
        { size_t p = 0; while (p < a->ids.size()) { size_t c = a->ids.find(L',', p);
            std::wstring id = a->ids.substr(p, c == std::wstring::npos ? std::wstring::npos : c - p);
            if (!id.empty()) sel.insert(id); if (c == std::wstring::npos) break; p = c + 1; } }
        if (g_result) for (const auto& d : g_result->drivers)
            if (d.verdict == L"UPDATE AVAILABLE" && (sel.empty() || sel.count(d.updateId)))
                job.push_back({ d.updateId, d.device, d.latest, d.hwId, 0 });
        if (job.empty()) {
            PushJson(L"{\"type\":\"autoDone\",\"text\":\"No updates to install.\"}");
            delete a; g_runDrv = false; return 0;
        }
        SaveAutoJob(job, restore);
    }

    AutoLog(L"Auto update: " + std::to_wstring(job.size()) + L" driver update(s) selected.");
    if (!IsElevated()) {  // app ships requireAdministrator, so this is a fallback only
        AutoLog(L"Elevation required - relaunching as administrator...");
        if (!RelaunchElevated(a->resume ? L"--resume" : L"--auto")) AutoLog(L"Elevation was declined. Auto update cancelled.");
        delete a; g_runDrv = false; return 0;
    }
    if (restore && !a->resume) {
        AutoLog(L"Creating System Restore point...");
        bool ok = CreateRestorePoint(L"Butler - before driver updates");
        AutoLog(ok ? L"Restore point created." : L"Could not create a restore point (System Protection may be off). Continuing.");
    }

    // Arm resume BEFORE installing, so even an unexpected forced reboot resumes.
    SetRunOnceResume(true);

    // Install every pending update with /norestart and remember progress after
    // each one. We reboot at most ONCE, after the whole batch.
    bool needReboot = false; int applied = 0, kept = 0, failed = 0;
    int total = (int)job.size(), done = 0;
    for (auto& it : job) {
        done++;
        if (it.status == 1) { applied++; continue; }  // already installed in an earlier run (resume)
        AutoLog(L"[" + std::to_wstring(done) + L"/" + std::to_wstring(total) + L"] " + it.device + L"  ->  " + it.latest);
        PushProgress(done, total, L"Installing driver updates");
        bool rb = false; std::wstring line;
        DriverInfo di; di.updateId = it.updateId; di.device = it.device; di.latest = it.latest; di.hwId = it.hwId;
        bool ok = InstallUpdate(di, rb, line);
        it.status = ok ? 1 : 2;
        if (ok) applied++; else if (line.rfind(L"kept", 0) == 0) kept++; else failed++;
        SaveAutoJob(job, restore);     // persist progress immediately
        AutoLog(L"      " + line);
        needReboot = needReboot || rb;
        // No reboot here: batch everything, reboot once at the end.
    }
    AutoLog(L"Done: " + std::to_wstring(applied) + L" installed, " + std::to_wstring(kept) + L" kept by Windows, " + std::to_wstring(failed) + L" failed.");

    if (needReboot) {
        AutoLog(L"A restart is needed to finish - the app re-scans automatically after the restart.");
        PushJson(L"{\"type\":\"autoDone\",\"text\":\"Restarting once to finish...\"}");
        RebootSystem();  // RunOnce already armed; resume picks up the (already-done) job and clears it
        delete a; g_runDrv = false; return 0;
    }
    SetRunOnceResume(false);
    ClearAutoJob();
    RescanAndPush();   // refresh the list so installed drivers drop off
    AutoLog(L"Auto update finished - the list above now reflects the result.");
    PushJson(L"{\"type\":\"autoDone\",\"text\":\"Auto update finished - list refreshed.\"}");
    delete a; g_runDrv = false; return 0;
}

// Shared action triggers. Each category runs independently (its own busy flag),
// so Drivers / Apps / Network / System scans can run in parallel.
static void StartFlag(LPTHREAD_START_ROUTINE fn, bool& flag) {
    if (flag) return; flag = true;
    CloseHandle(CreateThread(nullptr, 0, fn, nullptr, 0, nullptr));
}
static void StartScan()          { StartFlag(ScanThread, g_runDrv); }
static void StartCheck()         { if (g_result) StartFlag(CheckThread, g_runDrv); }
static void StartApps()          { StartFlag(AppsThread, g_runApps); }
static void StartNetwork()       { StartFlag(NetThread, g_runNet); }
static void StartSystem()        { StartFlag(SysThread, g_runSys); }
static void StartCreateRestore() { StartFlag(CreateRestoreThread, g_runSys); }
static void DoExportReport() {
    if (!g_result) return;
    SYSTEMTIME st; GetLocalTime(&st);
    wchar_t fn[64]; swprintf_s(fn, L"ButlerReport-%04d%02d%02d-%02d%02d%02d.html",
                              st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    std::wstring path = ExeDir() + L"\\" + fn;
    if (WriteReport(*g_result, path)) {
        PushJson(L"{\"type\":\"exported\",\"path\":" + JS(path) + L"}");
        ShellExecuteW(nullptr, L"open", path.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    }
}
static void StartAuto(bool restore, const std::wstring& ids, bool resume = false) {
    if (g_runDrv) return;
    // A fresh run needs scan results; if none are in memory yet (e.g. the list was
    // restored from lastscan.json on launch), AutoThread will scan first. A resume
    // reads its job from disk. So we no longer block on g_result here.
    g_runDrv = true;
    AutoArgs* a = new AutoArgs{ restore, ids, resume };
    CloseHandle(CreateThread(nullptr, 0, AutoThread, a, 0, nullptr));
}
// Launch an arbitrary command line (used for app uninstall). Fire-and-forget.
static void RunCommandLine(const std::wstring& cmd) {
    if (cmd.empty()) return;
    STARTUPINFOW si{}; si.cb = sizeof(si); PROCESS_INFORMATION pi{};
    std::wstring c = cmd;
    if (CreateProcessW(nullptr, c.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi)) {
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    }
}
static void NavCat(const wchar_t* cat, const wchar_t* sub) {
    std::wstring j = std::wstring(L"{\"type\":\"nav\",\"cat\":\"") + cat + L"\"";
    if (sub && *sub) j += std::wstring(L",\"sub\":\"") + sub + L"\"";
    PushJson(j + L"}");
}
static void SetLanguage(const std::wstring& code) {
    g_lang = code;
    RebuildMenu();
    SaveSettings();
    PushJson(L"{\"type\":\"lang\",\"lang\":" + JS(code) + L"}");
}

// Tiny field extractor for incoming JS messages.
static std::wstring JField(const std::wstring& j, const wchar_t* key) {
    std::wstring pat = std::wstring(L"\"") + key + L"\"";
    size_t p = j.find(pat); if (p == std::wstring::npos) return L"";
    p = j.find(L':', p + pat.size()); if (p == std::wstring::npos) return L""; p++;
    while (p < j.size() && iswspace(j[p])) p++;
    if (p < j.size() && j[p] == L'"') {
        p++; std::wstring o;
        while (p < j.size() && j[p] != L'"') { if (j[p] == L'\\' && p + 1 < j.size()) { p++; } o += j[p++]; }
        return o;
    }
    std::wstring o; while (p < j.size() && j[p] != L',' && j[p] != L'}') o += j[p++]; return Trim(o);
}

static void ApplyNativeTheme();  // defined after the menu theming helpers

// ===========================================================================
// Tweaks (Win11 customizations) - data-driven registry toggles
// ===========================================================================
// A tweak applies one or more registry ops; its on/off state is read from the
// first op. Supports DWORD and string values. Set assembled from Win11Tweaker,
// ChrisTitusTech/winutil and Winhance (deduplicated).
struct RegOp { HKEY hive; std::wstring path, val; bool isStr; DWORD onD, offD; std::wstring onS, offS; };
struct TweakDef { std::wstring id; bool explorer; std::vector<RegOp> ops; };
static RegOp TD(HKEY h, const wchar_t* p, const wchar_t* v, DWORD on, DWORD off) { return { h, p, v, false, on, off, L"", L"" }; }
static RegOp TS(HKEY h, const wchar_t* p, const wchar_t* v, const wchar_t* on, const wchar_t* off) { return { h, p, v, true, 0, 0, on, off }; }
static const std::vector<TweakDef>& Tweaks() {
    const wchar_t* ADV  = L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced";
    const wchar_t* PERS = L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
    const wchar_t* SRCH = L"Software\\Microsoft\\Windows\\CurrentVersion\\Search";
    const wchar_t* GB   = L"Software\\Microsoft\\GameBar";
    const wchar_t* CDM  = L"Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager";
    const wchar_t* SS2  = L"Software\\Microsoft\\Windows\\CurrentVersion\\SearchSettings";
    const wchar_t* IP   = L"Software\\Microsoft\\InputPersonalization";
    const wchar_t* GAMES= L"Software\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games";
    const wchar_t* UGP  = L"Software\\Microsoft\\DirectX\\UserGpuPreferences";
    const wchar_t* NSP  = L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\HideDesktopIcons\\NewStartPanel";
    const wchar_t* CAM  = L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore";
    HKEY CU = HKEY_CURRENT_USER, LM = HKEY_LOCAL_MACHINE;
    static std::vector<TweakDef> t = {
        {L"fileext",        true,  { TD(CU, ADV, L"HideFileExt", 0, 1) }},
        {L"hidden",         true,  { TD(CU, ADV, L"Hidden", 1, 2) }},
        {L"taskleft",       true,  { TD(CU, ADV, L"TaskbarAl", 0, 1) }},
        {L"widgets",        true,  { TD(CU, ADV, L"TaskbarDa", 0, 1) }},
        {L"copilot",        true,  { TD(CU, ADV, L"ShowCopilotButton", 0, 1) }},
        {L"taskview",       true,  { TD(CU, ADV, L"ShowTaskViewButton", 0, 1) }},
        {L"searchicon",     true,  { TD(CU, SRCH, L"SearchboxTaskbarMode", 0, 1) }},
        {L"thispc",         true,  { TD(CU, ADV, L"LaunchTo", 1, 2) }},
        {L"battpercent",    true,  { TD(CU, ADV, L"IsBatteryPercentageEnabled", 1, 0) }},
        {L"endtask",        false, { TD(CU, L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced\\TaskbarDeveloperSettings", L"TaskbarEndTask", 1, 0) }},
        {L"bgapps",         false, { TD(CU, L"Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications", L"GlobalUserDisabled", 1, 0) }},
        {L"snip",           false, { TD(CU, L"Control Panel\\Keyboard", L"PrintScreenKeyForSnippingEnabled", 1, 0) }},
        {L"darkapps",       true,  { TD(CU, PERS, L"AppsUseLightTheme", 0, 1) }},
        {L"darksys",        true,  { TD(CU, PERS, L"SystemUsesLightTheme", 0, 1) }},
        {L"websearch",      true,  { TD(CU, L"Software\\Policies\\Microsoft\\Windows\\Explorer", L"DisableSearchBoxSuggestions", 1, 0), TD(CU, SRCH, L"BingSearchEnabled", 0, 1) }},
        {L"telemetry",      false, { TD(LM, L"SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection", L"AllowTelemetry", 0, 1), TD(CU, L"Software\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo", L"Enabled", 0, 1), TD(CU, L"Software\\Microsoft\\Windows\\CurrentVersion\\Privacy", L"TailoredExperiencesWithDiagnosticDataEnabled", 0, 1) }},
        {L"activityhistory",false, { TD(LM, L"SOFTWARE\\Policies\\Microsoft\\Windows\\System", L"EnableActivityFeed", 0, 1), TD(LM, L"SOFTWARE\\Policies\\Microsoft\\Windows\\System", L"PublishUserActivities", 0, 1), TD(LM, L"SOFTWARE\\Policies\\Microsoft\\Windows\\System", L"UploadUserActivities", 0, 1) }},
        {L"consumerfeatures",false,{ TD(LM, L"SOFTWARE\\Policies\\Microsoft\\Windows\\CloudContent", L"DisableWindowsConsumerFeatures", 1, 0) }},
        {L"deliveryopt",    false, { TD(LM, L"SOFTWARE\\Policies\\Microsoft\\Windows\\DeliveryOptimization", L"DODownloadMode", 0, 1) }},
        {L"notifications",  false, { TD(CU, L"Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications", L"ToastEnabled", 0, 1), TD(CU, L"Software\\Policies\\Microsoft\\Windows\\Explorer", L"DisableNotificationCenter", 1, 0) }},
        {L"locationtracking",false,{ TS(LM, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\location", L"Value", L"Deny", L"Allow") }},
        {L"hibernate",      false, { TD(LM, L"System\\CurrentControlSet\\Control\\Session Manager\\Power", L"HibernateEnabled", 0, 1) }},
        {L"gamemode",       false, { TD(CU, GB, L"AllowAutoGameMode", 1, 0), TD(CU, GB, L"AutoGameModeEnabled", 1, 0) }},
        {L"longpaths",      false, { TD(LM, L"SYSTEM\\CurrentControlSet\\Control\\FileSystem", L"LongPathsEnabled", 1, 0) }},
        {L"storagesense",   false, { TD(CU, L"Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy", L"01", 0, 1) }},
        {L"xboxdvr",        false, { TD(CU, L"System\\GameConfigStore", L"GameDVR_Enabled", 0, 1), TD(CU, L"Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR", L"AppCaptureEnabled", 0, 1) }},
        {L"scrollbars",     false, { TD(CU, L"Control Panel\\Accessibility", L"DynamicScrollbars", 0, 1) }},
        {L"verbosestatus",  false, { TD(LM, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System", L"VerboseStatus", 1, 0) }},
        {L"numlock",        false, { TS(CU, L"Control Panel\\Keyboard", L"InitialKeyboardIndicators", L"2", L"0") }},
        {L"mouseaccel",     false, { TS(CU, L"Control Panel\\Mouse", L"MouseSpeed", L"0", L"1"), TS(CU, L"Control Panel\\Mouse", L"MouseThreshold1", L"0", L"6"), TS(CU, L"Control Panel\\Mouse", L"MouseThreshold2", L"0", L"10") }},
        {L"utctime",        false, { TD(LM, L"SYSTEM\\CurrentControlSet\\Control\\TimeZoneInformation", L"RealTimeIsUniversal", 1, 0) }},
        {L"startrecommend", false, { TD(LM, L"SOFTWARE\\Microsoft\\PolicyManager\\current\\device\\Start", L"HideRecommendedSection", 1, 0) }},
        {L"lockscreen",     false, { TD(LM, L"SOFTWARE\\Policies\\Microsoft\\Windows\\Personalization", L"NoLockScreen", 1, 0) }},
        {L"rdpwarning",     false, { TD(LM, L"SOFTWARE\\Policies\\Microsoft\\Windows NT\\Terminal Services\\Client", L"RedirectionWarningDialogVersion", 1, 0) }},
        {L"explorernohome", true,  { TD(CU, L"Software\\Classes\\CLSID\\{f874310e-b6b7-47dc-bc84-b9e6b38f5903}", L"System.IsPinnedToNameSpaceTree", 0, 1), TD(CU, L"Software\\Classes\\CLSID\\{e88865ea-0e1c-4e20-9aa6-edcd0212c87c}", L"System.IsPinnedToNameSpaceTree", 0, 1) }},
        {L"visualfx",       true,  { TD(CU, L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects", L"VisualFXSetting", 2, 0), TS(CU, L"Control Panel\\Desktop", L"DragFullWindows", L"0", L"1") }},
        {L"disableai",      false, { TS(LM, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer", L"SettingsPageVisibility", L"hide:aicomponents", L""), TD(LM, L"SOFTWARE\\Policies\\WindowsNotepad", L"DisableAIFeatures", 1, 0) }},
        {L"wpbt",           false, { TD(LM, L"SYSTEM\\CurrentControlSet\\Control\\Session Manager", L"DisableWpbtExecution", 1, 0) }},
        {L"preferipv4",     false, { TD(LM, L"SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters", L"DisabledComponents", 32, 0) }},
        {L"fullscreenopt",  false, { TD(CU, L"System\\GameConfigStore", L"GameDVR_DXGIHonorFSEWindowsCompatible", 1, 0) }},
        {L"bsodverbose",    false, { TD(LM, L"SYSTEM\\CurrentControlSet\\Control\\CrashControl", L"DisplayParameters", 1, 0) }},
        {L"settingshome",   false, { TS(CU, L"Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer", L"SettingsPageVisibility", L"hide:home", L"show:home") }},
        {L"loginblur",      false, { TD(LM, L"SOFTWARE\\Policies\\Microsoft\\Windows\\System", L"DisableAcrylicBackgroundOnLogon", 1, 0) }},
        {L"newoutlook",     false, { TD(CU, L"SOFTWARE\\Microsoft\\Office\\16.0\\Outlook\\Preferences", L"UseNewOutlook", 1, 0) }},
        {L"razerblock",     false, { TD(LM, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\DriverSearching", L"SearchOrderConfig", 0, 1), TD(LM, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Device Installer", L"DisableCoInstallers", 1, 0) }},
        {L"gpupreempt",     false, { TD(LM, L"SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers\\Scheduler", L"DisablePreemption", 1, 0) }},
        {L"sysresponsive",  false, { TD(LM, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile", L"SystemResponsiveness", 0, 20) }},
        {L"netthrottle",    false, { TD(LM, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile", L"NetworkThrottlingIndex", 0xFFFFFFFF, 10) }},
        {L"aeropeek",       true,  { TD(CU, ADV, L"DesktopLivePreviewHoverTime", 1, 0) }},
        {L"lockscreenads",  false, { TD(CU, L"Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", L"RotatingLockScreenEnabled", 0, 1), TD(CU, L"Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", L"SubscribedContent-338387Enabled", 0, 1), TD(CU, L"Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", L"SubscribedContent-310093Enabled", 0, 1) }},
        {L"menudelay",      true,  { TS(CU, L"Control Panel\\Desktop", L"MenuShowDelay", L"0", L"400") }},
        {L"clockseconds",   true,  { TD(CU, ADV, L"ShowSecondsInSystemClock", 1, 0) }},
        {L"officecursorlag",false, { TD(CU, L"Software\\Microsoft\\Office\\16.0\\Common\\Graphics", L"DisableAnimations", 1, 0) }},
        {L"fgboost",        false, { TD(LM, L"SYSTEM\\CurrentControlSet\\Control\\PriorityControl", L"Win32PrioritySeparation", 38, 2) }},
        {L"startupdelay",   false, { TD(CU, L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Serialize", L"StartupDelayInMSec", 0, 1) }},
        {L"stickykeys",     false, { TS(CU, L"Control Panel\\Accessibility\\StickyKeys", L"Flags", L"506", L"510") }},
        {L"mpo",            false, { TD(LM, L"SOFTWARE\\Microsoft\\Windows\\Dwm", L"OverlayTestMode", 5, 0) }},
        // ---- Privacy (Winhance / winutil) -------------------------------------
        {L"errorreporting", false, { TD(LM, L"SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Error Reporting", L"Disabled", 1, 0) }},
        {L"remoteassist",   false, { TD(LM, L"SYSTEM\\CurrentControlSet\\Control\\Remote Assistance", L"fAllowToGetHelp", 0, 1) }},
        {L"contentdelivery",false, { TD(CU, CDM, L"ContentDeliveryAllowed", 0, 1) }},
        {L"silentapps",     false, { TD(CU, CDM, L"SilentInstalledAppsEnabled", 0, 1) }},
        {L"oemapps",        false, { TD(CU, CDM, L"OemPreInstalledAppsEnabled", 0, 1) }},
        {L"softlanding",    false, { TD(CU, CDM, L"SoftLandingEnabled", 0, 1) }},
        {L"onlinespeech",   false, { TD(CU, L"Software\\Microsoft\\Speech_OneCore\\Settings\\OnlineSpeechPrivacy", L"HasAccepted", 0, 1) }},
        {L"inkingtyping",   false, { TD(CU, IP, L"RestrictImplicitTextCollection", 1, 0), TD(CU, IP, L"RestrictImplicitInkCollection", 1, 0), TD(CU, L"Software\\Microsoft\\InputPersonalization\\TrainedDataStore", L"HarvestContacts", 0, 1) }},
        {L"typingdata",     false, { TD(CU, L"Software\\Microsoft\\Input\\TIPC", L"Enabled", 0, 1) }},
        {L"feedbackreq",    false, { TD(CU, L"SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection", L"DoNotShowFeedbackNotifications", 1, 0) }},
        {L"searchhist",     false, { TD(CU, SS2, L"IsDeviceSearchHistoryEnabled", 0, 1) }},
        {L"searchhighlights",false,{ TD(CU, SS2, L"IsDynamicSearchBoxEnabled", 0, 1) }},
        {L"cloudsearch",    false, { TD(CU, SS2, L"IsMSACloudSearchEnabled", 0, 1), TD(CU, SS2, L"IsAADCloudSearchEnabled", 0, 1) }},
        {L"cortana",        false, { TD(LM, L"SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search", L"AllowCortana", 0, 1) }},
        {L"cameraaccess",   false, { TS(LM, (std::wstring(CAM) + L"\\webcam").c_str(), L"Value", L"Deny", L"Allow") }},
        {L"micaccess",      false, { TS(LM, (std::wstring(CAM) + L"\\microphone").c_str(), L"Value", L"Deny", L"Allow") }},
        {L"accountaccess",  false, { TS(LM, (std::wstring(CAM) + L"\\userAccountInformation").c_str(), L"Value", L"Deny", L"Allow") }},
        {L"diagaccess",     false, { TS(LM, (std::wstring(CAM) + L"\\appDiagnostics").c_str(), L"Value", L"Deny", L"Allow") }},
        {L"wifisense",      false, { TD(LM, L"Software\\Microsoft\\PolicyManager\\default\\WiFi\\AllowWiFiHotSpotReporting", L"Value", 0, 1), TD(LM, L"Software\\Microsoft\\PolicyManager\\default\\WiFi\\AllowAutoConnectToWiFiSenseHotspots", L"Value", 0, 1) }},
        {L"workplacejoin",  false, { TD(LM, L"SOFTWARE\\Policies\\Microsoft\\Windows\\WorkplaceJoin", L"BlockAADWorkplaceJoin", 1, 0) }},
        {L"langtracking",   false, { TD(CU, L"Control Panel\\International\\User Profile", L"HttpAcceptLanguageOptOut", 1, 0) }},
        {L"settingssuggested",false,{ TD(CU, CDM, L"SubscribedContent-338393Enabled", 0, 1), TD(CU, CDM, L"SubscribedContent-353694Enabled", 0, 1), TD(CU, CDM, L"SubscribedContent-353696Enabled", 0, 1) }},
        // ---- Suggestions / nags ----------------------------------------------
        {L"scoobe",         false, { TD(CU, L"Software\\Microsoft\\Windows\\CurrentVersion\\UserProfileEngagement", L"ScoobeSystemSettingEnabled", 0, 1) }},
        {L"wintips",        false, { TD(CU, CDM, L"SubscribedContent-338389Enabled", 0, 1) }},
        {L"panesuggestions",false, { TD(CU, CDM, L"SystemPaneSuggestionsEnabled", 0, 1) }},
        {L"startappads",    false, { TD(CU, CDM, L"SubscribedContent-338388Enabled", 0, 1) }},
        // ---- Performance / visual --------------------------------------------
        {L"taskbaranim",    true,  { TD(CU, ADV, L"TaskbarAnimations", 0, 1) }},
        {L"alphaselect",    true,  { TD(CU, ADV, L"ListviewAlphaSelect", 0, 1) }},
        {L"iconshadow",     true,  { TD(CU, ADV, L"ListviewShadow", 0, 1) }},
        {L"powerthrottle",  false, { TD(LM, L"SYSTEM\\CurrentControlSet\\Control\\Power\\PowerThrottling", L"PowerThrottlingOff", 1, 0) }},
        {L"restorefreq",    false, { TD(LM, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\SystemRestore", L"SystemRestorePointCreationFrequency", 0, 1440) }},
        {L"bsodemoticon",   false, { TD(LM, L"SYSTEM\\CurrentControlSet\\Control\\CrashControl", L"DisableEmoticon", 1, 0) }},
        // ---- Gaming -----------------------------------------------------------
        {L"cpuprio",        false, { TD(LM, GAMES, L"Priority", 6, 2) }},
        {L"gpuprio",        false, { TD(LM, GAMES, L"GPU Priority", 8, 2) }},
        {L"autohdr",        false, { TS(CU, UGP, L"AutoHDREnable", L"1", L"0") }},
        {L"vrr",            false, { TS(CU, UGP, L"VRROptimizeEnable", L"1", L"0") }},
        // ---- Power ------------------------------------------------------------
        {L"showhibernate",  false, { TD(LM, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FlyoutMenuSettings", L"ShowHibernateOption", 1, 0) }},
        {L"faststartup",    false, { TD(LM, L"SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power", L"HiberbootEnabled", 1, 0) }},
        // ---- Sound ------------------------------------------------------------
        {L"startupsound",   false, { TD(LM, L"Software\\Microsoft\\Windows\\CurrentVersion\\Authentication\\LogonUI\\BootAnimation", L"DisableStartupSound", 1, 0) }},
        {L"voiceact",       false, { TD(LM, L"Software\\Microsoft\\Windows\\CurrentVersion\\SpeechOneCore\\Settings", L"AgentActivationEnabled", 0, 1) }},
        // ---- Windows Update ---------------------------------------------------
        {L"nodriverwu",     false, { TD(LM, L"SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate", L"ExcludeWUDriversInQualityUpdate", 1, 0) }},
        {L"othermsupdates", false, { TD(LM, L"Software\\Microsoft\\WindowsUpdate\\UX\\Settings", L"AllowMUUpdateService", 1, 0) }},
        {L"noforcedreboot", false, { TD(LM, L"SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU", L"NoAutoRebootWithLoggedOnUsers", 1, 0) }},
        // ---- File Explorer ----------------------------------------------------
        {L"hiderecent",     true,  { TD(CU, L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer", L"ShowRecent", 0, 1) }},
        {L"hidefrequent",   true,  { TD(CU, L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer", L"ShowFrequent", 0, 1) }},
        {L"fullpath",       true,  { TD(CU, L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\CabinetState", L"FullPath", 1, 0) }},
        {L"compactview",    true,  { TD(CU, ADV, L"UseCompactMode", 1, 0) }},
        {L"alwaysmenus",    true,  { TD(CU, ADV, L"AlwaysShowMenus", 1, 0) }},
        {L"hideemptydrives",true,  { TD(CU, ADV, L"HideDrivesWithNoMedia", 1, 0) }},
        {L"superhidden",    true,  { TD(CU, ADV, L"ShowSuperHidden", 1, 0) }},
        {L"sepprocess",     true,  { TD(CU, ADV, L"SeparateProcess", 1, 0) }},
        {L"persistfolders", true,  { TD(CU, ADV, L"PersistBrowsers", 1, 0) }},
        {L"ntfscolor",      true,  { TD(CU, ADV, L"ShowEncryptCompressedColor", 1, 0) }},
        {L"recyclebin",     true,  { TD(CU, NSP, L"{645FF040-5081-101B-9F08-00AA002F954E}", 0, 1) }},
        {L"userfolderdesktop",true,{ TD(CU, NSP, L"{59031A47-3F72-44A7-89C5-5595FE6B30EE}", 0, 1) }},
        {L"cpldesktop",     true,  { TD(CU, NSP, L"{5399E694-6CE5-4D6C-8FCE-1D8870FDCBA0}", 0, 1) }},
        {L"networkdesktop", true,  { TD(CU, NSP, L"{F02C1A0D-BE21-4350-88B0-7367FC96EF3C}", 0, 1) }},
        {L"notransparency", true,  { TD(CU, PERS, L"EnableTransparency", 0, 1) }},
        // ---- Start menu -------------------------------------------------------
        {L"hiderecommendedfiles",true,{ TD(CU, ADV, L"Start_TrackDocs", 0, 1) }},
        {L"hideaccountnotif",true, { TD(CU, ADV, L"Start_AccountNotifications", 0, 1) }},
        // ---- Taskbar ----------------------------------------------------------
        {L"taskbarbadges",  true,  { TD(CU, ADV, L"TaskbarBadges", 0, 1) }},
        {L"taskbarflash",   true,  { TD(CU, ADV, L"TaskbarFlashing", 0, 1) }},
        {L"taskbarallmon",  true,  { TD(CU, ADV, L"MMTaskbarEnabled", 1, 0) }},
        {L"meetnow",        false, { TD(CU, L"Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer", L"HideSCAMeetNow", 1, 0) }},
        {L"alltrayicons",   true,  { TD(CU, L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer", L"EnableAutoTray", 0, 1) }},
    };
    return t;
}
static DWORD RegReadDword(HKEY hive, const wchar_t* path, const wchar_t* val, DWORD def) {
    DWORD v = def, cb = sizeof(v);
    if (RegGetValueW(hive, path, val, RRF_RT_REG_DWORD, nullptr, &v, &cb) != ERROR_SUCCESS) return def;
    return v;
}
static bool RegWriteDword(HKEY hive, const wchar_t* path, const wchar_t* val, DWORD data) {
    HKEY k;
    if (RegCreateKeyExW(hive, path, 0, nullptr, 0, KEY_SET_VALUE, nullptr, &k, nullptr) != ERROR_SUCCESS) return false;
    LONG r = RegSetValueExW(k, val, 0, REG_DWORD, (const BYTE*)&data, sizeof(data));
    RegCloseKey(k); return r == ERROR_SUCCESS;
}
static const wchar_t* kClassicMenuKey = L"Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}";
static bool ClassicMenuOn() {
    HKEY k;
    std::wstring sub = std::wstring(kClassicMenuKey) + L"\\InprocServer32";
    if (RegOpenKeyExW(HKEY_CURRENT_USER, sub.c_str(), 0, KEY_READ, &k) == ERROR_SUCCESS) { RegCloseKey(k); return true; }
    return false;
}
static void SetClassicMenu(bool on) {
    std::wstring sub = std::wstring(kClassicMenuKey) + L"\\InprocServer32";
    if (on) {
        HKEY k;
        if (RegCreateKeyExW(HKEY_CURRENT_USER, sub.c_str(), 0, nullptr, 0, KEY_SET_VALUE, nullptr, &k, nullptr) == ERROR_SUCCESS) {
            wchar_t empty[1] = L""; RegSetValueExW(k, nullptr, 0, REG_SZ, (const BYTE*)empty, sizeof(wchar_t)); RegCloseKey(k);
        }
    } else {
        RegDeleteKeyW(HKEY_CURRENT_USER, sub.c_str());
        RegDeleteKeyW(HKEY_CURRENT_USER, kClassicMenuKey);
    }
}
// --- Special tweaks (key create/delete, per-interface) handled in code -------
static void SetKeyStr(HKEY h, const wchar_t* path, const wchar_t* name, const wchar_t* val) {
    HKEY k; if (RegCreateKeyExW(h, path, 0, nullptr, 0, KEY_SET_VALUE, nullptr, &k, nullptr) == ERROR_SUCCESS) {
        RegSetValueExW(k, name, 0, REG_SZ, (const BYTE*)val, (DWORD)((wcslen(val) + 1) * sizeof(wchar_t))); RegCloseKey(k);
    }
}
static void SetGodMode(bool on) {
    if (on) {
        SetKeyStr(HKEY_CLASSES_ROOT, L"DesktopBackground\\Shell\\GodMode", nullptr, L"God Mode");
        SetKeyStr(HKEY_CLASSES_ROOT, L"DesktopBackground\\Shell\\GodMode", L"Icon", L"control.exe");
        SetKeyStr(HKEY_CLASSES_ROOT, L"DesktopBackground\\Shell\\GodMode\\command", nullptr, L"explorer shell:::{ED7BA470-8E54-465E-825C-99712043E01C}");
    } else RegDeleteTreeW(HKEY_CLASSES_ROOT, L"DesktopBackground\\Shell\\GodMode");
}
static void SetTakeOwnership(bool on) {
    if (on) {
        SetKeyStr(HKEY_CLASSES_ROOT, L"*\\shell\\runas", nullptr, L"Take Ownership");
        SetKeyStr(HKEY_CLASSES_ROOT, L"*\\shell\\runas", L"NoWorkingDirectory", L"");
        SetKeyStr(HKEY_CLASSES_ROOT, L"*\\shell\\runas\\command", nullptr, L"cmd.exe /c takeown /f \"%1\" && icacls \"%1\" /grant administrators:F");
        SetKeyStr(HKEY_CLASSES_ROOT, L"Directory\\shell\\runas", nullptr, L"Take Ownership");
        SetKeyStr(HKEY_CLASSES_ROOT, L"Directory\\shell\\runas", L"NoWorkingDirectory", L"");
        SetKeyStr(HKEY_CLASSES_ROOT, L"Directory\\shell\\runas\\command", nullptr, L"cmd.exe /c takeown /f \"%1\" /r /d y && icacls \"%1\" /grant administrators:F /t");
    } else { RegDeleteTreeW(HKEY_CLASSES_ROOT, L"*\\shell\\runas"); RegDeleteTreeW(HKEY_CLASSES_ROOT, L"Directory\\shell\\runas"); }
}
static const wchar_t* kNagleKey = L"SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces";
static bool NagleOn() {
    HKEY k; if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, kNagleKey, 0, KEY_READ, &k) != ERROR_SUCCESS) return false;
    wchar_t sub[256]; bool on = false;
    for (DWORD i = 0;; ++i) { DWORD sl = 256; if (RegEnumKeyExW(k, i, sub, &sl, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) break;
        std::wstring p = std::wstring(kNagleKey) + L"\\" + sub; DWORD v = 0, cb = sizeof(v);
        if (RegGetValueW(HKEY_LOCAL_MACHINE, p.c_str(), L"TcpAckFrequency", RRF_RT_REG_DWORD, nullptr, &v, &cb) == ERROR_SUCCESS && v == 1) { on = true; break; } }
    RegCloseKey(k); return on;
}
static void SetNagle(bool on) {
    HKEY k; if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, kNagleKey, 0, KEY_READ, &k) != ERROR_SUCCESS) return;
    std::vector<std::wstring> subs; wchar_t sub[256];
    for (DWORD i = 0;; ++i) { DWORD sl = 256; if (RegEnumKeyExW(k, i, sub, &sl, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) break; subs.push_back(sub); }
    RegCloseKey(k);
    for (auto& s : subs) { std::wstring p = std::wstring(kNagleKey) + L"\\" + s;
        if (on) { DWORD one = 1; HKEY kk; if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, p.c_str(), 0, KEY_SET_VALUE, &kk) == ERROR_SUCCESS) {
            RegSetValueExW(kk, L"TcpAckFrequency", 0, REG_DWORD, (BYTE*)&one, 4); RegSetValueExW(kk, L"TCPNoDelay", 0, REG_DWORD, (BYTE*)&one, 4); RegCloseKey(kk); } }
        else { HKEY kk; if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, p.c_str(), 0, KEY_SET_VALUE, &kk) == ERROR_SUCCESS) {
            RegDeleteValueW(kk, L"TcpAckFrequency"); RegDeleteValueW(kk, L"TCPNoDelay"); RegCloseKey(kk); } }
    }
}
// id -> 1/0 if special, -1 if not. explorer flag in the second table.
struct SpecialTw { const wchar_t* id; bool explorer; };
static const SpecialTw kSpecials[] = { {L"classicmenu", true}, {L"godmode", false}, {L"takeownership", false}, {L"nagle", false} };
static int SpecialState(const std::wstring& id) {
    if (id == L"classicmenu") return ClassicMenuOn() ? 1 : 0;
    if (id == L"godmode") return KeyExists(HKEY_CLASSES_ROOT, L"DesktopBackground\\Shell\\GodMode") ? 1 : 0;
    if (id == L"takeownership") return KeyExists(HKEY_CLASSES_ROOT, L"*\\shell\\runas") ? 1 : 0;
    if (id == L"nagle") return NagleOn() ? 1 : 0;
    return -1;
}
static bool SpecialSet(const std::wstring& id, bool on) {
    if (id == L"classicmenu") { SetClassicMenu(on); return true; }
    if (id == L"godmode") { SetGodMode(on); return true; }
    if (id == L"takeownership") { SetTakeOwnership(on); return true; }
    if (id == L"nagle") { SetNagle(on); return true; }
    return false;
}
static bool TweakState(const TweakDef& t) {
    const RegOp& o = t.ops[0];
    if (o.isStr) {
        wchar_t buf[512] = L""; DWORD cb = sizeof(buf);
        if (RegGetValueW(o.hive, o.path.c_str(), o.val.c_str(), RRF_RT_REG_SZ, nullptr, buf, &cb) != ERROR_SUCCESS) return false;
        return std::wstring(buf) == o.onS;
    }
    return RegReadDword(o.hive, o.path.c_str(), o.val.c_str(), o.offD) == o.onD;
}
static std::wstring TweaksJson() {
    std::wstring o = L"{\"type\":\"tweaks\",\"data\":[";
    bool first = true;
    for (const auto& s : kSpecials) { if (!first) o += L","; first = false;
        o += L"{\"id\":\"" + std::wstring(s.id) + L"\",\"on\":" + JB(SpecialState(s.id) == 1) + L",\"explorer\":" + JB(s.explorer) + L"}"; }
    for (const auto& t : Tweaks())
        o += L",{\"id\":\"" + t.id + L"\",\"on\":" + JB(TweakState(t)) + L",\"explorer\":" + JB(t.explorer) + L"}";
    return o + L"]}";
}
static void ApplyOp(const RegOp& o, bool on) {
    if (o.isStr) {
        const std::wstring& s = on ? o.onS : o.offS;
        HKEY k;
        if (RegCreateKeyExW(o.hive, o.path.c_str(), 0, nullptr, 0, KEY_SET_VALUE, nullptr, &k, nullptr) == ERROR_SUCCESS) {
            RegSetValueExW(k, o.val.c_str(), 0, REG_SZ, (const BYTE*)s.c_str(), (DWORD)((s.size() + 1) * sizeof(wchar_t)));
            RegCloseKey(k);
        }
    } else RegWriteDword(o.hive, o.path.c_str(), o.val.c_str(), on ? o.onD : o.offD);
}
static void SetTweak(const std::wstring& id, bool on) {
    if (SpecialSet(id, on)) return;
    for (const auto& t : Tweaks()) if (id == t.id) { for (const auto& op : t.ops) ApplyOp(op, on); return; }
}
static void RestartExplorer() { RunProcess(L"cmd.exe /c taskkill /f /im explorer.exe & start explorer.exe"); }

// ===========================================================================
// Debloat (experimental) - one-shot ACTIONS (not reversible toggles): app/
// OneDrive/Edge removal, services, DNS, repairs. From winutil/Winhance.
// ===========================================================================
static std::wstring DebloatCmd(const std::wstring& a) {
    if (a == L"onedrive")
        return L"cmd /c \"%SystemRoot%\\System32\\OneDriveSetup.exe /uninstall & %SystemRoot%\\SysWOW64\\OneDriveSetup.exe /uninstall\"";
    if (a == L"servicesmanual")
        return L"powershell -NoProfile -ExecutionPolicy Bypass -Command \""
               L"'DiagTrack','dmwappushservice','MapsBroker','RetailDemo','RemoteRegistry','WMPNetworkSvc' | "
               L"%{ Set-Service $_ -StartupType Disabled -ErrorAction SilentlyContinue }\"";
    if (a == L"edgedebloat")
        return L"cmd /c \"reg add \\\"HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\\" /v PersonalizationReportingEnabled /t REG_DWORD /d 0 /f"
               L" & reg add \\\"HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\\" /v ShowRecommendationsEnabled /t REG_DWORD /d 0 /f"
               L" & reg add \\\"HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\\" /v HubsSidebarEnabled /t REG_DWORD /d 0 /f"
               L" & reg add \\\"HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\\" /v EdgeShoppingAssistantEnabled /t REG_DWORD /d 0 /f"
               L" & reg add \\\"HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\\" /v WalletDonationEnabled /t REG_DWORD /d 0 /f\"";
    if (a == L"dnscf")
        return L"powershell -NoProfile -ExecutionPolicy Bypass -Command \"Get-DnsClientServerAddress -AddressFamily IPv4 | "
               L"%{ Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ServerAddresses 1.1.1.1,1.0.0.1 -ErrorAction SilentlyContinue }\"";
    if (a == L"dnsgoogle")
        return L"powershell -NoProfile -ExecutionPolicy Bypass -Command \"Get-DnsClientServerAddress -AddressFamily IPv4 | "
               L"%{ Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ServerAddresses 8.8.8.8,8.8.4.4 -ErrorAction SilentlyContinue }\"";
    if (a == L"dnsauto")
        return L"powershell -NoProfile -ExecutionPolicy Bypass -Command \"Get-DnsClientServerAddress -AddressFamily IPv4 | "
               L"%{ Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ResetServerAddresses -ErrorAction SilentlyContinue }\"";
    if (a == L"ultperf")
        return L"cmd /c powercfg -duplicatescheme e9a42b02-d5df-448d-aa00-03f14749eb61";
    if (a == L"temp")
        return L"powershell -NoProfile -ExecutionPolicy Bypass -Command \"Remove-Item -Path $env:TEMP\\* -Recurse -Force -ErrorAction SilentlyContinue\"";
    if (a == L"sfc")
        return L"cmd /c \"sfc /scannow & DISM /Online /Cleanup-Image /RestoreHealth\"";
    if (a == L"wureset")
        return L"cmd /c \"net stop wuauserv & net stop bits & net stop cryptsvc & "
               L"ren %systemroot%\\SoftwareDistribution SoftwareDistribution.old & "
               L"ren %systemroot%\\System32\\catroot2 catroot2.old & "
               L"net start wuauserv & net start bits & net start cryptsvc\"";
    if (a == L"netreset")
        return L"cmd /c \"netsh winsock reset & netsh int ip reset & ipconfig /flushdns\"";
    // Windows optional features (DISM /NoRestart).
    if (a == L"net35")       return L"cmd /c DISM /Online /Enable-Feature /FeatureName:NetFx3 /All /NoRestart";
    if (a == L"hyperv")      return L"cmd /c DISM /Online /Enable-Feature /FeatureName:Microsoft-Hyper-V /All /NoRestart";
    if (a == L"wsl")         return L"cmd /c \"DISM /Online /Enable-Feature /FeatureName:Microsoft-Windows-Subsystem-Linux /All /NoRestart & DISM /Online /Enable-Feature /FeatureName:VirtualMachinePlatform /All /NoRestart\"";
    if (a == L"sandbox")     return L"cmd /c DISM /Online /Enable-Feature /FeatureName:Containers-DisposableClientVM /All /NoRestart";
    if (a == L"nfs")         return L"cmd /c \"DISM /Online /Enable-Feature /FeatureName:ServicesForNFS-ClientOnly /All /NoRestart & DISM /Online /Enable-Feature /FeatureName:ClientForNFS-Infrastructure /All /NoRestart\"";
    if (a == L"legacymedia") return L"cmd /c \"DISM /Online /Enable-Feature /FeatureName:DirectPlay /All /NoRestart & DISM /Online /Enable-Feature /FeatureName:LegacyComponents /All /NoRestart\"";
    // More one-shot actions.
    if (a == L"bitlockeroff") return L"cmd /c manage-bde -off C:";
    if (a == L"adobeblock")
        return L"powershell -NoProfile -ExecutionPolicy Bypass -Command \"$h=\\\"$env:windir\\System32\\drivers\\etc\\hosts\\\";"
               L"$e='0.0.0.0 lm.licenses.adobe.com','0.0.0.0 lmlicenses.wip4.adobe.com','0.0.0.0 na1r.services.adobe.com','0.0.0.0 hlrcv.stage.adobe.com','0.0.0.0 practivate.adobe.com','0.0.0.0 activate.adobe.com';"
               L"foreach($l in $e){ if(-not(Select-String -Path $h -SimpleMatch $l -Quiet)){ Add-Content -Path $h -Value $l } }\"";
    if (a == L"bravedebloat")
        return L"cmd /c \"reg add \\\"HKLM\\SOFTWARE\\Policies\\BraveSoftware\\Brave\\\" /v BraveRewardsDisabled /t REG_DWORD /d 1 /f"
               L" & reg add \\\"HKLM\\SOFTWARE\\Policies\\BraveSoftware\\Brave\\\" /v BraveWalletDisabled /t REG_DWORD /d 1 /f"
               L" & reg add \\\"HKLM\\SOFTWARE\\Policies\\BraveSoftware\\Brave\\\" /v BraveVPNDisabled /t REG_DWORD /d 1 /f"
               L" & reg add \\\"HKLM\\SOFTWARE\\Policies\\BraveSoftware\\Brave\\\" /v BraveAIChatEnabled /t REG_DWORD /d 0 /f"
               L" & reg add \\\"HKLM\\SOFTWARE\\Policies\\BraveSoftware\\Brave\\\" /v PasswordManagerEnabled /t REG_DWORD /d 0 /f\"";
    // ---- Experimental extras from winutil / Winhance (risky; user opted in) ----
    if (a == L"memoryintegrity")
        return L"cmd /c reg add \\\"HKLM\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity\\\" /v Enabled /t REG_DWORD /d 0 /f";
    if (a == L"vbs")
        return L"cmd /c reg add \\\"HKLM\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\\" /v EnableVirtualizationBasedSecurity /t REG_DWORD /d 0 /f";
    if (a == L"uaclower")
        return L"cmd /c \"reg add \\\"HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\\" /v ConsentPromptBehaviorAdmin /t REG_DWORD /d 0 /f"
               L" & reg add \\\"HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\\" /v PromptOnSecureDesktop /t REG_DWORD /d 0 /f\"";
    if (a == L"blockwinupdate")
        return L"cmd /c \"reg add \\\"HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU\\\" /v NoAutoUpdate /t REG_DWORD /d 1 /f"
               L" & reg add \\\"HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU\\\" /v AUOptions /t REG_DWORD /d 2 /f\"";
    if (a == L"deferfeature")
        return L"cmd /c \"reg add \\\"HKLM\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings\\\" /v DeferFeatureUpdates /t REG_DWORD /d 1 /f"
               L" & reg add \\\"HKLM\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings\\\" /v DeferFeatureUpdatesPeriodInDays /t REG_DWORD /d 365 /f\"";
    if (a == L"s3sleep")
        return L"cmd /c reg add \\\"HKLM\\SYSTEM\\CurrentControlSet\\Control\\Power\\\" /v PlatformAoAcOverride /t REG_DWORD /d 0 /f";
    if (a == L"opensshserver")
        return L"powershell -NoProfile -ExecutionPolicy Bypass -Command \"Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 -ErrorAction SilentlyContinue;"
               L" Set-Service sshd -StartupType Automatic -ErrorAction SilentlyContinue; Start-Service sshd -ErrorAction SilentlyContinue\"";
    if (a == L"f8recovery")
        return L"cmd /c bcdedit /set {current} bootmenupolicy legacy";
    if (a == L"ntppool")
        return L"cmd /c \"w32tm /config /manualpeerlist:pool.ntp.org /syncfromflags:manual /reliable:yes /update & net stop w32time & net start w32time & w32tm /resync\"";
    if (a == L"svcsysmain")
        return L"cmd /c \"sc config SysMain start= disabled & sc stop SysMain\"";
    if (a == L"svcspooler")
        return L"cmd /c \"sc config Spooler start= disabled & sc stop Spooler\"";
    if (a == L"svcsearch")
        return L"cmd /c \"sc config WSearch start= disabled & sc stop WSearch\"";
    if (a == L"schedtasks")
        return L"cmd /c \""
               L"schtasks /Change /TN \\\"\\Microsoft\\Windows\\Application Experience\\Microsoft Compatibility Appraiser\\\" /Disable"
               L" & schtasks /Change /TN \\\"\\Microsoft\\Windows\\Application Experience\\ProgramDataUpdater\\\" /Disable"
               L" & schtasks /Change /TN \\\"\\Microsoft\\Windows\\Customer Experience Improvement Program\\Consolidator\\\" /Disable"
               L" & schtasks /Change /TN \\\"\\Microsoft\\Windows\\Customer Experience Improvement Program\\UsbCeip\\\" /Disable"
               L" & schtasks /Change /TN \\\"\\Microsoft\\Windows\\Feedback\\Siuf\\DmClient\\\" /Disable"
               L" & schtasks /Change /TN \\\"\\Microsoft\\Windows\\Feedback\\Siuf\\DmClientOnScenarioDownload\\\" /Disable"
               L" & schtasks /Change /TN \\\"\\Microsoft\\Windows\\Autochk\\Proxy\\\" /Disable\"";
    if (a == L"wudefault")
        return L"cmd /c \"reg delete \\\"HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\\" /f"
               L" & reg delete \\\"HKLM\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings\\\" /v DeferFeatureUpdates /f"
               L" & reg delete \\\"HKLM\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings\\\" /v DeferFeatureUpdatesPeriodInDays /f\"";
    if (a == L"resetprinters")
        return L"cmd /c \"net stop spooler & del /Q /F %systemroot%\\System32\\spool\\PRINTERS\\* & net start spooler\"";
    return L"";
}
// Clean orphaned C:\Windows\Installer .msi/.msp left by uninstalled products.
// Builds the keep-set from the Windows Installer database (products + patches),
// then sends everything else to the Recycle Bin (recoverable). From InstallerClean.
static bool InstallerClean(unsigned long long* reclaimed) {
    std::set<std::wstring> keep;  // lowercase filenames still referenced
    auto baseLower = [](const std::wstring& p) { size_t s = p.find_last_of(L'\\'); std::wstring n = (s == std::wstring::npos) ? p : p.substr(s + 1); std::transform(n.begin(), n.end(), n.begin(), towlower); return n; };
    wchar_t prod[40];
    for (DWORD i = 0; MsiEnumProductsW(i, prod) == ERROR_SUCCESS; ++i) {
        wchar_t pkg[MAX_PATH] = L""; DWORD cb = MAX_PATH;
        if (MsiGetProductInfoW(prod, INSTALLPROPERTY_LOCALPACKAGE, pkg, &cb) == ERROR_SUCCESS && pkg[0]) keep.insert(baseLower(pkg));
        wchar_t patch[40], xf[1024]; DWORD xc = 1024;
        for (DWORD j = 0; ; ++j) {
            xc = 1024; UINT r = MsiEnumPatchesW(prod, j, patch, xf, &xc);
            if (r != ERROR_SUCCESS && r != ERROR_MORE_DATA) break;
            wchar_t msp[MAX_PATH] = L""; DWORD mc = MAX_PATH;
            if (MsiGetPatchInfoW(patch, INSTALLPROPERTY_LOCALPACKAGE, msp, &mc) == ERROR_SUCCESS && msp[0]) keep.insert(baseLower(msp));
        }
    }
    if (keep.empty()) return false;  // safety: never delete if we couldn't read the DB
    std::wstring dir = L"C:\\Windows\\Installer";
    std::wstring toDelete; toDelete.reserve(4096); unsigned long long freed = 0;
    const wchar_t* pats[] = { L"\\*.msi", L"\\*.msp" };
    for (auto pat : pats) {
        WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW((dir + pat).c_str(), &fd);
        if (h == INVALID_HANDLE_VALUE) continue;
        do {
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
            std::wstring fn = fd.cFileName, low = fn; std::transform(low.begin(), low.end(), low.begin(), towlower);
            if (keep.count(low)) continue;
            toDelete += dir + L"\\" + fn; toDelete.push_back(L'\0');
            freed += ((unsigned long long)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
        } while (FindNextFileW(h, &fd));
        FindClose(h);
    }
    if (reclaimed) *reclaimed = freed;
    if (toDelete.empty()) return true;  // nothing orphaned
    toDelete.push_back(L'\0');
    SHFILEOPSTRUCTW op{}; op.wFunc = FO_DELETE; op.pFrom = toDelete.c_str();
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT;  // Recycle Bin = recoverable
    return SHFileOperationW(&op) == 0;
}
static DWORD WINAPI DebloatThread(LPVOID) {
    bool ok = false;
    if (g_debloatAction == L"installerclean") {
        unsigned long long freed = 0; ok = InstallerClean(&freed);
        PushJson(L"{\"type\":\"debloatdone\",\"action\":" + JS(g_debloatAction) + L",\"ok\":" + JB(ok) +
                 L",\"freedKb\":" + std::to_wstring(freed / 1024) + L"}");
        g_runDebloat = false; return 0;
    }
    std::wstring cmd = DebloatCmd(g_debloatAction);
    if (!cmd.empty()) { DWORD rc = RunProcess(cmd); ok = (rc == 0 || rc == 3010); }
    PushJson(L"{\"type\":\"debloatdone\",\"action\":" + JS(g_debloatAction) + L",\"ok\":" + JB(ok) + L"}");
    g_runDebloat = false; return 0;
}
// Installed Store (Appx) apps - listed and removed INDIVIDUALLY (not in bulk).
static std::wstring g_appxName;
static std::wstring AppxListJson() {
    std::wstring tmp = ProgDataDir() + L"\\appx.txt"; DeleteFileW(tmp.c_str());
    RunProcess(L"powershell -NoProfile -ExecutionPolicy Bypass -Command \"Get-AppxPackage | "
               L"Where-Object { -not $_.IsFramework -and $_.SignatureKind -ne 'System' } | Sort-Object Name | "
               L"ForEach-Object { $_.Name } | Out-File -Encoding ASCII '" + tmp + L"'\"");
    std::wstring txt; ReadUtf8File(tmp, txt);
    std::wstring o = L"{\"type\":\"appxlist\",\"data\":["; bool first = true; size_t p = 0;
    while (p < txt.size()) {
        size_t nl = txt.find(L'\n', p);
        std::wstring line = txt.substr(p, nl == std::wstring::npos ? std::wstring::npos : nl - p);
        p = (nl == std::wstring::npos) ? txt.size() : nl + 1;
        if (!line.empty() && line.back() == L'\r') line.pop_back();
        if (line.empty()) continue; if (!first) o += L","; first = false; o += JS(line);
    }
    return o + L"]}";
}
static DWORD WINAPI AppxListThread(LPVOID) { PushJson(AppxListJson()); g_runDebloat = false; return 0; }
static DWORD WINAPI AppxRemoveThread(LPVOID) {
    if (!g_appxName.empty())
        RunProcess(L"powershell -NoProfile -ExecutionPolicy Bypass -Command \"Get-AppxPackage -AllUsers '" + g_appxName +
                   L"' | Remove-AppxPackage -ErrorAction SilentlyContinue\"");
    PushJson(L"{\"type\":\"appxremoved\",\"name\":" + JS(g_appxName) + L"}");
    PushJson(AppxListJson());
    g_runDebloat = false; return 0;
}

// Winget app installer (new "Install" category). Install/uninstall by package id.
static std::wstring g_wingetId, g_wingetAct;
static DWORD WINAPI WingetThread(LPVOID) {
    bool inst = (g_wingetAct != L"uninstall");
    std::wstring id = g_wingetId;
    PushJson(L"{\"type\":\"wingetlog\",\"text\":" + JS((inst ? L"Installing " : L"Uninstalling ") + id + L" ...") + L"}");
    std::wstring cmd = inst
        ? L"cmd /c winget install --id " + id + L" -e --silent --accept-package-agreements --accept-source-agreements"
        : L"cmd /c winget uninstall --id " + id + L" -e --silent";
    DWORD rc = RunProcess(cmd);
    bool ok = (rc == 0);
    PushJson(L"{\"type\":\"wingetlog\",\"text\":" + JS(id + (ok ? L"  -  done" : L"  -  failed (code " + std::to_wstring(rc) + L")")) + L"}");
    PushJson(L"{\"type\":\"wingetdone\",\"id\":" + JS(id) + L",\"ok\":" + JB(ok) + L"}");
    g_runInstall = false; return 0;
}

// Search the FULL winget catalog (not just the curated list).
static std::wstring g_wingetQuery;
static DWORD WINAPI WingetSearchThread(LPVOID) {
    std::wstring q = g_wingetQuery;
    for (auto& c : q) if (c == L'"') c = L' ';  // sanitize
    std::wstring tmp = ProgDataDir() + L"\\wgsearch.txt"; DeleteFileW(tmp.c_str());
    RunProcess(L"cmd /c chcp 65001>nul & winget search \"" + q + L"\" --source winget --accept-source-agreements --disable-interactivity > \"" + tmp + L"\" 2>nul");
    std::wstring txt; ReadUtf8File(tmp, txt);
    // Split into lines; locate the dashed separator; parse rows by runs of 2+ spaces.
    std::vector<std::wstring> lines; { size_t p = 0; while (p < txt.size()) { size_t nl = txt.find(L'\n', p);
        std::wstring ln = txt.substr(p, nl == std::wstring::npos ? std::wstring::npos : nl - p);
        if (!ln.empty() && ln.back() == L'\r') ln.pop_back(); lines.push_back(ln);
        if (nl == std::wstring::npos) break; p = nl + 1; } }
    int sep = -1; for (int i = 0; i < (int)lines.size(); ++i) { const std::wstring& l = lines[i];
        if (l.size() > 8 && l.find_first_not_of(L"-") == std::wstring::npos) { sep = i; break; } }
    std::wstring o = L"{\"type\":\"wingetsearch\",\"data\":["; int n = 0;
    for (int i = sep + 1; sep >= 0 && i < (int)lines.size() && n < 50; ++i) {
        const std::wstring& l = lines[i]; if (l.empty()) continue;
        std::vector<std::wstring> f; size_t p = 0;
        while (p < l.size()) { while (p < l.size() && l[p] == L' ') p++; size_t s = p;
            while (p < l.size() && !(l[p] == L' ' && p + 1 < l.size() && l[p + 1] == L' ')) p++;
            std::wstring tok = l.substr(s, p - s); while (!tok.empty() && tok.back() == L' ') tok.pop_back();
            if (!tok.empty()) f.push_back(tok); }
        if (f.size() < 2) continue;
        std::wstring name = f[0], id = f[1], ver = f.size() > 2 ? f[2] : L"";
        if (id.find(L'.') == std::wstring::npos || id.find(L' ') != std::wstring::npos) continue;  // not an id
        if (n++) o += L","; o += L"{\"name\":" + JS(name) + L",\"id\":" + JS(id) + L",\"version\":" + JS(ver) + L"}";
    }
    o += L"]}"; PushJson(o);
    g_runInstall = false; return 0;
}

// ===========================================================================
// 0.3 batch 1: app updates (winget), Wi-Fi keys, DNS benchmark, repair, EOL
// ===========================================================================
#include <wlanapi.h>

// --- Update installed apps: list outdated via "winget upgrade" ---
static DWORD WINAPI WingetUpgradesThread(LPVOID) {
    std::wstring tmp = ProgDataDir() + L"\\wgup.txt"; DeleteFileW(tmp.c_str());
    RunProcess(L"cmd /c chcp 65001>nul & winget upgrade --include-unknown --accept-source-agreements --disable-interactivity > \"" + tmp + L"\" 2>nul");
    std::wstring txt; ReadUtf8File(tmp, txt);
    std::vector<std::wstring> lines; { size_t p = 0; while (p < txt.size()) { size_t nl = txt.find(L'\n', p);
        std::wstring ln = txt.substr(p, nl == std::wstring::npos ? std::wstring::npos : nl - p);
        if (!ln.empty() && ln.back() == L'\r') ln.pop_back(); lines.push_back(ln);
        if (nl == std::wstring::npos) break; p = nl + 1; } }
    int sep = -1; for (int i = 0; i < (int)lines.size(); ++i) { const std::wstring& l = lines[i];
        if (l.size() > 8 && l.find_first_not_of(L"-") == std::wstring::npos) { sep = i; break; } }
    // winget prints a fixed-width table; column starts come from the header line
    // (just above the dashes). Slicing by those offsets is robust to truncated
    // names and narrow pipe widths (2-space splitting misaligned VS Code etc.).
    std::wstring header = (sep >= 1) ? lines[sep - 1] : L"";
    std::vector<size_t> col; { size_t p = 0; while (p < header.size()) {
        while (p < header.size() && header[p] == L' ') p++; if (p >= header.size()) break; col.push_back(p);
        while (p < header.size() && !(header[p] == L' ' && p + 1 < header.size() && header[p + 1] == L' ')) p++; } }
    auto slice = [](const std::wstring& row, size_t a, size_t b)->std::wstring {
        if (a >= row.size()) return L"";
        std::wstring s = row.substr(a, (b == std::wstring::npos || b <= a) ? std::wstring::npos : b - a);
        size_t y = s.find_first_not_of(L" "); if (y == std::wstring::npos) return L""; s = s.substr(y);
        size_t x = s.find_last_not_of(L" "); if (x != std::wstring::npos) s = s.substr(0, x + 1); return s; };
    std::wstring o = L"{\"type\":\"wingetups\",\"data\":["; int n = 0;
    for (int i = sep + 1; sep >= 0 && col.size() >= 4 && i < (int)lines.size(); ++i) {
        const std::wstring& l = lines[i]; if (l.empty()) continue;
        if (l.find(L"upgrades available") != std::wstring::npos) break;
        if (l.find(L"explicit targeting") != std::wstring::npos) break;
        std::wstring name = slice(l, col[0], col[1]);
        std::wstring id   = slice(l, col[1], col[2]);
        std::wstring cur  = slice(l, col[2], col[3]);
        std::wstring avail = slice(l, col[3], col.size() > 4 ? col[4] : std::wstring::npos);
        // a real winget id has a dot AND a letter and no spaces (rejects version-like mis-parses)
        bool hasDot = id.find(L'.') != std::wstring::npos, hasAlpha = false, hasSpace = id.find(L' ') != std::wstring::npos;
        for (wchar_t c : id) if (iswalpha(c)) { hasAlpha = true; break; }
        if (!hasDot || !hasAlpha || hasSpace) continue;
        if (n++) o += L","; o += L"{\"name\":" + JS(name) + L",\"id\":" + JS(id) + L",\"cur\":" + JS(cur) + L",\"avail\":" + JS(avail) + L"}";
    }
    o += L"]}"; PushJson(o); g_runInstall = false; return 0;
}
#include <tlhelp32.h>
static std::wstring g_upgradeId;  // empty = update all (the UI updates one app at a time)
// Run a command, stream its stdout/stderr to the install log in real time, and
// enforce a timeout (kills the process tree) so a single package can never hang
// the whole app. Optionally collects all emitted lines into `sink` for analysis.
// Returns the exit code, or 0xDEAD if it timed out.
static DWORD RunWingetStream(const std::wstring& cmdline, DWORD timeoutMs, std::wstring* sink = nullptr) {
    SECURITY_ATTRIBUTES sa{ sizeof(sa), nullptr, TRUE }; HANDLE rd = nullptr, wr = nullptr;
    if (!CreatePipe(&rd, &wr, &sa, 0)) return (DWORD)-1;
    SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);
    STARTUPINFOW si{ sizeof(si) }; si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW; si.wShowWindow = SW_HIDE;
    si.hStdOutput = wr; si.hStdError = wr;
    PROCESS_INFORMATION pi{}; std::wstring cl = cmdline;
    BOOL ok = CreateProcessW(nullptr, &cl[0], nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi);
    CloseHandle(wr);
    if (!ok) { CloseHandle(rd); return (DWORD)-1; }
    ULONGLONG startTick = GetTickCount64(); std::string acc; char buf[2048]; bool timedout = false;
    for (;;) {
        DWORD avail = 0;
        if (PeekNamedPipe(rd, nullptr, 0, nullptr, &avail, nullptr) && avail > 0) {
            DWORD n = 0;
            if (ReadFile(rd, buf, sizeof(buf), &n, nullptr) && n > 0) {
                acc.append(buf, n); size_t pos;
                while ((pos = acc.find_first_of("\r\n")) != std::string::npos) {
                    std::string line = acc.substr(0, pos); acc.erase(0, pos + 1);
                    if (line.find_first_not_of(" \t") == std::string::npos) continue;
                    int wl = MultiByteToWideChar(CP_UTF8, 0, line.c_str(), (int)line.size(), nullptr, 0);
                    std::wstring w(wl > 0 ? wl : 0, 0); if (wl > 0) MultiByteToWideChar(CP_UTF8, 0, line.c_str(), (int)line.size(), &w[0], wl);
                    if (w.find_first_not_of(L" \\|/-_.█▒▀●○\t") == std::wstring::npos) continue;  // skip progress-bar lines
                    if (w.find(L"KB /") != std::wstring::npos || w.find(L"MB /") != std::wstring::npos || w.find(L"GB /") != std::wstring::npos) continue;
                    if (sink) { *sink += w; *sink += L"\n"; }
                    PushJson(L"{\"type\":\"wingetlog\",\"text\":" + JS(w) + L"}");
                }
            }
            continue;
        }
        if (WaitForSingleObject(pi.hProcess, 0) == WAIT_OBJECT_0) break;
        if (GetTickCount64() - startTick > timeoutMs) { timedout = true; break; }
        Sleep(150);
    }
    if (timedout) RunProcess(L"taskkill /PID " + std::to_wstring(pi.dwProcessId) + L" /T /F");
    WaitForSingleObject(pi.hProcess, 5000);
    DWORD rc = 0; GetExitCodeProcess(pi.hProcess, &rc);
    CloseHandle(rd); CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
    return timedout ? 0xDEAD : rc;
}
// Find running processes that belong to a winget package, so we can offer to
// close them when an update fails because "the application is currently running".
static std::wstring NormTok(const std::wstring& s) { std::wstring o; for (wchar_t c : s) if (iswalnum(c)) o += towlower(c); return o; }
static std::vector<std::pair<DWORD, std::wstring>> FindAppProcs(const std::wstring& id) {
    std::vector<std::pair<DWORD, std::wstring>> out;
    std::wstring last = id; size_t d = id.find_last_of(L'.'); if (d != std::wstring::npos) last = id.substr(d + 1);
    std::wstring tok = NormTok(last); if (tok.size() < 3) return out;
    std::wstring windir; { wchar_t b[MAX_PATH]; if (GetWindowsDirectoryW(b, MAX_PATH)) { windir = b; for (auto& c : windir) c = towlower(c); } }
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0); if (snap == INVALID_HANDLE_VALUE) return out;
    PROCESSENTRY32W pe{ sizeof(pe) };
    if (Process32FirstW(snap, &pe)) { do {
        std::wstring exe = pe.szExeFile, base = exe; size_t dot = base.find_last_of(L'.'); if (dot != std::wstring::npos) base = base.substr(0, dot);
        std::wstring nb = NormTok(base); if (nb.empty()) continue;
        bool match = (nb.find(tok) != std::wstring::npos) || (nb.size() >= 4 && tok.find(nb) != std::wstring::npos);
        if (!match) continue;
        HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pe.th32ProcessID); std::wstring path;
        if (h) { wchar_t p[MAX_PATH]; DWORD cb = MAX_PATH; if (QueryFullProcessImageNameW(h, 0, p, &cb)) path = p; CloseHandle(h); }
        std::wstring lp = path; for (auto& c : lp) c = towlower(c);
        if (!windir.empty() && lp.rfind(windir, 0) == 0) continue;  // never offer to kill OS processes
        out.push_back({ pe.th32ProcessID, exe });
    } while (Process32NextW(snap, &pe)); }
    CloseHandle(snap); return out;
}
static void WingetUpgradeRun() {
    std::wstring id = g_upgradeId;
    std::wstring tgt = id.empty() ? L"--all --include-unknown" : (L"--id " + id + L" -e --include-unknown");
    std::wstring cmd = L"cmd /c chcp 65001>nul & winget upgrade " + tgt +
        L" --silent --disable-interactivity --accept-package-agreements --accept-source-agreements --force";
    std::wstring sink;
    DWORD rc = RunWingetStream(cmd, 10 * 60 * 1000, &sink);  // 10-minute per-app safety timeout
    if (rc == 0xDEAD) PushJson(L"{\"type\":\"wingetlog\",\"text\":" + JS(L"--- timed out after 10 min, skipped " + (id.empty() ? std::wstring(L"") : id) + L" ---") + L"}");
    else PushJson(L"{\"type\":\"wingetlog\",\"text\":" + JS(L"--- finished (exit code " + std::to_wstring(rc) + L") ---") + L"}");
    // If the update failed only because the app is open, offer to close it and retry.
    if (!id.empty() && (sink.find(L"currently running") != std::wstring::npos || sink.find(L"Exit the application") != std::wstring::npos)) {
        std::wstring name = id; size_t fp = sink.find(L"Found ");
        if (fp != std::wstring::npos) { size_t br = sink.find(L" [", fp); if (br != std::wstring::npos) name = sink.substr(fp + 6, br - (fp + 6)); }
        auto procs = FindAppProcs(id);
        std::wstring o = L"{\"type\":\"wingetrunning\",\"id\":" + JS(id) + L",\"name\":" + JS(name) + L",\"procs\":[";
        for (size_t i = 0; i < procs.size(); i++) { if (i) o += L","; o += L"{\"pid\":" + std::to_wstring(procs[i].first) + L",\"exe\":" + JS(procs[i].second) + L"}"; }
        PushJson(o + L"]}");
    }
    PushJson(L"{\"type\":\"wingetupdone\"}");
}
static DWORD WINAPI WingetUpgradeThread(LPVOID) { WingetUpgradeRun(); g_runInstall = false; return 0; }
static std::wstring g_killPids;
static DWORD WINAPI KillRetryThread(LPVOID) {
    std::wstring s = g_killPids; size_t p = 0;
    while (p < s.size()) { size_t c = s.find(L',', p); std::wstring t = s.substr(p, c == std::wstring::npos ? std::wstring::npos : c - p);
        if (!t.empty()) { DWORD pid = (DWORD)_wtoi(t.c_str()); HANDLE h = OpenProcess(PROCESS_TERMINATE, FALSE, pid); if (h) { TerminateProcess(h, 1); CloseHandle(h); } }
        if (c == std::wstring::npos) break; p = c + 1; }
    Sleep(1200);  // let the app fully exit before retrying
    WingetUpgradeRun();
    g_runInstall = false; return 0;
}

// --- Wi-Fi saved networks + passwords (WLAN API, locale-independent) ---
static std::wstring XmlTag(const std::wstring& xml, const wchar_t* tag) {
    std::wstring open = std::wstring(L"<") + tag + L">", close = std::wstring(L"</") + tag + L">";
    size_t s = xml.find(open); if (s == std::wstring::npos) return L""; s += open.size();
    size_t e = xml.find(close, s); if (e == std::wstring::npos) return L""; return xml.substr(s, e - s);
}
static std::wstring WifiKeysJson() {
    std::wstring o = L"{\"type\":\"wifikeys\",\"data\":["; int n = 0;
    HANDLE h = nullptr; DWORD ver = 0;
    if (WlanOpenHandle(2, nullptr, &ver, &h) == ERROR_SUCCESS) {
        PWLAN_INTERFACE_INFO_LIST il = nullptr;
        if (WlanEnumInterfaces(h, nullptr, &il) == ERROR_SUCCESS) {
            for (DWORD i = 0; i < il->dwNumberOfItems; i++) {
                GUID g = il->InterfaceInfo[i].InterfaceGuid;
                PWLAN_PROFILE_INFO_LIST pl = nullptr;
                if (WlanGetProfileList(h, &g, nullptr, &pl) == ERROR_SUCCESS) {
                    for (DWORD j = 0; j < pl->dwNumberOfItems; j++) {
                        std::wstring name = pl->ProfileInfo[j].strProfileName;
                        DWORD flags = WLAN_PROFILE_GET_PLAINTEXT_KEY, acc = 0; LPWSTR xml = nullptr; std::wstring key;
                        if (WlanGetProfile(h, &g, name.c_str(), nullptr, &xml, &flags, &acc) == ERROR_SUCCESS && xml) {
                            std::wstring x = xml; key = XmlTag(x, L"keyMaterial"); WlanFreeMemory(xml);
                        }
                        if (n++) o += L","; o += L"{\"ssid\":" + JS(name) + L",\"key\":" + JS(key) + L"}";
                    }
                    WlanFreeMemory(pl);
                }
            }
            WlanFreeMemory(il);
        }
        WlanCloseHandle(h, nullptr);
    }
    return o + L"]}";
}

// --- DNS benchmark: latency to popular resolvers (reuses ICMP PingMs) ---
static DWORD WINAPI DnsBenchThread(LPVOID) {
    struct R { const wchar_t* name; const char* ip; };
    R rs[] = { {L"Cloudflare", "1.1.1.1"}, {L"Google", "8.8.8.8"}, {L"Quad9", "9.9.9.9"},
               {L"OpenDNS", "208.67.222.222"}, {L"AdGuard", "94.140.14.14"} };
    std::wstring o = L"{\"type\":\"dnsbench\",\"data\":[";
    for (int i = 0; i < 5; i++) {
        int sum = 0, ok = 0;
        for (int k = 0; k < 3; k++) { int ms = PingMs(inet_addr(rs[i].ip)); if (ms >= 0) { sum += ms; ok++; } }
        int avg = ok ? sum / ok : -1;
        std::string ips = rs[i].ip;
        if (i) o += L","; o += L"{\"name\":" + JS(rs[i].name) + L",\"ip\":" + JS(std::wstring(ips.begin(), ips.end())) + L",\"ms\":" + std::to_wstring(avg) + L"}";
    }
    o += L"]}"; PushJson(o); g_runNet = false; return 0;
}

// --- Windows lifecycle / end-of-life warning ---
static std::wstring LifecycleJson() {
    auto rs = [](const wchar_t* v)->std::wstring { wchar_t buf[256]; DWORD cb = sizeof(buf), ty = 0;
        if (RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", v, RRF_RT_REG_SZ, &ty, buf, &cb) == ERROR_SUCCESS) return buf; return L""; };
    std::wstring disp = rs(L"DisplayVersion"), cb = rs(L"CurrentBuild");
    int b = _wtoi(cb.c_str());
    std::wstring prod = L"Windows", eol, status = L"ok";
    if (b > 0 && b < 22000) { prod = L"Windows 10"; eol = L"October 14, 2025"; status = L"eol"; }
    else if (b >= 22000) {
        if (b >= 26200) { prod = L"Windows 11 (25H2)"; eol = L"2027"; status = L"ok"; }
        else if (b >= 26100) { prod = L"Windows 11 (24H2)"; eol = L"October 13, 2026"; status = L"warn"; }
        else if (b >= 22631) { prod = L"Windows 11 (23H2)"; eol = L"November 11, 2025"; status = L"eol"; }
        else { prod = L"Windows 11 (22H2 or older)"; eol = L"October 8, 2024"; status = L"eol"; }
    }
    return L"{\"type\":\"lifecycle\",\"prod\":" + JS(prod) + L",\"disp\":" + JS(disp) + L",\"build\":" + JS(cb) +
           L",\"eol\":" + JS(eol) + L",\"status\":" + JS(status) + L"}";
}

// --- Repair wizard: plain-language symptom -> built-in Windows fix ---
static std::wstring RepairCmd(const std::wstring& a) {
    if (a == L"sfc")    return L"cmd /c sfc /scannow & DISM /Online /Cleanup-Image /RestoreHealth";
    if (a == L"net")    return L"cmd /c ipconfig /flushdns & netsh winsock reset & netsh int ip reset";
    if (a == L"wu")     return L"cmd /c net stop wuauserv & net stop bits & ren \"%windir%\\SoftwareDistribution\" SoftwareDistribution.old & net start wuauserv & net start bits";
    if (a == L"print")  return L"cmd /c net stop spooler & del /q /f \"%systemroot%\\System32\\spool\\PRINTERS\\*\" & net start spooler";
    if (a == L"store")  return L"cmd /c wsreset.exe";
    if (a == L"icon")   return L"cmd /c taskkill /f /im explorer.exe & del /a /q \"%localappdata%\\IconCache.db\" & start explorer.exe";
    if (a == L"browser") return L"cmd /c reg add \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\" /v ProxyEnable /t REG_DWORD /d 0 /f & reg delete \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\" /v ProxyServer /f & reg delete \"HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist\" /f & reg delete \"HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist\" /f & reg delete \"HKLM\\SOFTWARE\\Policies\\Google\\Chrome\" /v HomepageLocation /f & reg delete \"HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\" /v HomepageLocation /f & ipconfig /flushdns";
    return L"";
}
static std::wstring g_repairAction; static bool g_runRepair = false;
static DWORD WINAPI RepairThread(LPVOID) {
    std::wstring c = RepairCmd(g_repairAction); bool ok = false;
    if (!c.empty()) { DWORD rc = RunProcess(c); ok = (rc == 0 || rc == 3010); }
    PushJson(L"{\"type\":\"repairdone\",\"action\":" + JS(g_repairAction) + L",\"ok\":" + JB(ok) + L"}");
    g_runRepair = false; return 0;
}

// ===========================================================================
// 0.3 batch 2: security hardening checklist, reliability score, crash analyzer
// ===========================================================================
#include <algorithm>
static DWORD RegDwordVal(HKEY root, const wchar_t* path, const wchar_t* val, DWORD def) {
    DWORD d = def, cb = sizeof(d), ty = 0;
    RegGetValueW(root, path, val, RRF_RT_REG_DWORD, &ty, &d, &cb); return d;
}
static bool HardenGuestDisabled() {
    std::vector<std::vector<std::wstring>> rows;
    if (WmiQuery(L"ROOT\\CIMV2", L"SELECT Disabled FROM Win32_UserAccount WHERE LocalAccount=TRUE AND Name='Guest'", {L"Disabled"}, rows) && !rows.empty()) {
        const std::wstring& d = rows[0][0];
        return !d.empty() && (d[0] == L'T' || d[0] == L't' || d == L"1" || d == L"-1");
    }
    return true;  // unknown -> don't alarm
}
static std::wstring HardenJson() {
    bool smb1 = (RegDwordVal(HKEY_LOCAL_MACHINE, L"SYSTEM\\CurrentControlSet\\Services\\mrxsmb10", L"Start", 4) >= 4);
    bool rdp  = (RegDwordVal(HKEY_LOCAL_MACHINE, L"SYSTEM\\CurrentControlSet\\Control\\Terminal Server", L"fDenyTSConnections", 1) == 1);
    bool autoplay = (RegDwordVal(HKEY_CURRENT_USER, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\AutoplayHandlers", L"DisableAutoplay", 0) == 1);
    bool uac  = (RegDwordVal(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System", L"EnableLUA", 1) == 1);
    bool guest = HardenGuestDisabled();
    struct HI { const wchar_t* id; bool ok; } items[] = { {L"smb1",smb1},{L"rdp",rdp},{L"autoplay",autoplay},{L"uac",uac},{L"guest",guest} };
    std::wstring o = L"{\"type\":\"harden\",\"data\":["; int n = 0;
    for (auto& it : items) { if (n++) o += L","; o += L"{\"id\":" + JS(it.id) + L",\"ok\":" + JB(it.ok) + L"}"; }
    return o + L"]}";
}
static void HardenFix(const std::wstring& id) {
    if (id == L"smb1") RunProcess(L"cmd /c reg add \"HKLM\\SYSTEM\\CurrentControlSet\\Services\\mrxsmb10\" /v Start /t REG_DWORD /d 4 /f & powershell -NoProfile -Command \"Disable-WindowsOptionalFeature -Online -FeatureName SMB1Protocol -NoRestart\"");
    else if (id == L"rdp") RunProcess(L"reg add \"HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\" /v fDenyTSConnections /t REG_DWORD /d 1 /f");
    else if (id == L"autoplay") RunProcess(L"reg add \"HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\AutoplayHandlers\" /v DisableAutoplay /t REG_DWORD /d 1 /f");
    else if (id == L"uac") RunProcess(L"reg add \"HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\" /v EnableLUA /t REG_DWORD /d 1 /f");
    else if (id == L"guest") RunProcess(L"cmd /c net user guest /active:no");
}
static std::wstring g_hardenId;
static DWORD WINAPI HardenThread(LPVOID) { PushJson(HardenJson()); g_runSys = false; return 0; }
static DWORD WINAPI HardenFixThread(LPVOID) { HardenFix(g_hardenId); PushJson(HardenJson()); g_runSys = false; return 0; }

// --- Reliability score (Windows Reliability Monitor data) ---
static DWORD WINAPI ReliabilityThread(LPVOID) {
    std::vector<std::vector<std::wstring>> rows; double idx = -1; std::wstring bestTime;
    if (WmiQuery(L"ROOT\\CIMV2", L"SELECT SystemStabilityIndex,TimeGenerated FROM Win32_ReliabilityStabilityMetrics", {L"SystemStabilityIndex",L"TimeGenerated"}, rows))
        for (auto& r : rows) if (r[1] > bestTime) { bestTime = r[1]; idx = _wtof(r[0].c_str()); }
    std::wstring o = L"{\"type\":\"reliability\",\"index\":" + (idx >= 0 ? std::to_wstring(idx) : std::wstring(L"-1")) + L",\"events\":[";
    std::vector<std::vector<std::wstring>> recs; int n = 0;
    if (WmiQuery(L"ROOT\\CIMV2", L"SELECT ProductName,SourceName,TimeGenerated FROM Win32_ReliabilityRecords", {L"ProductName",L"SourceName",L"TimeGenerated"}, recs)) {
        std::sort(recs.begin(), recs.end(), [](const std::vector<std::wstring>& a, const std::vector<std::wstring>& b) { return a[2] > b[2]; });
        for (auto& r : recs) {
            if (n >= 15) break;
            // Reliability Monitor logs successful installs/updates alongside real
            // failures - drop the routine ones so "Recent problems" means problems.
            std::wstring sl = r[1]; for (auto& c : sl) c = towlower(c);
            if (sl.find(L"windowsupdateclient") != std::wstring::npos ||
                sl.find(L"msiinstaller") != std::wstring::npos ||
                sl.find(L"windows update agent") != std::wstring::npos) continue;
            std::wstring d = r[2];
            std::wstring df = d.size() >= 8 ? d.substr(0,4)+L"-"+d.substr(4,2)+L"-"+d.substr(6,2) : d;
            if (n++) o += L","; o += L"{\"product\":" + JS(r[0]) + L",\"source\":" + JS(r[1]) + L",\"date\":" + JS(df) + L"}"; }
    }
    o += L"]}"; PushJson(o); g_runSys = false; return 0;
}

// --- Crash / BSOD analyzer (bugcheck events + minidumps) ---
static std::wstring BugcheckName(const std::wstring& code) {
    struct M { const wchar_t* suf; const wchar_t* name; } m[] = {
        {L"133", L"DPC_WATCHDOG_VIOLATION - often a storage/SSD driver"},
        {L"d1",  L"DRIVER_IRQL_NOT_LESS_OR_EQUAL - a device driver"},
        {L"3b",  L"SYSTEM_SERVICE_EXCEPTION - a driver"},
        {L"7e",  L"SYSTEM_THREAD_EXCEPTION_NOT_HANDLED - a driver"},
        {L"1e",  L"KMODE_EXCEPTION_NOT_HANDLED - a driver"},
        {L"50",  L"PAGE_FAULT_IN_NONPAGED_AREA - RAM or a driver"},
        {L"9f",  L"DRIVER_POWER_STATE_FAILURE - a driver during sleep/wake"},
        {L"124", L"WHEA_UNCORRECTABLE_ERROR - a hardware fault"},
        {L"ef",  L"CRITICAL_PROCESS_DIED"},
        {L"7b",  L"INACCESSIBLE_BOOT_DEVICE - a storage driver"} };
    std::wstring c = code; for (auto& ch : c) ch = towlower(ch);
    // strip leading zeros after 0x for suffix match
    size_t z = c.find(L"0x"); std::wstring hex = z != std::wstring::npos ? c.substr(z+2) : c;
    while (hex.size() > 2 && hex[0] == L'0') hex.erase(0,1);
    for (auto& e : m) if (hex == e.suf || (hex.size() > wcslen(e.suf) && hex.substr(hex.size()-wcslen(e.suf)) == e.suf)) return e.name;
    return L"";
}
static std::wstring CrashJson() {
    std::wstring tmp = ProgDataDir() + L"\\crash.txt"; DeleteFileW(tmp.c_str());
    RunProcess(L"cmd /c powershell -NoProfile -Command \"Get-WinEvent -FilterHashtable @{LogName='System';Id=1001} -MaxEvents 40 -ErrorAction SilentlyContinue | Where-Object { $_.Message -match '0x' } | ForEach-Object { ($_.TimeCreated.ToString('yyyy-MM-dd HH:mm')) + '|' + ($_.Message -replace '[\\r\\n]+',' ') }\" > \"" + tmp + L"\" 2>nul");
    std::wstring txt; ReadUtf8File(tmp, txt);
    std::wstring o = L"{\"type\":\"crashes\",\"events\":["; int n = 0;
    size_t p = 0; while (p < txt.size()) { size_t nl = txt.find(L'\n', p);
        std::wstring ln = txt.substr(p, nl == std::wstring::npos ? std::wstring::npos : nl - p);
        if (!ln.empty() && ln.back() == L'\r') ln.pop_back();
        if (!ln.empty()) { size_t bar = ln.find(L'|');
            std::wstring date = bar == std::wstring::npos ? L"" : ln.substr(0, bar);
            std::wstring msg = bar == std::wstring::npos ? ln : ln.substr(bar + 1);
            std::wstring code; size_t hp = msg.find(L"0x");
            if (hp != std::wstring::npos) { size_t e = hp + 2; while (e < msg.size() && iswxdigit(msg[e])) e++; code = msg.substr(hp, e - hp); }
            if (!code.empty()) { if (n++) o += L","; o += L"{\"date\":" + JS(date) + L",\"code\":" + JS(code) + L",\"name\":" + JS(BugcheckName(code)) + L"}"; }
        }
        if (nl == std::wstring::npos) break; p = nl + 1; }
    o += L"],\"dumps\":[";
    WIN32_FIND_DATAW fd; HANDLE hf = FindFirstFileW(L"C:\\Windows\\Minidump\\*.dmp", &fd); int dn = 0;
    if (hf != INVALID_HANDLE_VALUE) { do { if (dn >= 20) break; SYSTEMTIME st; FileTimeToSystemTime(&fd.ftLastWriteTime, &st);
        wchar_t db[32]; swprintf(db, 32, L"%04d-%02d-%02d %02d:%02d", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute);
        if (dn++) o += L","; o += L"{\"name\":" + JS(std::wstring(fd.cFileName)) + L",\"date\":" + JS(std::wstring(db)) + L"}";
        } while (FindNextFileW(hf, &fd)); FindClose(hf); }
    return o + L"]}";
}
static DWORD WINAPI CrashThread(LPVOID) { PushJson(CrashJson()); g_runSys = false; return 0; }

// ===========================================================================
// 0.3 batch 3: backup essentials, full system report, disk-usage analyzer
// ===========================================================================
static bool g_runBackup = false;
static std::wstring CsidlPath(int csidl) { wchar_t p[MAX_PATH]; if (SHGetFolderPathW(nullptr, csidl, nullptr, 0, p) == S_OK) return p; return L""; }

// ===========================================================================
// Unwanted-software triage: the "my PC is acting weird" check. Surfaces the
// places junk hides - hosts-file redirects, a proxy hijack, unsigned programs
// that auto-start or run as scheduled tasks from user-writable folders, and the
// browser extensions installed (so the user can spot ones they don't recognise).
// ===========================================================================
static std::wstring ExpandEnv(const std::wstring& s) {
    wchar_t buf[2048]; DWORD n = ExpandEnvironmentStringsW(s.c_str(), buf, 2048);
    return (n && n <= 2048) ? std::wstring(buf) : s;
}
// Read a text file, honouring a UTF-16 LE BOM (Task XML) or UTF-8.
static bool ReadTextAuto(const std::wstring& path, std::wstring& out) {
    HANDLE f = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE) return false;
    DWORD sz = GetFileSize(f, nullptr); std::string buf(sz, '\0'); DWORD rd = 0;
    ReadFile(f, buf.empty() ? nullptr : &buf[0], sz, &rd, nullptr); CloseHandle(f); buf.resize(rd);
    if (rd >= 2 && (unsigned char)buf[0] == 0xFF && (unsigned char)buf[1] == 0xFE) {
        out.assign((const wchar_t*)(buf.data() + 2), (rd - 2) / 2); return true;
    }
    size_t off = (rd >= 3 && (unsigned char)buf[0] == 0xEF && (unsigned char)buf[1] == 0xBB && (unsigned char)buf[2] == 0xBF) ? 3 : 0;
    int n = MultiByteToWideChar(CP_UTF8, 0, buf.data() + off, (int)(buf.size() - off), nullptr, 0);
    out.resize(n); if (n) MultiByteToWideChar(CP_UTF8, 0, buf.data() + off, (int)(buf.size() - off), &out[0], n);
    return true;
}
// Embedded Authenticode check (no network, no catalog). Catalog-signed system
// files read as "not signed" here, so callers also require a user-writable path
// before flagging - system files live under %WINDIR% and are excluded.
static bool IsSignedFile(const std::wstring& path) {
    if (path.empty()) return false;
    WINTRUST_FILE_INFO fi{}; fi.cbStruct = sizeof(fi); fi.pcwszFilePath = path.c_str();
    GUID g = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    WINTRUST_DATA wd{}; wd.cbStruct = sizeof(wd); wd.dwUIChoice = WTD_UI_NONE;
    wd.fdwRevocationChecks = WTD_REVOKE_NONE; wd.dwUnionChoice = WTD_CHOICE_FILE; wd.pFile = &fi;
    wd.dwStateAction = WTD_STATEACTION_VERIFY; wd.dwProvFlags = WTD_SAFER_FLAG | WTD_CACHE_ONLY_URL_RETRIEVAL;
    LONG st = WinVerifyTrust((HWND)INVALID_HANDLE_VALUE, &g, &wd);
    wd.dwStateAction = WTD_STATEACTION_CLOSE; WinVerifyTrust((HWND)INVALID_HANDLE_VALUE, &g, &wd);
    return st == ERROR_SUCCESS;
}
static std::wstring LowerW(std::wstring s) { std::transform(s.begin(), s.end(), s.begin(), ::towlower); return s; }
static std::wstring ExeFromCommand(const std::wstring& cmdIn) {
    std::wstring cmd = ExpandEnv(cmdIn);
    size_t b = cmd.find_first_not_of(L" \t"); if (b == std::wstring::npos) return L"";
    cmd = cmd.substr(b);
    if (cmd[0] == L'"') { size_t e = cmd.find(L'"', 1); return (e == std::wstring::npos) ? cmd.substr(1) : cmd.substr(1, e - 1); }
    // Unquoted: the path itself may contain spaces (e.g. "...\Windows Defender\...").
    // Cut just after the first ".exe"; only fall back to the first space if none.
    size_t dot = LowerW(cmd).find(L".exe");
    if (dot != std::wstring::npos) return cmd.substr(0, dot + 4);
    size_t sp = cmd.find(L' '); return (sp == std::wstring::npos) ? cmd : cmd.substr(0, sp);
}
// True only for a real, existing file (not a directory).
static bool IsRealFile(const std::wstring& p) {
    DWORD a = GetFileAttributesW(p.c_str());
    return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}
static bool PathUnder(const std::wstring& path, const wchar_t* envFolder) {
    std::wstring f = LowerW(ExpandEnv(envFolder)); if (f.empty() || f[0] == L'%') return false;
    return LowerW(path).compare(0, f.size(), f) == 0;
}
static bool IsSystemPath(const std::wstring& p) { return PathUnder(p, L"%WINDIR%"); }
static bool IsUserWritable(const std::wstring& p) {
    // Deliberately excludes %ProgramData% - legit signed software (e.g. Microsoft
    // Defender's Platform folder) lives there. We only treat the user's own
    // profile / temp / downloads as the high-risk "junk hides here" locations.
    std::wstring lp = LowerW(p);
    return PathUnder(p, L"%APPDATA%") || PathUnder(p, L"%LOCALAPPDATA%") || PathUnder(p, L"%TEMP%") ||
           PathUnder(p, L"%PUBLIC%") ||
           lp.find(L"\\downloads\\") != std::wstring::npos || lp.find(L"\\temp\\") != std::wstring::npos;
}
static void WalkTasks(const std::wstring& dir, std::vector<std::wstring>& out) {
    WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW((dir + L"\\*").c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return;
    do {
        std::wstring nm = fd.cFileName; if (nm == L"." || nm == L"..") continue;
        std::wstring full = dir + L"\\" + nm;
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) WalkTasks(full, out);
        else out.push_back(full);
    } while (FindNextFileW(h, &fd));
    FindClose(h);
}
static std::wstring UnwantedJson() {
    std::wstring sus, exts;
    auto addSus = [&](const wchar_t* kind, const std::wstring& name, const std::wstring& detail, const wchar_t* sev, const wchar_t* action) {
        if (!sus.empty()) sus += L",";
        sus += L"{\"kind\":\""; sus += kind; sus += L"\",\"name\":" + JS(name) + L",\"detail\":" + JS(detail) +
               L",\"sev\":\""; sus += sev; sus += L"\",\"action\":"; sus += (action ? JS(std::wstring(action)) : std::wstring(L"null")); sus += L"}";
    };

    // 1) hosts file: any active (non-comment) entry that isn't plain localhost.
    {
        std::wstring hp = ExpandEnv(L"%WINDIR%") + L"\\System32\\drivers\\etc\\hosts", txt;
        if (ReadTextAuto(hp, txt)) {
            size_t pos = 0;
            while (pos < txt.size()) {
                size_t nl = txt.find(L'\n', pos);
                std::wstring line = txt.substr(pos, nl == std::wstring::npos ? std::wstring::npos : nl - pos);
                pos = (nl == std::wstring::npos) ? txt.size() : nl + 1;
                if (!line.empty() && line.back() == L'\r') line.pop_back();
                size_t b = line.find_first_not_of(L" \t"); if (b == std::wstring::npos || line[b] == L'#') continue;
                std::wstring rest = line.substr(b);
                size_t sp = rest.find_first_of(L" \t"); if (sp == std::wstring::npos) continue;
                std::wstring ip = rest.substr(0, sp);
                size_t hb = rest.find_first_not_of(L" \t", sp); if (hb == std::wstring::npos) continue;
                std::wstring host = rest.substr(hb);
                size_t hc = host.find(L'#'); if (hc != std::wstring::npos) host = host.substr(0, hc);
                while (!host.empty() && (host.back() == L' ' || host.back() == L'\t')) host.pop_back();
                if (host.empty() || LowerW(host) == L"localhost") continue;
                addSus(L"hosts", host, ip + L"  →  " + host, L"orange", L"openhosts");
            }
        }
    }
    // 2) proxy hijack.
    {
        DWORD en = RegDw(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", L"ProxyEnable", 0);
        wchar_t srv[512] = L""; DWORD cb = sizeof(srv);
        RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", L"ProxyServer", RRF_RT_REG_SZ, nullptr, srv, &cb);
        if (en && srv[0]) addSus(L"proxy", srv, L"", L"orange", L"openproxy");
    }
    // 3) autoruns whose program is unsigned and in a user-writable folder.
    {
        std::vector<StartupItem> st; GatherStartup(st);
        for (auto& it : st) {
            if (it.disabled) continue;
            std::wstring exe = ExeFromCommand(it.command); if (exe.empty()) continue;
            if (!IsRealFile(exe) || IsSystemPath(exe)) continue;
            if (!IsSignedFile(exe) && IsUserWritable(exe))
                addSus(L"autorun", it.name.empty() ? exe : it.name, exe, L"red", L"openstartup");
        }
    }
    // 4) scheduled tasks whose command is unsigned and in a user-writable folder.
    {
        std::wstring tdir = ExpandEnv(L"%WINDIR%") + L"\\System32\\Tasks";
        std::vector<std::wstring> files; WalkTasks(tdir, files);
        for (auto& f : files) {
            std::wstring rel = f.substr(tdir.size());
            // Skip Windows' own built-in tasks (e.g. Defender) - they live under the
            // \Microsoft\ namespace and are never the thing we're hunting for.
            if (LowerW(rel).compare(0, 11, L"\\microsoft\\") == 0) continue;
            std::wstring xml; if (!ReadTextAuto(f, xml)) continue;
            size_t a = xml.find(L"<Command>"); if (a == std::wstring::npos) continue;
            a += 9; size_t e = xml.find(L"</Command>", a); if (e == std::wstring::npos) continue;
            std::wstring exe = ExeFromCommand(xml.substr(a, e - a)); if (exe.empty()) continue;
            if (!IsRealFile(exe) || IsSystemPath(exe)) continue;
            if (!IsSignedFile(exe) && IsUserWritable(exe))
                addSus(L"task", rel, exe, L"red", L"opentasks");
        }
    }
    // 5) browser extensions (Chrome + Edge) - list so the user can spot strangers.
    {
        std::wstring lad = ExpandEnv(L"%LOCALAPPDATA%");
        struct B { const wchar_t* name; std::wstring base; };
        std::vector<B> browsers = {
            { L"Chrome", lad + L"\\Google\\Chrome\\User Data\\Default\\Extensions" },
            { L"Edge",   lad + L"\\Microsoft\\Edge\\User Data\\Default\\Extensions" } };
        for (auto& br : browsers) {
            WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW((br.base + L"\\*").c_str(), &fd);
            if (h == INVALID_HANDLE_VALUE) continue;
            do {
                std::wstring id = fd.cFileName; if (id == L"." || id == L".." || !(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
                std::wstring extdir = br.base + L"\\" + id, name;
                WIN32_FIND_DATAW vd; HANDLE vh = FindFirstFileW((extdir + L"\\*").c_str(), &vd);
                if (vh != INVALID_HANDLE_VALUE) {
                    do {
                        std::wstring v = vd.cFileName; if (v == L"." || v == L".." || !(vd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
                        std::wstring mt; if (ReadUtf8File(extdir + L"\\" + v + L"\\manifest.json", mt)) {
                            size_t p = mt.find(L"\"name\"");
                            if (p != std::wstring::npos) {
                                size_t q = mt.find(L'"', p + 6), q2 = (q != std::wstring::npos) ? mt.find(L'"', q + 1) : std::wstring::npos;
                                if (q != std::wstring::npos && q2 != std::wstring::npos) name = mt.substr(q + 1, q2 - q - 1);
                            }
                        }
                        if (!name.empty()) break;
                    } while (FindNextFileW(vh, &vd));
                    FindClose(vh);
                }
                if (name.empty() || name.compare(0, 6, L"__MSG_") == 0) name = id;
                if (!exts.empty()) exts += L",";
                exts += L"{\"browser\":\""; exts += br.name; exts += L"\",\"name\":" + JS(name) + L",\"id\":" + JS(id) + L"}";
            } while (FindNextFileW(h, &fd));
            FindClose(h);
        }
    }
    return L"{\"type\":\"unwanted\",\"data\":{\"suspicious\":[" + sus + L"],\"ext\":[" + exts + L"]}}";
}
static DWORD WINAPI UnwantedThread(LPVOID) { PushJson(UnwantedJson()); g_runSys = false; return 0; }

// ===========================================================================
// Privacy & account hygiene: local accounts (admin / no-password-required),
// BitLocker status (with a recovery-key reminder), camera/mic/location app
// permissions, and the advertising-ID / telemetry posture. Read-only - fixes
// open the matching Windows page so the user stays in control.
// ===========================================================================
static std::wstring HygieneJson() {
    std::wstring acc;
    {
        LPUSER_INFO_1 buf = nullptr; DWORD rd = 0, tot = 0, res = 0;
        NET_API_STATUS st = NetUserEnum(nullptr, 1, FILTER_NORMAL_ACCOUNT, (LPBYTE*)&buf, MAX_PREFERRED_LENGTH, &rd, &tot, &res);
        if ((st == NERR_Success || st == ERROR_MORE_DATA) && buf) {
            for (DWORD i = 0; i < rd; i++) {
                USER_INFO_1& u = buf[i];
                std::wstring name = u.usri1_name ? u.usri1_name : L"";
                bool admin = (u.usri1_priv == USER_PRIV_ADMIN);
                bool disabled = (u.usri1_flags & UF_ACCOUNTDISABLE) != 0;
                bool noPwd = (u.usri1_flags & UF_PASSWD_NOTREQD) != 0;
                std::wstring nl = LowerW(name);
                bool builtin = (nl == L"administrator" || nl == L"guest" || nl == L"defaultaccount" || nl == L"wdagutilityaccount");
                if (!acc.empty()) acc += L",";
                acc += L"{\"name\":" + JS(name) + L",\"admin\":" + JB(admin) + L",\"disabled\":" + JB(disabled) +
                       L",\"noPwd\":" + JB(noPwd) + L",\"builtin\":" + JB(builtin) + L"}";
            }
        }
        if (buf) NetApiBufferFree(buf);
    }
    std::wstring bl;
    {
        HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED); bool ci = SUCCEEDED(hr);
        std::vector<std::vector<std::wstring>> rows;
        if (WmiQuery(L"ROOT\\CIMV2\\Security\\MicrosoftVolumeEncryption",
                     L"SELECT DriveLetter,ProtectionStatus FROM Win32_EncryptableVolume",
                     { L"DriveLetter", L"ProtectionStatus" }, rows))
            for (auto& r : rows) if (r[0] == L"C:") bl = (r[1] == L"1") ? L"On" : L"Off";
        if (ci) CoUninitialize();
    }
    std::wstring perms;
    {
        const wchar_t* caps[] = { L"webcam", L"microphone", L"location" };
        for (auto cap : caps) {
            std::wstring sub = std::wstring(L"Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\") + cap;
            wchar_t val[32] = L""; DWORD cb = sizeof(val);
            RegGetValueW(HKEY_CURRENT_USER, sub.c_str(), L"Value", RRF_RT_REG_SZ, nullptr, val, &cb);
            bool allowed = (std::wstring(val) == L"Allow");
            if (!perms.empty()) perms += L",";
            perms += L"{\"cap\":\""; perms += cap; perms += L"\",\"allowed\":" + JB(allowed) + L"}";
        }
    }
    DWORD adId = RegDw(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo", L"Enabled", 1);
    DWORD telem = RegDw(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection", L"AllowTelemetry", 99);
    if (telem == 99) telem = RegDw(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\DataCollection", L"AllowTelemetry", 99);
    return L"{\"type\":\"hygiene\",\"data\":{\"accounts\":[" + acc + L"],\"bitlocker\":" + JS(bl) +
           L",\"perms\":[" + perms + L"],\"adId\":" + JB(adId != 0) + L",\"telemetry\":" + std::to_wstring((int)telem) + L"}}";
}
static DWORD WINAPI HygieneThread(LPVOID) { PushJson(HygieneJson()); g_runSys = false; return 0; }

// --- One-click backup of Documents / Pictures / Desktop (robocopy) ---
static std::wstring g_backupDest;
static DWORD WINAPI BackupThread(LPVOID) {
    std::wstring dest = g_backupDest;
    if (dest.empty()) { PushJson(L"{\"type\":\"backupdone\",\"ok\":false}"); g_runBackup = false; return 0; }
    std::wstring root = dest + L"\\Butler Backup"; CreateDirectoryW(root.c_str(), nullptr);
    bool ok = true;
    auto bk = [&](const std::wstring& src, const wchar_t* name) {
        if (src.empty()) return; std::wstring d = root + L"\\" + name;
        DWORD rc = RunProcess(L"robocopy \"" + src + L"\" \"" + d + L"\" /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP");
        if (rc >= 8) ok = false;  // robocopy: 0-7 = success, >=8 = error
    };
    PushJson(L"{\"type\":\"backupstatus\"}");
    bk(CsidlPath(CSIDL_PERSONAL), L"Documents");
    bk(CsidlPath(CSIDL_MYPICTURES), L"Pictures");
    bk(CsidlPath(CSIDL_DESKTOPDIRECTORY), L"Desktop");
    PushJson(L"{\"type\":\"backupdone\",\"ok\":" + JB(ok) + L",\"dest\":" + JS(root) + L"}");
    g_runBackup = false; return 0;
}

// --- Full system report (hardware + OS) exported as HTML ---
static DWORD WINAPI SysReportThread(LPVOID) {
    auto w1 = [&](const wchar_t* q, const std::wstring& col)->std::wstring {
        std::vector<std::vector<std::wstring>> r; if (WmiQuery(L"ROOT\\CIMV2", q, { col }, r) && !r.empty()) return r[0][0]; return L""; };
    std::wstring model;
    std::vector<std::vector<std::wstring>> r;
    if (WmiQuery(L"ROOT\\CIMV2", L"SELECT Manufacturer,Model FROM Win32_ComputerSystem", { L"Manufacturer",L"Model" }, r) && !r.empty()) model = r[0][0] + L" " + r[0][1];
    std::wstring cpu = w1(L"SELECT Name FROM Win32_Processor", L"Name");
    std::wstring os = w1(L"SELECT Caption FROM Win32_OperatingSystem", L"Caption");
    std::wstring bios = w1(L"SELECT SerialNumber FROM Win32_BIOS", L"SerialNumber");
    std::wstring gpu = w1(L"SELECT Name FROM Win32_VideoController", L"Name");
    MEMORYSTATUSEX ms{ sizeof(ms) }; GlobalMemoryStatusEx(&ms);
    std::wstring ramGb = std::to_wstring(ms.ullTotalPhys / (1024ull * 1024 * 1024));
    std::wstring h = L"<!doctype html><meta charset=\"utf-8\"><title>Butler System Report</title>";
    h += L"<style>body{font-family:Segoe UI,Arial,sans-serif;margin:32px;color:#111}h1{font-size:22px}table{border-collapse:collapse;margin-top:12px}td{padding:7px 16px;border-bottom:1px solid #e2e2e2}td:first-child{color:#666;white-space:nowrap}</style>";
    h += L"<h1>Butler &mdash; System Report</h1><table>";
    auto row = [&](const wchar_t* k, const std::wstring& v) { h += L"<tr><td>" + std::wstring(k) + L"</td><td>" + (v.empty() ? L"-" : v) + L"</td></tr>"; };
    row(L"Computer", model); row(L"Processor", cpu); row(L"Memory", ramGb + L" GB"); row(L"Graphics", gpu); row(L"Operating system", os); row(L"Serial number", bios);
    h += L"</table>";
    std::wstring docs = CsidlPath(CSIDL_PERSONAL); if (docs.empty()) docs = L"C:";
    std::wstring path = docs + L"\\Butler-System-Report.html";
    bool ok = false;
    HANDLE f = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f != INVALID_HANDLE_VALUE) {
        int len = WideCharToMultiByte(CP_UTF8, 0, h.c_str(), -1, nullptr, 0, nullptr, nullptr);
        if (len > 1) { std::string u(len - 1, 0); WideCharToMultiByte(CP_UTF8, 0, h.c_str(), -1, &u[0], len, nullptr, nullptr);
            DWORD wr; WriteFile(f, u.data(), (DWORD)u.size(), &wr, nullptr); ok = true; }
        CloseHandle(f);
    }
    PushJson(L"{\"type\":\"sysreport\",\"ok\":" + JB(ok) + L",\"path\":" + JS(path) + L"}");
    g_runBackup = false; return 0;
}

// --- Disk-usage analyzer: biggest folders/files under your profile ---
static unsigned long long DirSize(const std::wstring& path) {
    unsigned long long total = 0; WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW((path + L"\\*").c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return 0;
    do { std::wstring n = fd.cFileName; if (n == L"." || n == L"..") continue;
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) continue;
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) total += DirSize(path + L"\\" + n);
        else total += ((unsigned long long)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
    } while (FindNextFileW(h, &fd)); FindClose(h); return total;
}
static std::wstring g_duFolder;
static DWORD WINAPI DiskUsageThread(LPVOID) {
    std::wstring root = g_duFolder; if (root.empty()) root = CsidlPath(CSIDL_PROFILE);
    std::vector<std::pair<unsigned long long, std::wstring>> items;
    WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW((root + L"\\*").c_str(), &fd);
    if (h != INVALID_HANDLE_VALUE) { do { std::wstring n = fd.cFileName; if (n == L"." || n == L"..") continue;
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) continue;
        bool dir = (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        unsigned long long sz = dir ? DirSize(root + L"\\" + n) : (((unsigned long long)fd.nFileSizeHigh << 32) | fd.nFileSizeLow);
        items.push_back({ sz, n + (dir ? L"\\" : L"") });
    } while (FindNextFileW(h, &fd)); FindClose(h); }
    std::sort(items.begin(), items.end(), [](const std::pair<unsigned long long, std::wstring>& a, const std::pair<unsigned long long, std::wstring>& b) { return a.first > b.first; });
    std::wstring o = L"{\"type\":\"diskusage\",\"data\":{\"folder\":" + JS(root) + L",\"items\":["; int n = 0;
    for (auto& it : items) { if (n >= 25) break; if (n++) o += L","; o += L"{\"name\":" + JS(it.second) + L",\"kb\":" + std::to_wstring(it.first / 1024) + L"}"; }
    o += L"]}}"; PushJson(o); g_runSys = false; return 0;
}

// ===========================================================================
// 0.3 batch 4: change & undo log, setup profile, sensors, scheduled report
// ===========================================================================
static bool WriteUtf8File(const std::wstring& path, const std::wstring& text) {
    HANDLE f = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE) return false;
    int len = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), -1, nullptr, 0, nullptr, nullptr);
    if (len > 1) { std::string u(len - 1, 0); WideCharToMultiByte(CP_UTF8, 0, text.c_str(), -1, &u[0], len, nullptr, nullptr); DWORD wr; WriteFile(f, u.data(), (DWORD)u.size(), &wr, nullptr); }
    CloseHandle(f); return true;
}

// --- Change & undo log: every action Butler takes, with one-click undo ---
static std::wstring ChangesPath() { return ProgDataDir() + L"\\changes.log"; }
static void AppendChange(const std::wstring& type, const std::wstring& detail, const std::wstring& undo) {
    SYSTEMTIME st; GetLocalTime(&st); wchar_t ts[24]; swprintf(ts, 24, L"%04d-%02d-%02d %02d:%02d", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute);
    std::wstring line = std::wstring(ts) + L"\t" + type + L"\t" + detail + L"\t" + undo + L"\n";
    HANDLE f = CreateFileW(ChangesPath().c_str(), FILE_APPEND_DATA, FILE_SHARE_READ, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f != INVALID_HANDLE_VALUE) { int len = WideCharToMultiByte(CP_UTF8, 0, line.c_str(), -1, nullptr, 0, nullptr, nullptr);
        if (len > 1) { std::string u(len - 1, 0); WideCharToMultiByte(CP_UTF8, 0, line.c_str(), -1, &u[0], len, nullptr, nullptr); SetFilePointer(f, 0, nullptr, FILE_END); DWORD wr; WriteFile(f, u.data(), (DWORD)u.size(), &wr, nullptr); }
        CloseHandle(f); }
}
static std::vector<std::wstring> ChangeLines() {
    std::wstring txt; ReadUtf8File(ChangesPath(), txt); std::vector<std::wstring> lines; size_t p = 0;
    while (p < txt.size()) { size_t nl = txt.find(L'\n', p); std::wstring ln = txt.substr(p, nl == std::wstring::npos ? std::wstring::npos : nl - p);
        if (!ln.empty() && ln.back() == L'\r') ln.pop_back(); if (!ln.empty()) lines.push_back(ln); if (nl == std::wstring::npos) break; p = nl + 1; }
    return lines;
}
static std::vector<std::wstring> SplitTabs(const std::wstring& l) {
    std::vector<std::wstring> f; size_t q = 0; while (true) { size_t tb = l.find(L'\t', q);
        f.push_back(l.substr(q, tb == std::wstring::npos ? std::wstring::npos : tb - q)); if (tb == std::wstring::npos) break; q = tb + 1; } return f;
}
static std::wstring ChangesJson() {
    auto lines = ChangeLines(); std::wstring o = L"{\"type\":\"changes\",\"data\":["; int n = 0;
    for (int i = (int)lines.size() - 1; i >= 0 && n < 300; --i) { auto f = SplitTabs(lines[i]); while (f.size() < 4) f.push_back(L"");
        if (n++) o += L","; o += L"{\"i\":" + std::to_wstring(i) + L",\"time\":" + JS(f[0]) + L",\"type\":" + JS(f[1]) + L",\"detail\":" + JS(f[2]) + L",\"undo\":" + JS(f[3]) + L"}"; }
    return o + L"]}";
}
static void UndoChange(int idx) {
    auto lines = ChangeLines(); if (idx < 0 || idx >= (int)lines.size()) return; auto f = SplitTabs(lines[idx]); while (f.size() < 4) f.push_back(L"");
    std::wstring undo = f[3];
    if (undo.rfind(L"tweak:", 0) == 0) { std::wstring rest = undo.substr(6); size_t c = rest.find(L':');
        if (c != std::wstring::npos) { std::wstring id = rest.substr(0, c); bool on = (rest.substr(c + 1) == L"1"); SetTweak(id, on); AppendChange(L"undo", L"tweak " + id, L""); } }
}

// --- Hardware sensors (temperatures via WMI thermal zones) ---
static std::wstring SensorsJson() {
    std::vector<std::vector<std::wstring>> r; std::wstring o = L"{\"type\":\"sensors\",\"data\":["; int n = 0;
    if (WmiQuery(L"ROOT\\WMI", L"SELECT CurrentTemperature,InstanceName FROM MSAcpi_ThermalZoneTemperature", { L"CurrentTemperature",L"InstanceName" }, r)) {
        for (auto& row : r) { long tk = _wtol(row[0].c_str()); double c = tk / 10.0 - 273.15; if (c < -50 || c > 150) continue;
            wchar_t b[16]; swprintf(b, 16, L"%.0f", c); if (n++) o += L","; o += L"{\"name\":" + JS(row[1]) + L",\"c\":" + std::wstring(b) + L"}"; }
    }
    return o + L"]}";
}

// --- Setup profile: export/import your tweak choices (carry to another PC) ---
static std::wstring ProfilePath() { std::wstring d = CsidlPath(CSIDL_PERSONAL); if (d.empty()) d = L"C:"; return d + L"\\Butler-Profile.txt"; }
static bool ProfileExport() { std::wstring out; for (auto& tw : Tweaks()) out += tw.id + L"\t" + (TweakState(tw) ? L"1" : L"0") + L"\n"; return WriteUtf8File(ProfilePath(), out); }
static int ProfileImport() {
    std::wstring txt; if (!ReadUtf8File(ProfilePath(), txt)) return -1; int n = 0; size_t p = 0;
    while (p < txt.size()) { size_t nl = txt.find(L'\n', p); std::wstring ln = txt.substr(p, nl == std::wstring::npos ? std::wstring::npos : nl - p);
        if (!ln.empty() && ln.back() == L'\r') ln.pop_back(); size_t tb = ln.find(L'\t');
        if (tb != std::wstring::npos) { std::wstring id = ln.substr(0, tb); bool on = (ln.substr(tb + 1) == L"1"); SetTweak(id, on); n++; }
        if (nl == std::wstring::npos) break; p = nl + 1; }
    return n;
}

// --- Scheduled health report (weekly HTML report to ProgramData\Butler\reports) ---
static std::wstring SystemReportHtmlQuick() {
    auto w1 = [&](const wchar_t* q, const std::wstring& col)->std::wstring { std::vector<std::vector<std::wstring>> r; if (WmiQuery(L"ROOT\\CIMV2", q, { col }, r) && !r.empty()) return r[0][0]; return L""; };
    std::wstring model; std::vector<std::vector<std::wstring>> r;
    if (WmiQuery(L"ROOT\\CIMV2", L"SELECT Manufacturer,Model FROM Win32_ComputerSystem", { L"Manufacturer",L"Model" }, r) && !r.empty()) model = r[0][0] + L" " + r[0][1];
    std::wstring h = L"<!doctype html><meta charset=\"utf-8\"><title>Butler Health Report</title><style>body{font-family:Segoe UI,Arial;margin:32px;color:#111}td{padding:6px 16px;border-bottom:1px solid #e2e2e2}td:first-child{color:#666}</style><h1>Butler Health Report</h1><table>";
    h += L"<tr><td>Computer</td><td>" + model + L"</td></tr>";
    h += L"<tr><td>Processor</td><td>" + w1(L"SELECT Name FROM Win32_Processor", L"Name") + L"</td></tr>";
    h += L"<tr><td>Operating system</td><td>" + w1(L"SELECT Caption FROM Win32_OperatingSystem", L"Caption") + L"</td></tr>";
    return h + L"</table></table>";
}
static int RunReport() {
    std::wstring dir = ProgDataDir() + L"\\reports"; CreateDirectoryW(dir.c_str(), nullptr);
    SYSTEMTIME st; GetLocalTime(&st); wchar_t f[40]; swprintf(f, 40, L"report-%04d-%02d-%02d.html", st.wYear, st.wMonth, st.wDay);
    WriteUtf8File(dir + L"\\" + f, SystemReportHtmlQuick()); return 0;
}
static void SetReportSchedule(bool on) {
    if (on) RunProcess(L"schtasks /create /tn Butler_Report /tr \"\\\"" + ExePathFull() + L"\\\" --report\" /sc WEEKLY /d MON /st 09:00 /rl HIGHEST /f");
    else RunProcess(L"schtasks /delete /tn Butler_Report /f");
}

// Firewall / live connections (from minimalfirewall - all user-mode, no driver).
static std::wstring TcpStateStr(DWORD s) {
    switch (s) { case MIB_TCP_STATE_ESTAB: return L"ESTABLISHED"; case MIB_TCP_STATE_LISTEN: return L"LISTEN";
        case MIB_TCP_STATE_TIME_WAIT: return L"TIME_WAIT"; case MIB_TCP_STATE_CLOSE_WAIT: return L"CLOSE_WAIT";
        case MIB_TCP_STATE_SYN_SENT: return L"SYN_SENT"; case MIB_TCP_STATE_FIN_WAIT1: case MIB_TCP_STATE_FIN_WAIT2: return L"FIN_WAIT";
        default: return L"?"; }
}
static std::wstring PidExe(DWORD pid, std::wstring& full) {
    full.clear(); if (pid == 0) return L"System Idle"; if (pid == 4) return L"System";
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid); if (!h) return L"(pid " + std::to_wstring(pid) + L")";
    wchar_t path[MAX_PATH] = L""; DWORD cb = MAX_PATH; std::wstring name = L"?";
    if (QueryFullProcessImageNameW(h, 0, path, &cb)) { full = path; std::wstring p = path; size_t s = p.find_last_of(L'\\'); name = (s == std::wstring::npos) ? p : p.substr(s + 1); }
    CloseHandle(h); return name;
}
static std::wstring Ip4(DWORD addr) { in_addr a; a.S_un.S_addr = addr; char b[16] = ""; inet_ntop(AF_INET, &a, b, 16); return std::wstring(b, b + strlen(b)); }
static std::wstring FirewallConnJson() {
    std::wstring o = L"{\"type\":\"fwconn\",\"data\":[";
    ULONG sz = 0; GetExtendedTcpTable(nullptr, &sz, FALSE, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0);
    std::vector<BYTE> buf(sz);
    if (sz && GetExtendedTcpTable(buf.data(), &sz, FALSE, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0) == NO_ERROR) {
        auto* t = (MIB_TCPTABLE_OWNER_PID*)buf.data(); int n = 0;
        std::map<DWORD, std::pair<std::wstring, std::wstring>> cache;  // pid -> (name, full)
        for (DWORD i = 0; i < t->dwNumEntries && n < 200; ++i) {
            auto& r = t->table[i];
            if (r.dwRemoteAddr == 0 && r.dwState != MIB_TCP_STATE_LISTEN) continue;
            if (r.dwState == MIB_TCP_STATE_LISTEN) continue;  // show actual connections, not listeners
            DWORD pid = r.dwOwningPid;
            if (!cache.count(pid)) { std::wstring full; std::wstring nm = PidExe(pid, full); cache[pid] = { nm, full }; }
            std::wstring remote = Ip4(r.dwRemoteAddr) + L":" + std::to_wstring(ntohs((u_short)r.dwRemotePort));
            if (n++) o += L",";
            o += L"{\"proc\":" + JS(cache[pid].first) + L",\"full\":" + JS(cache[pid].second) +
                 L",\"remote\":" + JS(remote) + L",\"state\":" + JS(TcpStateStr(r.dwState)) + L"}";
        }
    }
    return o + L"]}";
}
static void FirewallBlock(const std::wstring& path, bool block) {
    if (path.empty()) return;
    size_t s = path.find_last_of(L'\\'); std::wstring exe = (s == std::wstring::npos) ? path : path.substr(s + 1);
    std::wstring rule = L"Butler block: " + exe;
    if (block) RunProcess(L"netsh advfirewall firewall add rule name=\"" + rule + L"\" dir=out action=block program=\"" + path + L"\" enable=yes");
    else       RunProcess(L"netsh advfirewall firewall delete rule name=\"" + rule + L"\"");
}

// ===========================================================================
// Registry scanner + fixer - finds broken references, backs up before removal
// ===========================================================================
struct RegIssue { std::wstring cat, where, name, target, kind; HKEY hive; std::wstring path; REGSAM extra; };
static std::vector<RegIssue> g_regIssues;
static bool RegFileThere(const std::wstring& p) { return !p.empty() && GetFileAttributesW(p.c_str()) != INVALID_FILE_ATTRIBUTES; }
// Like RegFileThere, but tolerant of App Paths / shell entries that omit the
// executable extension (e.g. "...\Netbird" really means "...\Netbird.exe").
static bool RegTargetExists(const std::wstring& p) {
    if (RegFileThere(p)) return true;
    std::wstring low = p; std::transform(low.begin(), low.end(), low.begin(), towlower);
    bool hasExt = low.size() >= 4 && (low.substr(low.size() - 4) == L".exe" || low.substr(low.size() - 4) == L".com" ||
                                      low.substr(low.size() - 4) == L".bat" || low.substr(low.size() - 4) == L".cmd");
    if (!hasExt) { if (RegFileThere(p + L".exe") || RegFileThere(p + L".com")) return true; }
    return false;
}
// Pull the executable path out of a command string. Handles quoted paths,
// unquoted paths that contain spaces (e.g. C:\Program Files\...), and paths
// with trailing arguments. Critical: a naive "split on first space" would turn
// "C:\Program Files\app.exe" into "C:\Program" and wrongly flag valid entries.
static std::wstring RegExtractExe(const std::wstring& cmd) {
    wchar_t exp[2048] = L""; ExpandEnvironmentStringsW(cmd.c_str(), exp, 2048);
    std::wstring s = exp; size_t a = 0; while (a < s.size() && iswspace(s[a])) a++; s = s.substr(a);
    if (s.empty()) return L"";
    if (s[0] == L'"') { size_t e = s.find(L'"', 1); return s.substr(1, e == std::wstring::npos ? std::wstring::npos : e - 1); }
    if (GetFileAttributesW(s.c_str()) != INVALID_FILE_ATTRIBUTES) return s;  // whole value is a real path (no args)
    std::wstring low = s; std::transform(low.begin(), low.end(), low.begin(), towlower);
    const wchar_t* exts[] = { L".exe", L".com", L".bat", L".cmd", L".scr" };
    size_t best = std::wstring::npos;
    for (auto e : exts) { size_t p = low.find(e); if (p != std::wstring::npos) { size_t end = p + wcslen(e); if (best == std::wstring::npos || end < best) best = end; } }
    if (best != std::wstring::npos) return s.substr(0, best);
    return s;  // no extension/args found: it's a plain path (may contain spaces) - use it whole
}
static void RegScanRun(HKEY hive, const wchar_t* hiveName, REGSAM extra) {
    const wchar_t* run = L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";
    HKEY k; if (RegOpenKeyExW(hive, run, 0, KEY_READ | extra, &k) != ERROR_SUCCESS) return;
    wchar_t name[256]; BYTE data[2048];
    for (DWORD i = 0;; ++i) {
        DWORD nlen = 256, dlen = sizeof(data), type = 0;
        LONG r = RegEnumValueW(k, i, name, &nlen, nullptr, &type, data, &dlen);
        if (r == ERROR_NO_MORE_ITEMS) break;
        if (r != ERROR_SUCCESS || (type != REG_SZ && type != REG_EXPAND_SZ)) continue;
        std::wstring cmd = (wchar_t*)data, exe = RegExtractExe(cmd);
        if (exe.find(L'\\') != std::wstring::npos && !RegTargetExists(exe)) {
            RegIssue is; is.cat = L"startup"; is.where = std::wstring(hiveName) + L"\\...\\Run"; is.name = name;
            is.target = exe; is.kind = L"value"; is.hive = hive; is.path = run; is.extra = extra;
            g_regIssues.push_back(is);
        }
    }
    RegCloseKey(k);
}
static void RegScanAppPaths(HKEY hive, const wchar_t* hiveName) {
    const wchar_t* ap = L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths";
    HKEY k; if (RegOpenKeyExW(hive, ap, 0, KEY_READ, &k) != ERROR_SUCCESS) return;
    wchar_t sub[256];
    for (DWORD i = 0;; ++i) {
        DWORD slen = 256;
        LONG r = RegEnumKeyExW(k, i, sub, &slen, nullptr, nullptr, nullptr, nullptr);
        if (r == ERROR_NO_MORE_ITEMS) break;
        if (r != ERROR_SUCCESS) continue;
        std::wstring full = std::wstring(ap) + L"\\" + sub;
        wchar_t def[1024] = L""; DWORD cb = sizeof(def);
        if (RegGetValueW(hive, full.c_str(), nullptr, RRF_RT_REG_SZ, nullptr, def, &cb) != ERROR_SUCCESS) continue;
        std::wstring exe = RegExtractExe(def);
        if (exe.find(L'\\') != std::wstring::npos && !RegTargetExists(exe)) {
            RegIssue is; is.cat = L"apppath"; is.where = std::wstring(hiveName) + L"\\...\\App Paths\\" + sub; is.name = sub;
            is.target = exe; is.kind = L"key"; is.hive = hive; is.path = full; is.extra = 0;
            g_regIssues.push_back(is);
        }
    }
    RegCloseKey(k);
}
// Dead uninstall entries: an Uninstall key whose DisplayIcon points to a specific
// .exe path that no longer exists. Conservative (only flags a concrete missing exe)
// to avoid removing valid entries (MSI/Store apps have no such icon path).
static void RegScanUninstall(HKEY hive, const wchar_t* hiveName, REGSAM extra) {
    const wchar_t* up = L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
    HKEY k; if (RegOpenKeyExW(hive, up, 0, KEY_READ | extra, &k) != ERROR_SUCCESS) return;
    wchar_t sub[256];
    for (DWORD i = 0;; ++i) {
        DWORD slen = 256;
        if (RegEnumKeyExW(k, i, sub, &slen, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) break;
        std::wstring full = std::wstring(up) + L"\\" + sub;
        wchar_t icon[1024] = L""; DWORD cb = sizeof(icon);
        if (RegGetValueW(hive, full.c_str(), L"DisplayIcon", RRF_RT_REG_SZ, nullptr, icon, &cb) != ERROR_SUCCESS) continue;
        std::wstring ic = icon; size_t comma = ic.find_last_of(L','); if (comma != std::wstring::npos) ic = ic.substr(0, comma);
        if (!ic.empty() && ic[0] == L'"') { size_t e = ic.find(L'"', 1); ic = ic.substr(1, e == std::wstring::npos ? std::wstring::npos : e - 1); }
        std::wstring low = ic; std::transform(low.begin(), low.end(), low.begin(), towlower);
        if (low.size() < 5 || low.substr(low.size() - 4) != L".exe") continue;  // only concrete exe icons
        if (ic.find(L'\\') != std::wstring::npos && !RegFileThere(ic)) {
            wchar_t nm[512] = L""; DWORD nb = sizeof(nm); RegGetValueW(hive, full.c_str(), L"DisplayName", RRF_RT_REG_SZ, nullptr, nm, &nb);
            RegIssue is; is.cat = L"uninstall"; is.where = std::wstring(hiveName) + L"\\...\\Uninstall\\" + sub;
            is.name = nm[0] ? nm : sub; is.target = ic; is.kind = L"key"; is.hive = hive; is.path = full; is.extra = extra;
            g_regIssues.push_back(is);
        }
    }
    RegCloseKey(k);
}
// --- Extra cleaner categories (from LittleRegistryCleaner, conservative) -----
// Values whose NAME is a file/dir path (SharedDLLs, Installer\Folders).
static void RegScanPathValueNames(HKEY hive, const wchar_t* hiveName, const wchar_t* keyPath, REGSAM extra,
                                  const wchar_t* cat, const wchar_t* label, bool wantDir) {
    HKEY k; if (RegOpenKeyExW(hive, keyPath, 0, KEY_READ | extra, &k) != ERROR_SUCCESS) return;
    wchar_t name[1024]; BYTE data[16];
    for (DWORD i = 0;; ++i) {
        DWORD nlen = 1024, dlen = sizeof(data), type = 0;
        LONG r = RegEnumValueW(k, i, name, &nlen, nullptr, &type, data, &dlen);
        if (r == ERROR_NO_MORE_ITEMS) break; if (r != ERROR_SUCCESS && r != ERROR_MORE_DATA) continue;
        std::wstring p = name; if (p.find(L'\\') == std::wstring::npos) continue;
        wchar_t exp[2048] = L""; ExpandEnvironmentStringsW(p.c_str(), exp, 2048);
        DWORD a = GetFileAttributesW(exp);
        bool ok = (a != INVALID_FILE_ATTRIBUTES) && (wantDir ? (a & FILE_ATTRIBUTE_DIRECTORY) : true);
        if (!ok) { RegIssue is; is.cat = cat; is.where = std::wstring(hiveName) + L"\\..." + label; is.name = name;
            is.target = exp; is.kind = L"value"; is.hive = hive; is.path = keyPath; is.extra = extra; g_regIssues.push_back(is); }
    }
    RegCloseKey(k);
}
// Values whose DATA is a filename resolved under a base dir (Fonts, Drivers32).
static void RegScanPathValueData(HKEY hive, const wchar_t* hiveName, const wchar_t* keyPath, const wchar_t* base,
                                 const wchar_t* cat, const wchar_t* label) {
    HKEY k; if (RegOpenKeyExW(hive, keyPath, 0, KEY_READ, &k) != ERROR_SUCCESS) return;
    wchar_t name[512], data[1024];
    for (DWORD i = 0;; ++i) {
        DWORD nlen = 512, dlen = sizeof(data), type = 0;
        LONG r = RegEnumValueW(k, i, name, &nlen, nullptr, &type, (BYTE*)data, &dlen);
        if (r == ERROR_NO_MORE_ITEMS) break; if (r != ERROR_SUCCESS || type != REG_SZ) continue;
        std::wstring d = data; if (d.empty()) continue;
        wchar_t exp[2048] = L""; ExpandEnvironmentStringsW(d.c_str(), exp, 2048);
        std::wstring full = exp;
        bool absolute = (full.size() > 2 && full[1] == L':');
        std::wstring p1 = full, p2 = std::wstring(base) + L"\\" + full;
        if (RegFileThere(p1) || (!absolute && RegFileThere(p2))) continue;
        RegIssue is; is.cat = cat; is.where = std::wstring(hiveName) + L"\\..." + label; is.name = name;
        is.target = d; is.kind = L"value"; is.hive = hive; is.path = keyPath; is.extra = 0; g_regIssues.push_back(is);
    }
    RegCloseKey(k);
}
// Dead sound-scheme assignments under HKCU\AppEvents\Schemes\Apps\<app>\<event>\.Current.
static void RegScanSounds() {
    const wchar_t* root = L"AppEvents\\Schemes\\Apps";
    HKEY ka; if (RegOpenKeyExW(HKEY_CURRENT_USER, root, 0, KEY_READ, &ka) != ERROR_SUCCESS) return;
    wchar_t app[256];
    for (DWORD i = 0;; ++i) { DWORD al = 256; if (RegEnumKeyExW(ka, i, app, &al, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) break;
        std::wstring appPath = std::wstring(root) + L"\\" + app;
        HKEY ke; if (RegOpenKeyExW(HKEY_CURRENT_USER, appPath.c_str(), 0, KEY_READ, &ke) != ERROR_SUCCESS) continue;
        wchar_t evt[256];
        for (DWORD j = 0;; ++j) { DWORD el = 256; if (RegEnumKeyExW(ke, j, evt, &el, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) break;
            std::wstring cur = appPath + L"\\" + evt + L"\\.Current";
            wchar_t wav[1024] = L""; DWORD cb = sizeof(wav);
            if (RegGetValueW(HKEY_CURRENT_USER, cur.c_str(), nullptr, RRF_RT_REG_SZ, nullptr, wav, &cb) != ERROR_SUCCESS) continue;
            std::wstring w = wav; if (w.empty() || w.find(L'\\') == std::wstring::npos) continue;
            wchar_t exp[2048] = L""; ExpandEnvironmentStringsW(w.c_str(), exp, 2048);
            if (RegFileThere(exp)) continue;
            RegIssue is; is.cat = L"sound"; is.where = std::wstring(L"HKCU\\...\\") + app + L"\\" + evt; is.name = std::wstring(app) + L" / " + evt;
            is.target = w; is.kind = L"key"; is.hive = HKEY_CURRENT_USER; is.path = cur; is.extra = 0; g_regIssues.push_back(is);
        }
        RegCloseKey(ke);
    }
    RegCloseKey(ka);
}
static std::wstring RegScanJson() {
    g_regIssues.clear();
    wchar_t win[MAX_PATH] = L""; GetWindowsDirectoryW(win, MAX_PATH);
    std::wstring fonts = std::wstring(win) + L"\\Fonts", sys32 = std::wstring(win) + L"\\System32";
    RegScanRun(HKEY_CURRENT_USER, L"HKCU", 0);
    RegScanRun(HKEY_LOCAL_MACHINE, L"HKLM", KEY_WOW64_64KEY);
    RegScanRun(HKEY_LOCAL_MACHINE, L"HKLM", KEY_WOW64_32KEY);
    RegScanAppPaths(HKEY_CURRENT_USER, L"HKCU");
    RegScanAppPaths(HKEY_LOCAL_MACHINE, L"HKLM");
    RegScanUninstall(HKEY_LOCAL_MACHINE, L"HKLM", KEY_WOW64_64KEY);
    RegScanUninstall(HKEY_LOCAL_MACHINE, L"HKLM", KEY_WOW64_32KEY);
    RegScanUninstall(HKEY_CURRENT_USER, L"HKCU", 0);
    // Extra categories from LittleRegistryCleaner (conservative, path-existence tests).
    RegScanPathValueNames(HKEY_LOCAL_MACHINE, L"HKLM", L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SharedDLLs", KEY_WOW64_64KEY, L"shareddll", L"\\SharedDLLs", false);
    RegScanPathValueNames(HKEY_LOCAL_MACHINE, L"HKLM", L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Installer\\Folders", KEY_WOW64_64KEY, L"instfolder", L"\\Installer\\Folders", true);
    RegScanPathValueData(HKEY_LOCAL_MACHINE, L"HKLM", L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts", fonts.c_str(), L"font", L"\\Fonts");
    RegScanPathValueData(HKEY_LOCAL_MACHINE, L"HKLM", L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Drivers32", sys32.c_str(), L"driver32", L"\\Drivers32");
    RegScanSounds();
    std::wstring o = L"{\"type\":\"regscan\",\"data\":[";
    for (size_t i = 0; i < g_regIssues.size(); ++i) {
        if (i) o += L",";
        o += L"{\"id\":" + std::to_wstring(i) + L",\"cat\":" + JS(g_regIssues[i].cat) +
             L",\"where\":" + JS(g_regIssues[i].where) + L",\"name\":" + JS(g_regIssues[i].name) +
             L",\"target\":" + JS(g_regIssues[i].target) + L"}";
    }
    return o + L"]}";
}
static void RegFix(const std::wstring& csvIds) {
    // Back up the whole HKCU\Software\Butler-tracked set is overkill; instead
    // export each affected key to a .reg before deleting (so it is recoverable).
    SYSTEMTIME st; GetLocalTime(&st);
    wchar_t fn[64]; swprintf_s(fn, L"RegBackup-%04d%02d%02d-%02d%02d%02d.reg", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    std::wstring backup = ProgDataDir() + L"\\" + fn;
    std::set<size_t> ids;
    { size_t p = 0; while (p < csvIds.size()) { size_t c = csvIds.find(L',', p);
        std::wstring s = csvIds.substr(p, c == std::wstring::npos ? std::wstring::npos : c - p);
        if (!s.empty()) ids.insert((size_t)_wtoi(s.c_str())); if (c == std::wstring::npos) break; p = c + 1; } }
    int fixed = 0;
    for (size_t id : ids) {
        if (id >= g_regIssues.size()) continue;
        RegIssue& is = g_regIssues[id];
        const wchar_t* hiveTag = (is.hive == HKEY_CURRENT_USER) ? L"HKCU" : L"HKLM";
        // export-as-backup (append) then delete
        RunProcess(L"reg.exe export \"" + std::wstring(hiveTag) + L"\\" + is.path + L"\" \"" + backup + L"\" /y");
        if (is.kind == L"key") {
            RegDeleteTreeW(is.hive, is.path.c_str());
        } else {
            HKEY k;
            if (RegOpenKeyExW(is.hive, is.path.c_str(), 0, KEY_SET_VALUE | is.extra, &k) == ERROR_SUCCESS) {
                RegDeleteValueW(k, is.name.c_str()); RegCloseKey(k);
            }
        }
        fixed++;
    }
    PushJson(L"{\"type\":\"regfixed\",\"count\":" + std::to_wstring(fixed) + L",\"backup\":" + JS(backup) + L"}");
    PushJson(RegScanJson());  // refresh
}
// Browsable raw registry tweaks: dump each data-driven tweak's key/value/state so
// the user can apply/undo them directly from the Registry section.
static std::wstring RegTweaksJson() {
    std::wstring o = L"{\"type\":\"regtweaks\",\"data\":["; bool first = true;
    for (const auto& t : Tweaks()) {
        const RegOp& op = t.ops[0];
        const wchar_t* hv = (op.hive == HKEY_CURRENT_USER) ? L"HKCU" : (op.hive == HKEY_LOCAL_MACHINE ? L"HKLM" : L"HKCR");
        std::wstring val = op.isStr ? op.onS : std::to_wstring(op.onD);
        if (!first) o += L","; first = false;
        o += L"{\"id\":" + JS(t.id) + L",\"hive\":" + JS(hv) + L",\"path\":" + JS(op.path) +
             L",\"name\":" + JS(op.val) + L",\"on\":" + JB(TweakState(t)) + L",\"setval\":" + JS(val) + L"}";
    }
    return o + L"]}";
}
// Registry backup/restore: export HKCU + HKLM\SOFTWARE to a timestamped folder in
// Documents; restore re-imports the .reg files from a chosen folder.
static std::wstring RegBackupRoot() {
    wchar_t docs[MAX_PATH] = L""; SHGetFolderPathW(nullptr, CSIDL_PERSONAL, nullptr, 0, docs);
    return std::wstring(docs) + L"\\Butler Registry Backup";
}
static DWORD WINAPI RegBackupThread(LPVOID) {
    SYSTEMTIME st; GetLocalTime(&st);
    wchar_t sub[32]; swprintf_s(sub, L"%04d%02d%02d-%02d%02d%02d", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    std::wstring dir = RegBackupRoot() + L"\\" + sub;
    SHCreateDirectoryExW(nullptr, dir.c_str(), nullptr);
    PushJson(L"{\"type\":\"regbackupstatus\",\"phase\":\"running\"}");
    DWORD r1 = RunProcess(L"cmd /c reg export HKCU \"" + dir + L"\\HKCU.reg\" /y");
    DWORD r2 = RunProcess(L"cmd /c reg export \"HKLM\\SOFTWARE\" \"" + dir + L"\\HKLM-SOFTWARE.reg\" /y");
    bool ok = (r1 == 0 || r2 == 0);
    PushJson(L"{\"type\":\"regbackupdone\",\"ok\":" + JB(ok) + L",\"path\":" + JS(dir) + L"}");
    g_runReg = false; return 0;
}
static DWORD WINAPI RegRestoreThread(LPVOID) {
    std::wstring dir = g_regRestoreDir;
    PushJson(L"{\"type\":\"regbackupstatus\",\"phase\":\"restoring\"}");
    bool any = false;
    if (RegFileThere(dir + L"\\HKCU.reg")) { RunProcess(L"cmd /c reg import \"" + dir + L"\\HKCU.reg\""); any = true; }
    if (RegFileThere(dir + L"\\HKLM-SOFTWARE.reg")) { RunProcess(L"cmd /c reg import \"" + dir + L"\\HKLM-SOFTWARE.reg\""); any = true; }
    PushJson(L"{\"type\":\"regrestoredone\",\"ok\":" + JB(any) + L",\"path\":" + JS(dir) + L"}");
    g_runReg = false; return 0;
}

static void HandleMessage(const std::wstring& msg) {
    std::wstring cmd = JField(msg, L"cmd");
    if (cmd == L"scan") StartScan();
    else if (cmd == L"check") StartCheck();
    else if (cmd == L"apps") StartApps();
    else if (cmd == L"network") StartNetwork();
    else if (cmd == L"system") StartSystem();
    else if (cmd == L"health") StartFlag(HealthThread, g_runHealth);
    else if (cmd == L"unwanted") StartFlag(UnwantedThread, g_runSys);
    else if (cmd == L"openhosts") { std::wstring hp = ExpandEnv(L"%WINDIR%") + L"\\System32\\drivers\\etc\\hosts"; ShellExecuteW(nullptr, L"open", L"notepad.exe", hp.c_str(), nullptr, SW_SHOW); }
    else if (cmd == L"openproxy") { ShellExecuteW(nullptr, L"open", L"ms-settings:network-proxy", nullptr, nullptr, SW_SHOW); }
    else if (cmd == L"opentasks") { ShellExecuteW(nullptr, L"open", L"taskschd.msc", nullptr, nullptr, SW_SHOW); }
    else if (cmd == L"hygiene") StartFlag(HygieneThread, g_runSys);
    else if (cmd == L"openbitlocker") { ShellExecuteW(nullptr, L"open", L"control", L"/name Microsoft.BitLockerDriveEncryption", nullptr, SW_SHOW); }
    else if (cmd == L"openusers") { ShellExecuteW(nullptr, L"open", L"netplwiz.exe", nullptr, nullptr, SW_SHOW); }
    else if (cmd == L"openprivacy") { std::wstring cap = JField(msg, L"cap"); if (cap != L"webcam" && cap != L"microphone" && cap != L"location") cap = L"webcam"; std::wstring uri = L"ms-settings:privacy-" + cap; ShellExecuteW(nullptr, L"open", uri.c_str(), nullptr, nullptr, SW_SHOW); }
    else if (cmd == L"createrestore") StartCreateRestore();
    else if (cmd == L"perf") StartFlag(PerfThread, g_runSys);
    else if (cmd == L"battery") StartFlag(BatteryThread, g_runSys);
    else if (cmd == L"diskhealth") StartFlag(DiskHealthThread, g_runSys);
    else if (cmd == L"winupdate") StartFlag(WinUpdateThread, g_runSys);
    else if (cmd == L"wuinstall") StartFlag(WuInstallThread, g_runSys);
    else if (cmd == L"cleanup") StartFlag(CleanupThread, g_runSys);
    else if (cmd == L"cleanrun") StartFlag(CleanRunThread, g_runSys);
    else if (cmd == L"driverbackup") StartFlag(DriverBackupThread, g_runDrv);
    else if (cmd == L"driverimport") {
        std::wstring f = PickFolder();
        if (!f.empty()) { g_importFolder = f; StartFlag(DriverImportThread, g_runDrv); }
    }
    else if (cmd == L"netdiag") StartFlag(NetDiagThread, g_runNet);
    else if (cmd == L"fwconn") PushJson(FirewallConnJson());
    else if (cmd == L"fwblock") { FirewallBlock(JField(msg, L"path"), true); PushJson(FirewallConnJson()); }
    else if (cmd == L"fwunblock") { FirewallBlock(JField(msg, L"path"), false); PushJson(FirewallConnJson()); }
    else if (cmd == L"dupfolder") {          // choose folder only (modal on the UI thread)
        std::wstring folder = PickFolder();
        if (!folder.empty()) { g_dupFolder = folder; PushJson(L"{\"type\":\"dupfolder\",\"folder\":" + JS(folder) + L"}"); }
    }
    else if (cmd == L"dupscan") {            // scan the already-chosen folder
        std::wstring mx = JField(msg, L"max"); if (!mx.empty()) g_dupMax = _wtoi(mx.c_str());
        if (g_dupFolder.empty()) PushJson(L"{\"type\":\"dupscan\",\"data\":{\"folder\":\"\",\"wasteKb\":0,\"total\":0,\"groups\":[],\"needfolder\":true}}");
        else StartFlag(DupScanThread, g_runPhotos);
    }
    else if (cmd == L"dupdelete") { g_dupPaths = JField(msg, L"paths"); StartFlag(DupDeleteThread, g_runPhotos); }
    else if (cmd == L"fullimage") {
        std::wstring p = JField(msg, L"path");
        PushJson(L"{\"type\":\"fullimage\",\"path\":" + JS(p) + L",\"src\":" + JS(FullImageDataUri(p)) + L"}");
    }
    else if (cmd == L"setschedule") { g_schedule = JField(msg, L"on") != L"false"; SetSchedule(g_schedule); SaveSettings(); }
    else if (cmd == L"export") DoExportReport();
    else if (cmd == L"open") {
        std::wstring url = JField(msg, L"url");
        if (!url.empty()) ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    } else if (cmd == L"auto") {
        StartAuto(JField(msg, L"restore") != L"false", JField(msg, L"ids"));
    } else if (cmd == L"uninstall") {
        RunCommandLine(JField(msg, L"cmd2"));
    } else if (cmd == L"openfolder") {
        std::wstring loc = JField(msg, L"path");
        if (!loc.empty()) ShellExecuteW(nullptr, L"open", loc.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    } else if (cmd == L"setlang") {
        SetLanguage(JField(msg, L"lang"));
    } else if (cmd == L"setautocheck") {
        g_autoCheck = JField(msg, L"on") != L"false";
        SaveSettings();
    } else if (cmd == L"setautoupdate") {
        g_autoUpdate = JField(msg, L"on") != L"false";
        SaveSettings();
    } else if (cmd == L"updateonexit") {
        StartFlag(UpdateDownloadThread, g_runUpdate);
    } else if (cmd == L"settheme") {
        std::wstring t = JField(msg, L"theme");
        if (t == L"light" || t == L"dark" || t == L"auto") { g_theme = t; ApplyNativeTheme(); SaveSettings(); }
    } else if (cmd == L"setrestore") {
        g_autoRestore = JField(msg, L"on") != L"false";
        SaveSettings();
    } else if (cmd == L"disablestartup") {
        DisableStartup(JField(msg, L"kind"), JField(msg, L"name"), JField(msg, L"command"));
        PushStartup();
    } else if (cmd == L"enablestartup") {
        EnableStartup(JField(msg, L"kind"), JField(msg, L"name"), JField(msg, L"command"));
        PushStartup();
    } else if (cmd == L"tweaks") {
        PushJson(TweaksJson());
    } else if (cmd == L"settweak") {
        std::wstring tid = JField(msg, L"id"); bool ton = JField(msg, L"on") != L"false";
        SetTweak(tid, ton);
        AppendChange(L"tweak", tid + (ton ? L" on" : L" off"), L"tweak:" + tid + L":" + (ton ? L"0" : L"1"));
        PushJson(TweaksJson());
    } else if (cmd == L"restartexplorer") {
        RestartExplorer();
    } else if (cmd == L"regscan") {
        PushJson(RegScanJson());
    } else if (cmd == L"regfix") {
        RegFix(JField(msg, L"ids"));
    } else if (cmd == L"debloat") {
        g_debloatAction = JField(msg, L"action");
        AppendChange(L"debloat", g_debloatAction, L"");
        StartFlag(DebloatThread, g_runDebloat);
    } else if (cmd == L"appxlist") {
        StartFlag(AppxListThread, g_runDebloat);
    } else if (cmd == L"appxremove") {
        g_appxName = JField(msg, L"name");
        StartFlag(AppxRemoveThread, g_runDebloat);
    } else if (cmd == L"winget") {
        g_wingetId = JField(msg, L"id"); g_wingetAct = JField(msg, L"action");
        StartFlag(WingetThread, g_runInstall);
    } else if (cmd == L"wingetsearch") {
        g_wingetQuery = JField(msg, L"q");
        StartFlag(WingetSearchThread, g_runInstall);
    } else if (cmd == L"regtweaks") {
        PushJson(RegTweaksJson());
    } else if (cmd == L"regbackup") {
        StartFlag(RegBackupThread, g_runReg);
    } else if (cmd == L"regrestore") {
        std::wstring f = PickFolder();
        if (!f.empty()) { g_regRestoreDir = f; StartFlag(RegRestoreThread, g_runReg); }
    } else if (cmd == L"wingetups") {
        StartFlag(WingetUpgradesThread, g_runInstall);
    } else if (cmd == L"wingetupgrade") {
        g_upgradeId = JField(msg, L"id"); StartFlag(WingetUpgradeThread, g_runInstall);
    } else if (cmd == L"killretry") {
        g_upgradeId = JField(msg, L"id"); g_killPids = JField(msg, L"pids"); StartFlag(KillRetryThread, g_runInstall);
    } else if (cmd == L"checkupdate") {
        StartFlag(UpdateCheckThread, g_runUpdate);
    } else if (cmd == L"selfupdate") {
        StartFlag(SelfUpdateThread, g_runUpdate);
    } else if (cmd == L"wifikeys") {
        PushJson(WifiKeysJson());
    } else if (cmd == L"dnsbench") {
        StartFlag(DnsBenchThread, g_runNet);
    } else if (cmd == L"lifecycle") {
        PushJson(LifecycleJson());
    } else if (cmd == L"repair") {
        g_repairAction = JField(msg, L"action"); AppendChange(L"repair", g_repairAction, L""); StartFlag(RepairThread, g_runRepair);
    } else if (cmd == L"harden") {
        StartFlag(HardenThread, g_runSys);
    } else if (cmd == L"hardenfix") {
        g_hardenId = JField(msg, L"id"); AppendChange(L"harden", L"fix " + g_hardenId, L""); StartFlag(HardenFixThread, g_runSys);
    } else if (cmd == L"reliability") {
        StartFlag(ReliabilityThread, g_runSys);
    } else if (cmd == L"crashes") {
        StartFlag(CrashThread, g_runSys);
    } else if (cmd == L"backuppick") {
        std::wstring f = PickFolder(); if (!f.empty()) { g_backupDest = f; PushJson(L"{\"type\":\"backupdest\",\"folder\":" + JS(f) + L"}"); }
    } else if (cmd == L"backuprun") {
        AppendChange(L"backup", L"files backup", L""); StartFlag(BackupThread, g_runBackup);
    } else if (cmd == L"sysreport") {
        StartFlag(SysReportThread, g_runBackup);
    } else if (cmd == L"diskusage") {
        StartFlag(DiskUsageThread, g_runSys);
    } else if (cmd == L"changes") {
        PushJson(ChangesJson());
    } else if (cmd == L"undochange") {
        UndoChange(_wtoi(JField(msg, L"i").c_str())); PushJson(ChangesJson());
    } else if (cmd == L"clearchanges") {
        DeleteFileW(ChangesPath().c_str()); PushJson(ChangesJson());
    } else if (cmd == L"sensors") {
        PushJson(SensorsJson());
    } else if (cmd == L"profileexport") {
        bool ok = ProfileExport(); PushJson(L"{\"type\":\"profile\",\"act\":\"export\",\"ok\":" + JB(ok) + L",\"path\":" + JS(ProfilePath()) + L"}");
    } else if (cmd == L"profileimport") {
        int n = ProfileImport(); PushJson(L"{\"type\":\"profile\",\"act\":\"import\",\"ok\":" + JB(n >= 0) + L",\"count\":" + std::to_wstring(n < 0 ? 0 : n) + L"}"); PushJson(TweaksJson());
    } else if (cmd == L"setreport") {
        SetReportSchedule(JField(msg, L"on") != L"false");
    }
}

// Classic Windows menu bar (File / Tools / Language / Help), localized.
struct MenuT {
    const wchar_t *drivers, *apps, *network, *system, *settings, *help,
                  *drvscan, *exportr, *appsscan, *netscan, *sysscan,
                  *options, *language, *helpc, *about, *photos, *tweaks, *registry, *debloat;
};
static MenuT MenuFor(const std::wstring& l) {
    if (l == L"fr") return { L"Pilotes", L"Applications", L"Réseau", L"Système", L"Paramètres", L"Aide",
        L"Analyser et vérifier en ligne\tF5", L"Exporter le rapport\tCtrl+E", L"Analyser les applications", L"Analyser le réseau", L"Vérifier alertes et erreurs",
        L"Options", L"Langue", L"Sommaire de l'aide\tF1", L"À propos", L"Photos", L"Réglages", L"Registre", L"Nettoyer" };
    if (l == L"de") return { L"Treiber", L"Apps", L"Netzwerk", L"System", L"Einstellungen", L"Hilfe",
        L"Scannen & online prüfen\tF5", L"Bericht exportieren\tStrg+E", L"Apps scannen", L"Netzwerk scannen", L"Warnungen & Fehler prüfen",
        L"Optionen", L"Sprache", L"Hilfethemen\tF1", L"Info", L"Fotos", L"Optimierungen", L"Registry", L"Bereinigen" };
    if (l == L"it") return { L"Driver", L"App", L"Rete", L"Sistema", L"Impostazioni", L"Aiuto",
        L"Scansiona e verifica online\tF5", L"Esporta report\tCtrl+E", L"Analizza app", L"Analizza rete", L"Controlla avvisi ed errori",
        L"Opzioni", L"Lingua", L"Sommario\tF1", L"Informazioni", L"Foto", L"Ottimizzazioni", L"Registro", L"Pulisci" };
    if (l == L"pl") return { L"Sterowniki", L"Aplikacje", L"Sieć", L"System", L"Ustawienia", L"Pomoc",
        L"Skanuj i sprawdź online\tF5", L"Eksportuj raport\tCtrl+E", L"Skanuj aplikacje", L"Skanuj sieć", L"Sprawdź alerty i błędy",
        L"Opcje", L"Język", L"Spis treści\tF1", L"O programie", L"Zdjęcia", L"Ulepszenia", L"Rejestr", L"Wyczyść" };
    if (l == L"uk") return { L"Драйвери", L"Програми", L"Мережа", L"Система", L"Налаштування", L"Довідка",
        L"Сканувати й перевірити онлайн\tF5", L"Експортувати звіт\tCtrl+E", L"Сканувати програми", L"Сканувати мережу", L"Перевірити сповіщення та помилки",
        L"Параметри", L"Мова", L"Зміст довідки\tF1", L"Про програму", L"Фото", L"Твіки", L"Реєстр", L"Очистити" };
    if (l == L"es") return { L"Controladores", L"Apps", L"Red", L"Sistema", L"Ajustes", L"Ayuda",
        L"Analizar y comprobar en línea\tF5", L"Exportar informe\tCtrl+E", L"Analizar apps", L"Analizar red", L"Comprobar alertas y errores",
        L"Opciones", L"Idioma", L"Contenido de ayuda\tF1", L"Acerca de", L"Fotos", L"Retoques", L"Registro", L"Depurar" };
    if (l == L"pt") return { L"Controladores", L"Apps", L"Rede", L"Sistema", L"Definições", L"Ajuda",
        L"Analisar e verificar online\tF5", L"Exportar relatório\tCtrl+E", L"Analisar apps", L"Analisar rede", L"Verificar alertas e erros",
        L"Opções", L"Idioma", L"Conteúdo da ajuda\tF1", L"Acerca de", L"Fotos", L"Otimizações", L"Registo", L"Depurar" };
    if (l == L"ro") return { L"Drivere", L"Aplicații", L"Rețea", L"Sistem", L"Setări", L"Ajutor",
        L"Scanează și verifică online\tF5", L"Exportă raportul\tCtrl+E", L"Scanează aplicațiile", L"Scanează rețeaua", L"Verifică alerte și erori",
        L"Opțiuni", L"Limbă", L"Cuprins ajutor\tF1", L"Despre", L"Fotografii", L"Optimizări", L"Registru", L"Curăță" };
    return { L"Drivers", L"Apps", L"Network", L"System", L"Settings", L"Help",
        L"Scan && check online\tF5", L"Export report\tCtrl+E", L"Scan apps", L"Scan network", L"Check alerts && errors",
        L"Options", L"Language", L"Help contents\tF1", L"About", L"Photos", L"Tweaks", L"Registry", L"Debloat" };
}

// The menu bar is the single navigation strip: each top-level item navigates to
// a category (no submenus, no second pill row). Per-category actions (Scan,
// Export, etc.) live as buttons inside each view; language lives in Settings.
static void BuildMenu(HWND hwnd) {
    MenuT s = MenuFor(g_lang);
    HMENU bar = CreateMenu();
    // Category navigation lives in the in-content pill bar (clear active state).
    // The menu bar keeps only app-level items: Settings and Help.
    AppendMenuW(bar, MF_STRING, ID_SETTINGS, s.settings);
    AppendMenuW(bar, MF_STRING, ID_HELP,     s.help);

    HMENU old = GetMenu(hwnd);
    SetMenu(hwnd, bar);
    if (old) DestroyMenu(old);
}
static void RebuildMenu() { if (g_hwnd) { BuildMenu(g_hwnd); DrawMenuBar(g_hwnd); } }

// --- Dark menu bar (undocumented uxtheme dark mode + UAH menu-bar drawing) ---
#define WM_UAHDRAWMENU      0x0091
#define WM_UAHDRAWMENUITEM  0x0092
typedef union { struct { DWORD cx, cy; } rgsizeBar[2]; struct { DWORD cx, cy; } rgsizePopup[4]; } UAHMENUITEMMETRICS;
typedef struct { DWORD rgcx[4]; DWORD fUpdateMaxWidths : 2; } UAHMENUPOPUPMETRICS;
typedef struct { HMENU hmenu; HDC hdc; DWORD dwFlags; } UAHMENU;
typedef struct { int iPosition; UAHMENUITEMMETRICS umim; UAHMENUPOPUPMETRICS umpm; } UAHMENUITEM;
typedef struct { DRAWITEMSTRUCT dis; UAHMENU um; UAHMENUITEM umi; } UAHDRAWMENUITEM;

static HBRUSH g_brMenuBg = nullptr, g_brMenuHot = nullptr;
static bool g_darkMenu = false;

static void EnableDarkMode(HWND hwnd) {
    HMODULE ux = LoadLibraryExW(L"uxtheme.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!ux) return;
    typedef int (WINAPI* fnSetPreferredAppMode)(int);          // ordinal 135
    typedef bool (WINAPI* fnAllowDarkModeForWindow)(HWND, bool); // ordinal 133
    typedef void (WINAPI* fnFlushMenuThemes)();                  // ordinal 136
    auto setMode = (fnSetPreferredAppMode)GetProcAddress(ux, MAKEINTRESOURCEA(135));
    auto allowWin = (fnAllowDarkModeForWindow)GetProcAddress(ux, MAKEINTRESOURCEA(133));
    auto flush = (fnFlushMenuThemes)GetProcAddress(ux, MAKEINTRESOURCEA(136));
    if (!setMode || !allowWin) return;
    setMode(1);                  // AllowDark
    allowWin(hwnd, true);
    if (flush) flush();
    g_brMenuBg = CreateSolidBrush(RGB(23, 26, 33));
    g_brMenuHot = CreateSolidBrush(RGB(45, 52, 66));
    g_darkMenu = true;
}
// True when Windows is set to a light app theme (used for Theme=auto).
static bool OsUsesLightTheme() {
    HKEY k; DWORD v = 0, cb = sizeof(v); bool light = false;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                      0, KEY_READ, &k) == ERROR_SUCCESS) {
        if (RegGetValueW(k, nullptr, L"AppsUseLightTheme", RRF_RT_REG_DWORD, nullptr, &v, &cb) == ERROR_SUCCESS) light = (v != 0);
        RegCloseKey(k);
    }
    return light;
}
// Apply g_theme to the native chrome (title bar + menu bar). The WebView body
// is themed separately in CSS via data-theme. Called on launch and on change.
static void ApplyNativeTheme() {
    if (!g_hwnd) return;
    bool dark = (g_theme == L"dark") || (g_theme != L"light" && !OsUsesLightTheme());
    BOOL d = dark ? TRUE : FALSE;
    DwmSetWindowAttribute(g_hwnd, 20, &d, sizeof(d));  // DWMWA_USE_IMMERSIVE_DARK_MODE
    HMODULE ux = LoadLibraryExW(L"uxtheme.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (ux) {
        typedef int (WINAPI* fnSetMode)(int);            // ordinal 135 SetPreferredAppMode
        typedef void (WINAPI* fnFlush)();                 // ordinal 136 FlushMenuThemes
        auto setMode = (fnSetMode)GetProcAddress(ux, MAKEINTRESOURCEA(135));
        auto flush = (fnFlush)GetProcAddress(ux, MAKEINTRESOURCEA(136));
        if (setMode) setMode(dark ? 2 : 3);  // 2=ForceDark, 3=ForceLight
        if (flush) flush();
    }
    g_darkMenu = dark;
    if (g_brMenuBg) DeleteObject(g_brMenuBg);
    if (g_brMenuHot) DeleteObject(g_brMenuHot);
    if (dark) { g_brMenuBg = CreateSolidBrush(RGB(23, 26, 33)); g_brMenuHot = CreateSolidBrush(RGB(45, 52, 66)); }
    else      { g_brMenuBg = CreateSolidBrush(RGB(243, 246, 250)); g_brMenuHot = CreateSolidBrush(RGB(208, 221, 245)); }
    DrawMenuBar(g_hwnd);
    RedrawWindow(g_hwnd, nullptr, nullptr, RDW_FRAME | RDW_INVALIDATE);
}
static LRESULT UahDrawMenuBar(HWND hwnd, UAHMENU* pUDM) {
    MENUBARINFO mbi{ sizeof(mbi) };
    GetMenuBarInfo(hwnd, OBJID_MENU, 0, &mbi);
    RECT rcWin; GetWindowRect(hwnd, &rcWin);
    RECT rc = mbi.rcBar; OffsetRect(&rc, -rcWin.left, -rcWin.top);
    FillRect(pUDM->hdc, &rc, g_brMenuBg);
    return TRUE;
}
static LRESULT UahDrawMenuItem(HWND, UAHDRAWMENUITEM* p) {
    wchar_t text[256] = L"";
    MENUITEMINFOW mii{ sizeof(mii) }; mii.fMask = MIIM_STRING; mii.dwTypeData = text; mii.cch = 255;
    GetMenuItemInfoW(p->um.hmenu, p->umi.iPosition, TRUE, &mii);
    bool hot = (p->dis.itemState & (ODS_HOTLIGHT | ODS_SELECTED)) != 0;
    bool gray = (p->dis.itemState & (ODS_GRAYED | ODS_DISABLED)) != 0;
    FillRect(p->um.hdc, &p->dis.rcItem, hot ? g_brMenuHot : g_brMenuBg);
    SetBkMode(p->um.hdc, TRANSPARENT);
    SetTextColor(p->um.hdc, gray ? RGB(120, 126, 138) : (g_darkMenu ? RGB(230, 233, 239) : RGB(27, 31, 39)));
    DrawTextW(p->um.hdc, text, -1, &p->dis.rcItem, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
    return TRUE;
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_SIZE:
        if (g_controller) { RECT rc; GetClientRect(hwnd, &rc); g_controller->put_Bounds(rc); }
        return 0;
    case WM_PUSH_JSON: {
        std::wstring* s = (std::wstring*)lp;
        if (g_webview) g_webview->PostWebMessageAsJson(s->c_str());
        delete s; return 0;
    }
    case WM_COMMAND: {
        int id = LOWORD(wp);
        switch (id) {
            // Top-level navigation (menu bar = nav). These only switch view; the
            // scan happens when the user clicks the button inside the view.
            case ID_NAV_DRIVERS: NavCat(L"drivers", L""); break;
            case ID_NAV_APPS:    NavCat(L"apps", L""); break;
            case ID_NAV_NETWORK: NavCat(L"network", L""); break;
            case ID_NAV_SYSTEM:  NavCat(L"system", L""); break;
            case ID_NAV_PHOTOS:  NavCat(L"photos", L""); break;
            case ID_NAV_TWEAKS:  NavCat(L"tweaks", L""); break;
            case ID_NAV_REGISTRY: NavCat(L"registry", L""); break;
            case ID_NAV_DEBLOAT: NavCat(L"debloat", L""); break;
            // Keyboard accelerators (explicit user keypress, so acting is fine).
            case ID_DRV_SCAN:   NavCat(L"drivers", L"updates"); StartScan(); break;
            case ID_DRV_EXPORT: DoExportReport(); break;
            case ID_APPS_SCAN:  NavCat(L"apps", L""); StartApps(); break;
            case ID_NET_SCAN:   NavCat(L"network", L""); StartNetwork(); break;
            case ID_SYS_SCAN:   NavCat(L"system", L""); StartSystem(); break;
            case ID_SETTINGS:   NavCat(L"settings", L""); break;
            case ID_HELP:       NavCat(L"help", L""); break;
            case ID_ABOUT:
                MessageBoxW(hwnd, APP_NAME L"  " APP_VERSION L"  -  " APP_TAGLINE
                            L"\n\nTends to your PC: drivers, apps, network, and system health,\n"
                            L"explained in plain language with one-click fixes.\n\n"
                            L"Free and in beta. Provided \"as is\", without warranty of any kind.\n"
                            L"It changes drivers, the registry and system settings, so use it at\n"
                            L"your own risk and keep a restore point. The authors are not liable\n"
                            L"for any data loss or damage. Not affiliated with Microsoft.\n\n(c) 2026",
                            L"About " APP_NAME, MB_OK | MB_ICONINFORMATION);
                break;
            case ID_EXIT:     DestroyWindow(hwnd); break;
            default:
                if (id >= ID_LANG_BASE && id < ID_LANG_BASE + kLangCount)
                    SetLanguage(kLangs[id - ID_LANG_BASE].code);  // rebuilds menu + re-checks radio
        }
        return 0;
    }
    case WM_UAHDRAWMENU:
        if (g_darkMenu) return UahDrawMenuBar(hwnd, (UAHMENU*)lp);
        break;
    case WM_UAHDRAWMENUITEM:
        if (g_darkMenu) return UahDrawMenuItem(hwnd, (UAHDRAWMENUITEM*)lp);
        break;
    case WM_DESTROY:
        SaveWindowRect(hwnd);
        // If the user chose "update when I close Butler", launch the downloaded
        // installer now - a short delay lets this process exit first.
        if (g_updateOnExit && !g_updateSetupPath.empty() && GetFileAttributesW(g_updateSetupPath.c_str()) != INVALID_FILE_ATTRIBUTES) {
            std::wstring args = L"/c ping 127.0.0.1 -n 3 >nul & \"" + g_updateSetupPath + L"\"";
            ShellExecuteW(nullptr, L"open", L"cmd.exe", args.c_str(), nullptr, SW_HIDE);
        }
        PostQuitMessage(0); return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

static void CreateWebView(HWND hwnd) {
    std::wstring udf = ProgDataDir() + L"\\WebView2";
    CreateCoreWebView2EnvironmentWithOptions(nullptr, udf.c_str(), nullptr,
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [hwnd](HRESULT, ICoreWebView2Environment* env) -> HRESULT {
                env->CreateCoreWebView2Controller(hwnd,
                    Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                        [hwnd](HRESULT, ICoreWebView2Controller* controller) -> HRESULT {
                            if (!controller) return S_OK;
                            g_controller = controller;
                            g_controller->get_CoreWebView2(&g_webview);
                            ComPtr<ICoreWebView2Settings> s;
                            g_webview->get_Settings(&s);
                            if (s) { s->put_AreDevToolsEnabled(FALSE); s->put_IsStatusBarEnabled(FALSE);
                                     s->put_AreDefaultContextMenusEnabled(FALSE); }
                            RECT rc; GetClientRect(hwnd, &rc); g_controller->put_Bounds(rc);
                            EventRegistrationToken tok;
                            g_webview->add_WebMessageReceived(
                                Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                                    [](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                                        LPWSTR raw = nullptr;
                                        if (SUCCEEDED(args->get_WebMessageAsJson(&raw)) && raw) {
                                            HandleMessage(raw); CoTaskMemFree(raw);
                                        }
                                        return S_OK;
                                    }).Get(), &tok);
                            {
                                EventRegistrationToken navTok;
                                g_webview->add_NavigationCompleted(
                                    Callback<ICoreWebView2NavigationCompletedEventHandler>(
                                        [](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*) -> HRESULT {
                                            { SYSTEM_POWER_STATUS sps0{}; GetSystemPowerStatus(&sps0); bool hasBat = sps0.BatteryFlag != 128 && sps0.BatteryFlag != 255;
                                            PushJson(std::wstring(L"{\"type\":\"settings\",\"autoCheck\":") + (g_autoCheck ? L"true" : L"false") + L",\"autoUpdate\":" + (g_autoUpdate ? L"true" : L"false") + L",\"schedule\":" + (g_schedule ? L"true" : L"false") + L",\"theme\":" + JS(g_theme) + L",\"autoRestore\":" + (g_autoRestore ? L"true" : L"false") + L",\"hasBattery\":" + (hasBat ? L"true" : L"false") + L"}"); }
                                            if (g_lang != L"en")
                                                PushJson(L"{\"type\":\"lang\",\"lang\":" + JS(g_lang) + L"}");
                                            if (!g_startTab.empty())
                                                PushJson(L"{\"type\":\"nav\",\"cat\":" + JS(g_startTab) +
                                                         (g_startSub.empty() ? L"" : L",\"sub\":" + JS(g_startSub)) + L"}");
                                            // Re-show the previous scan (remembered across restarts).
                                            { std::wstring last; if (ReadUtf8File(LastScanPath(), last) && !last.empty()) PushJson(last); }
                                            if (g_autoScan) PushJson(L"{\"type\":\"autorun\"}");
                                            // Resume a driver install that was interrupted by a reboot.
                                            if (g_resumeAuto) {
                                                NavCat(L"drivers", L"auto");
                                                PushJson(L"{\"type\":\"log\",\"text\":\"Resuming driver installation after restart...\"}");
                                                StartAuto(true, L"", true);
                                            }
                                            return S_OK;
                                        }).Get(), &navTok);
                            }
                            { std::wstring html = LoadUiHtml(); g_webview->NavigateToString(html.c_str()); }
                            return S_OK;
                        }).Get());
                return S_OK;
            }).Get());
}

// ===========================================================================
// Entry point + headless / resume modes
// ===========================================================================
static int RunHeadless(const std::wstring& outPath, bool skipWu, bool check) {
    ScanResult* r = RunScan(skipWu);
    if (check) CheckLatestVersions(*r, nullptr);
    SYSTEMTIME st; GetLocalTime(&st);
    std::wstring path = outPath;
    if (path.empty()) { wchar_t fn[64]; swprintf_s(fn, L"DriverReport-%04d%02d%02d-%02d%02d%02d.html", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond); path = ExeDir() + L"\\" + fn; }
    bool ok = WriteReport(*r, path); delete r; return ok ? 0 : 2;
}

static void ShowTrayNotice(const std::wstring& title, const std::wstring& text) {
    WNDCLASSW wc{}; wc.lpfnWndProc = DefWindowProcW; wc.hInstance = GetModuleHandleW(nullptr); wc.lpszClassName = L"ButlerTray";
    RegisterClassW(&wc);
    HWND hw = CreateWindowW(L"ButlerTray", L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, wc.hInstance, nullptr);
    NOTIFYICONDATAW nid{}; nid.cbSize = sizeof(nid); nid.hWnd = hw; nid.uID = 1;
    nid.uFlags = NIF_ICON | NIF_INFO | NIF_TIP;
    nid.hIcon = LoadIconW(nullptr, IDI_INFORMATION);
    wcscpy_s(nid.szTip, L"Butler");
    wcsncpy_s(nid.szInfo, text.c_str(), _TRUNCATE);
    wcsncpy_s(nid.szInfoTitle, title.c_str(), _TRUNCATE);
    nid.dwInfoFlags = NIIF_INFO;
    Shell_NotifyIconW(NIM_ADD, &nid);
    ULONGLONG t = GetTickCount64(); MSG m;
    while (GetTickCount64() - t < 8000) { while (PeekMessageW(&m, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&m); DispatchMessageW(&m); } Sleep(50); }
    Shell_NotifyIconW(NIM_DELETE, &nid); DestroyWindow(hw);
}
// Silent run for the scheduled task: scan, and notify only if something needs attention.
static int RunHealthCheck() {
    ScanResult* r = RunScan(true);          // skip slow WU query
    CheckLatestVersions(*r, nullptr);
    int updates = 0; for (const auto& d : r->drivers) if (d.verdict == L"UPDATE AVAILABLE") updates++;
    int problems = (int)r->problems.size();
    delete r;
    std::vector<SysAlert> al; std::vector<DiskWarn> dk; ScanSystem(al, dk);
    if (updates == 0 && problems == 0 && dk.empty()) return 0;  // all good -> stay silent
    std::wstring msg;
    if (updates) msg += std::to_wstring(updates) + L" driver update(s). ";
    if (problems) msg += std::to_wstring(problems) + L" device problem(s). ";
    if (!dk.empty()) msg += L"Low disk space. ";
    if (!al.empty()) msg += std::to_wstring((int)al.size()) + L" recent error(s).";
    ShowTrayNotice(L"Butler - attention needed", msg + L"  Open Butler to review.");
    return 0;
}

int APIENTRY wWinMain(HINSTANCE hInst, HINSTANCE, LPWSTR, int nCmdShow) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);  // STA for the UI thread (folder picker, shell dialogs)
    LoadSettings();  // restore saved language + auto-check (CLI flags below can override)

    int argc = 0; LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    bool exportMode = false, skipWu = false, check = false, autoMode = false, resume = false;
    std::wstring outPath, dumpApps, dumpNet, dumpSys;
    for (int i = 1; i < argc; ++i) {
        std::wstring a = argv[i];
        if (a == L"--export") { exportMode = true; if (i + 1 < argc && argv[i + 1][0] != L'-') outPath = argv[++i]; }
        else if (a == L"--skipwu") { skipWu = true; g_skipWu = true; }
        else if (a == L"--autoscan") g_autoScan = true;
        else if (a == L"--check") check = true;
        else if (a == L"--auto") autoMode = true;
        else if (a == L"--resume") resume = true;
        else if (a == L"--dumpapps") { dumpApps = (i + 1 < argc) ? argv[++i] : L"apps.json"; }
        else if (a == L"--dumpnet") { dumpNet = (i + 1 < argc) ? argv[++i] : L"net.json"; }
        else if (a == L"--dumpsys") { dumpSys = (i + 1 < argc) ? argv[++i] : L"sys.json"; }
        else if (a == L"--healthcheck") { LocalFree(argv); SetProcessDPIAware(); return RunHealthCheck(); }
        else if (a == L"--report") { LocalFree(argv); return RunReport(); }
        else if (a == L"--install")   { LocalFree(argv); return InstallApp(); }
        else if (a == L"--uninstall") { LocalFree(argv); return UninstallApp(); }
        else if (a == L"--dumpdup") {  // --dumpdup <folder> [outfile]  (headless duplicate scan)
            std::wstring folder = (i + 1 < argc) ? argv[++i] : L"";
            std::wstring outp = (i + 1 < argc && argv[i + 1][0] != L'-') ? argv[++i] : L"dup.json";
            WriteUtf8(outp, DupScanJson(folder)); if (argv) LocalFree(argv); return 0;
        }
        else if (a.rfind(L"--stale=", 0) == 0) g_staleMonths = _wtoi(a.c_str() + 8);
        else if (a.rfind(L"--lang=", 0) == 0) {
            std::wstring code = a.substr(7);
            for (int k = 0; k < kLangCount; ++k) if (code == kLangs[k].code) g_lang = code;
        }
        else if (a.rfind(L"--tab=", 0) == 0) g_startTab = a.substr(6);
        else if (a.rfind(L"--sub=", 0) == 0) g_startSub = a.substr(6);
    }
    if (argv) LocalFree(argv);
    // If the exe is named like a setup (Butler-Setup*.exe), installing is the
    // intent of a double-click - run the installer instead of the app.
    { std::wstring exe = ExePathFull(); std::wstring low = exe; std::transform(low.begin(), low.end(), low.begin(), towlower);
      if (low.find(L"setup") != std::wstring::npos && low.find(L"\\program files\\butler\\") == std::wstring::npos)
          return InstallApp(); }
    if (!dumpApps.empty()) { std::vector<AppInfo> v; EnumerateApps(v); WriteUtf8(dumpApps, AppsJson(v)); return 0; }
    if (!dumpNet.empty())  { WriteUtf8(dumpNet, ScanNetworkJson()); return 0; }
    if (!dumpSys.empty())  { WriteUtf8(dumpSys, ScanSystemJson()); return 0; }
    if (exportMode) return RunHeadless(outPath, skipWu, check);

    WNDCLASSEXW wc{}; wc.cbSize = sizeof(wc); wc.lpfnWndProc = WndProc; wc.hInstance = hInst;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    wc.lpszClassName = L"ButlerWV";
    wc.hIcon = LoadIconW(hInst, MAKEINTRESOURCEW(IDI_BUTLER));
    wc.hIconSm = (HICON)LoadImageW(hInst, MAKEINTRESOURCEW(IDI_BUTLER), IMAGE_ICON, 16, 16, 0);
    RegisterClassExW(&wc);

    g_hwnd = CreateWindowExW(0, wc.lpszClassName, APP_NAME L" - " APP_TAGLINE L" - " APP_VERSION,
                             WS_OVERLAPPEDWINDOW, g_winX, g_winY, g_winW, g_winH,
                             nullptr, nullptr, hInst, nullptr);
    if (!g_hwnd) return 1;

    EnableDarkMode(g_hwnd);  // dark popups + UAH menu bar (no-op on older Windows)
    BuildMenu(g_hwnd);
    ApplyNativeTheme();      // title bar + menu follow the saved Theme setting (auto/light/dark)

    ShowWindow(g_hwnd, nCmdShow); UpdateWindow(g_hwnd);
    CreateWebView(g_hwnd);

    ACCEL accels[] = {
        { FVIRTKEY, VK_F5, ID_DRV_SCAN },
        { FVIRTKEY, VK_F1, ID_HELP },
        { FCONTROL | FVIRTKEY, 'E', ID_DRV_EXPORT },
    };
    HACCEL hAccel = CreateAcceleratorTableW(accels, 3);

    // Auto-resume after a reboot: clear the one-shot RunOnce key and let the
    // NavigationCompleted handler continue the saved install job once the UI loads.
    if (resume) { SetRunOnceResume(false); g_resumeAuto = true; }

    MSG m;
    while (GetMessageW(&m, nullptr, 0, 0)) {
        if (hAccel && TranslateAcceleratorW(g_hwnd, hAccel, &m)) continue;
        TranslateMessage(&m); DispatchMessageW(&m);
    }
    return 0;
}
