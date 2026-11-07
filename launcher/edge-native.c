/* ============================================================================
 * Edge Control Center — NATIVE Windows application (pure Win32/GDI, no browser)
 * v2.1.0 "NATIVE"
 *
 *   [EdgeControlCenter.exe (this PE, GUI subsystem)][engine blob][u64 len][ECCNATIVE1]
 *
 * First run: extracts the hidden engine (self-contained Node SEA exe) into
 * %LOCALAPPDATA%\EdgeControlCenter\, starts it CREATE_NO_WINDOW. The ENTIRE
 * UI is rendered here with GDI — dark pages, custom sliders/toggles,
 * sparklines, gauges. No browser windows. Web panel stays optional.
 * ==========================================================================*/
#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#define _WIN32_IE 0x0600
#include <windows.h>
#include <windowsx.h>
#include <shlobj.h>
#include <shellapi.h>
#include <commctrl.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <math.h>

/* ---------------- palette / layout ---------------- */
#define C_BG      RGB(11, 13, 18)
#define C_PANEL   RGB(18, 21, 29)
#define C_PANEL2  RGB(24, 28, 39)
#define C_LINE    RGB(40, 46, 62)
#define C_TEXT    RGB(232, 234, 240)
#define C_MUT     RGB(150, 158, 176)
#define C_ACC     RGB(255, 77, 46)
#define C_ACC2    RGB(255, 157, 46)
#define C_OK      RGB(63, 211, 159)
#define C_BAD     RGB(255, 77, 94)
#define C_INFO    RGB(88, 166, 255)
#define C_EDITBG  RGB(14, 17, 24)

#define APP_CLASS  L"ECCNativeMainWindow"
#define APP_MUTEX  L"EdgeControlCenter.Native.Mutex"
#define WM_TRAY    (WM_APP + 1)
#define WM_TICK    (WM_APP + 2)
#define WM_ACT     (WM_APP + 3)

#define RAIL_W   190
#define HEADER_H 56
#define STATUS_H 26
#define CX0      (RAIL_W + 16)
#define CY0      (HEADER_H + 12)
#define CW       1180
#define CH       780
#define CWW      (CW - RAIL_W - 32)
#define CHH      (CH - HEADER_H - STATUS_H - 24)

enum { PG_OVERVIEW = 0, PG_DEVICE, PG_POWER, PG_THERMAL, PG_NETWORK, PG_STABILITY, PG_AI, PG_ADMIN, PG_COUNT };

enum { IDB_PING = 2100, IDB_DNS, IDB_ANALYZE, IDB_AIGEN, IDB_LOGIN, IDB_SNAP, IDB_AUDIT,
       IDB_PLAPPLY, IDB_THAPPLY, IDB_DEBAPPLY, IDB_DPIAPPLY, IDE_PINGHOST, IDE_DPI, IDE_DEB,
       IDE_STAB, IDE_AIPROMPT, IDE_AISTEPS, IDE_AU, IDE_AP, IDE_LOG };

static const wchar_t *PAGENAMES[PG_COUNT] = {
  L"Обзор", L"Мышь 3327", L"Питание", L"Термал", L"Сеть", L"Стабильность", L"ИИ-студия", L"Админ"
};
static const wchar_t *PAGEICONS[PG_COUNT] = { L"О", L"М", L"П", L"Т", L"С", L"!", L"И", L"А" };

/* ---------------- runtime state ---------------- */
typedef struct {
  double cpu, memPct, wallW, effPct, loadPct, epsW, gpuW, cpuTemp, gpuTemp;
  double riskPct, fanPwm, swapGiB, rxKbps, txKbps;
  int sweet, lod, tttCpu, tttGpu, cores, cpuMhz, pl1, pl2;
  char cls[24], debounce[24], dpi[160], unlocks[160], version[16];
} EccState;

static EccState g_st;
static CRITICAL_SECTION g_stCS;
static float g_hWall[120], g_hCpu[120], g_hTemp[120], g_hRisk[120];
static int g_hn = 0;

static HINSTANCE g_hInst;
static HWND g_hWnd;
static HFONT g_fH1, g_fH2, g_fBody, g_fSmall, g_fMono, g_fRail, g_fBig, g_fMark;
static HBRUSH g_brPanel, g_brEditBg;
static HICON g_hIcon;
static int g_page = PG_OVERVIEW;
static volatile BOOL g_engineReady = FALSE, g_engineDead = FALSE, g_extracting = TRUE;
static wchar_t g_status[256] = L"Инициализация…";
static wchar_t g_enginePath[MAX_PATH];
static HANDLE g_hEngine = NULL;
static int g_port = 3327;
static wchar_t g_token[96];
static wchar_t g_user[40] = L"hasberd";
static wchar_t g_log[16384];
static wchar_t g_jobId[48] = L"—";
static wchar_t g_jobStatus[64] = L"—";
static int g_dba = 32;
static NOTIFYICONDATAW g_nid;

static HWND g_ctrls[40];
static int g_nctrls = 0;

typedef struct { RECT r; BOOL on; const char *uid; const wchar_t *label; } Toggle;
typedef struct { RECT r; int min, max, val; const wchar_t *label; BOOL drag; } Slider;
static Toggle g_tg[5];
static Slider g_sl[3];                 /* pl1, pl2, dba */
static RECT g_railR[PG_COUNT];
static RECT g_webBtnR, g_lodR[3], g_profR[5], g_applyDpiR;

/* ================================================================ helpers */
static void Log(const wchar_t *fmt, ...) {
  va_list ap; wchar_t buf[1200];
  va_start(ap, fmt); _vsnwprintf(buf, 1199, fmt, ap); va_end(ap); buf[1199] = 0;
  int l = lstrlenW(g_log);
  if (l > 12000) { memmove(g_log, g_log + 4000, (l - 4000 + 1) * sizeof(wchar_t)); l = lstrlenW(g_log); }
  _snwprintf(g_log + l, 16380 - l, L"%s\r\n", buf);
  g_log[16383] = 0;
  HWND le = GetDlgItem(g_hWnd, IDE_LOG);
  if (le && IsWindowVisible(le)) SetWindowTextW(le, g_log);
}
static void SetStatusW(const wchar_t *s) {
  lstrcpynW(g_status, s, 250);
  RECT r; GetClientRect(g_hWnd, &r);
  r.top = r.bottom - STATUS_H; InvalidateRect(g_hWnd, &r, TRUE);
}
static EccState SnapState(void) { EnterCriticalSection(&g_stCS); EccState s = g_st; LeaveCriticalSection(&g_stCS); return s; }

/* ================================================================ http */
static BOOL NetInit(void) { static BOOL ok = FALSE; if (!ok) { WSADATA w; ok = WSAStartup(MAKEWORD(2, 2), &w) == 0; } return ok; }

/* returns malloc'd BODY (headers stripped); NULL on failure */
static char *HttpReq(const char *method, const char *path, const char *body, int *outLen) {
  if (!NetInit()) return NULL;
  SOCKET s = socket(AF_INET, SOCK_STREAM, 0);
  if (s == INVALID_SOCKET) return NULL;
  DWORD tmo = 6000;
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (char *)&tmo, sizeof tmo);
  setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (char *)&tmo, sizeof tmo);
  struct sockaddr_in a; memset(&a, 0, sizeof a);
  a.sin_family = AF_INET; a.sin_port = htons((u_short)g_port);
  inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
  if (connect(s, (struct sockaddr *)&a, sizeof a) != 0) { closesocket(s); return NULL; }
  char hdr[512];
  int hl = _snprintf(hdr, sizeof hdr,
    "%s %s HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nConnection: close\r\n\r\n",
    method, path, body ? (int)strlen(body) : 0);
  if (send(s, hdr, hl, 0) <= 0 || (body && *body && send(s, body, (int)strlen(body), 0) <= 0)) {
    closesocket(s); return NULL;
  }
  int cap = 1 << 20, len = 0, n;
  char *buf = (char *)malloc(cap);
  while (len < cap - 1 && (n = recv(s, buf + len, cap - len - 1, 0)) > 0) len += n;
  closesocket(s);
  buf[len] = 0;
  char *p = strstr(buf, "\r\n\r\n");
  if (!p) { free(buf); return NULL; }
  p += 4;
  int blen = len - (int)(p - buf);
  memmove(buf, p, blen + 1);
  if (outLen) *outLen = blen;
  return buf;
}
static BOOL ProbeReady(void) {
  char *b = HttpReq("GET", "/api/state", NULL, NULL);
  if (!b) return FALSE;
  BOOL ok = b[0] == '{' && strstr(b, "\"app\"") != NULL;
  free(b);
  return ok;
}

/* ================================================================ engine */
static BOOL ExtractEngine(void) {
  wchar_t exe[MAX_PATH];
  GetModuleFileNameW(NULL, exe, MAX_PATH);
  FILE *f = _wfopen(exe, L"rb");
  if (!f) return FALSE;
  _fseeki64(f, -18, SEEK_END);
  unsigned char tail[18];
  if (fread(tail, 1, 18, f) != 18 || memcmp(tail + 8, "ECCNATIVE1", 10) != 0) { fclose(f); return FALSE; }
  unsigned long long blen = 0;
  for (int i = 0; i < 8; i++) blen |= (unsigned long long)tail[i] << (8 * i);
  wchar_t base[MAX_PATH];
  if (FAILED(SHGetFolderPathW(NULL, CSIDL_LOCAL_APPDATA, NULL, 0, base))) { fclose(f); return FALSE; }
  CreateDirectoryW(base, NULL);
  wchar_t dir[MAX_PATH];
  _snwprintf(dir, MAX_PATH - 1, L"%s\\EdgeControlCenter", base);
  CreateDirectoryW(dir, NULL);
  _snwprintf(g_enginePath, MAX_PATH - 1, L"%s\\ecc-engine.exe", dir);
  FILE *o = _wfopen(g_enginePath, L"wb");
  if (!o) { fclose(f); return FALSE; }
  char *chunk = (char *)malloc(1 << 20);
  unsigned long long left = blen;
  while (left) {
    unsigned long long want = left > (1 << 20) ? (1 << 20) : left;
    if (fread(chunk, 1, (size_t)want, f) != want) break;
    if (fwrite(chunk, 1, (size_t)want, o) != want) break;
    left -= want;
  }
  free(chunk);
  fclose(o); fclose(f);
  return left == 0;
}
static void StartEngine(void) {
  STARTUPINFOW si; PROCESS_INFORMATION pi;
  memset(&si, 0, sizeof si); si.cb = sizeof si;
  memset(&pi, 0, sizeof pi);
  wchar_t cmd[MAX_PATH + 4], cwd[MAX_PATH];
  _snwprintf(cmd, MAX_PATH + 3, L"\"%s\"", g_enginePath);
  lstrcpynW(cwd, g_enginePath, MAX_PATH);
  wchar_t *sl2 = wcsrchr(cwd, L'\\'); if (sl2) *sl2 = 0;
  if (!CreateProcessW(g_enginePath, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, cwd, &si, &pi)) {
    g_engineDead = TRUE;
    SetStatusW(L"✗ движок не запустился (антивирус? права?) — попробуй Start-ECC.cmd");
    return;
  }
  g_hEngine = pi.hProcess;
  CloseHandle(pi.hThread);
  SetStatusW(L"Движок запущен — ожидаю готовности…");
}
static DWORD WINAPI EngineBootThread(LPVOID) {
  SetStatusW(L"Распаковка движка (первый запуск)…");
  if (ExtractEngine()) StartEngine();
  else { g_engineDead = TRUE; SetStatusW(L"✗ встроенный движок не найден в EXE — файл повреждён?"); }
  g_extracting = FALSE;
  return 0;
}

/* ================================================================ poll */
static DWORD WINAPI PollThread(LPVOID) {
  int fails = 0, ticks = 0;
  for (;;) {
    int bl; char *b = HttpReq("GET", "/api/native/state", NULL, &bl);
    if (b) {
      EccState st; memset(&st, 0, sizeof st);
      st.tttCpu = st.tttGpu = -1; st.lod = 2; st.pl1 = 125; st.pl2 = 188;
      lstrcpynA(st.debounce, "0x500", 23);
      for (char *ln = strtok(b, "\n"); ln; ln = strtok(NULL, "\n")) {
        char *eq = strchr(ln, '='); if (!eq) continue;
        *eq = 0; const char *v = eq + 1;
        if      (!strcmp(ln, "cpu"))      st.cpu = atof(v);
        else if (!strcmp(ln, "cpuMhz"))   st.cpuMhz = atoi(v);
        else if (!strcmp(ln, "cores"))    st.cores = atoi(v);
        else if (!strcmp(ln, "memPct"))   st.memPct = atof(v);
        else if (!strcmp(ln, "swapGiB"))  st.swapGiB = atof(v);
        else if (!strcmp(ln, "wallW"))    st.wallW = atof(v);
        else if (!strcmp(ln, "effPct"))   st.effPct = atof(v);
        else if (!strcmp(ln, "loadPct"))  st.loadPct = atof(v);
        else if (!strcmp(ln, "sweet"))    st.sweet = atoi(v);
        else if (!strcmp(ln, "epsW"))     st.epsW = atof(v);
        else if (!strcmp(ln, "gpuW"))     st.gpuW = atof(v);
        else if (!strcmp(ln, "cpuTemp"))  st.cpuTemp = atof(v);
        else if (!strcmp(ln, "gpuTemp"))  st.gpuTemp = atof(v);
        else if (!strcmp(ln, "riskPct"))  st.riskPct = atof(v);
        else if (!strcmp(ln, "fanPwm"))   st.fanPwm = atof(v);
        else if (!strcmp(ln, "class"))    lstrcpynA(st.cls, v, 23);
        else if (!strcmp(ln, "tttCpu"))   st.tttCpu = atoi(v);
        else if (!strcmp(ln, "tttGpu"))   st.tttGpu = atoi(v);
        else if (!strcmp(ln, "rxKbps"))   st.rxKbps = atof(v);
        else if (!strcmp(ln, "txKbps"))   st.txKbps = atof(v);
        else if (!strcmp(ln, "debounce")) lstrcpynA(st.debounce, v, 23);
        else if (!strcmp(ln, "lod"))      st.lod = atoi(v);
        else if (!strcmp(ln, "dpi"))      lstrcpynA(st.dpi, v, 159);
        else if (!strcmp(ln, "unlocks"))  lstrcpynA(st.unlocks, v, 159);
        else if (!strcmp(ln, "pl1"))      st.pl1 = atoi(v);
        else if (!strcmp(ln, "pl2"))      st.pl2 = atoi(v);
        else if (!strcmp(ln, "version"))  lstrcpynA(st.version, v, 15);
      }
      EnterCriticalSection(&g_stCS);
      g_st = st;
      if (g_hn < 120) {
        g_hWall[g_hn] = (float)st.wallW; g_hCpu[g_hn] = (float)st.cpu;
        g_hTemp[g_hn] = (float)st.cpuTemp; g_hRisk[g_hn] = (float)st.riskPct;
        g_hn++;
      } else {
        memmove(g_hWall, g_hWall + 1, 119 * 4); memmove(g_hCpu, g_hCpu + 1, 119 * 4);
        memmove(g_hTemp, g_hTemp + 1, 119 * 4); memmove(g_hRisk, g_hRisk + 1, 119 * 4);
        g_hWall[119] = (float)st.wallW; g_hCpu[119] = (float)st.cpu;
        g_hTemp[119] = (float)st.cpuTemp; g_hRisk[119] = (float)st.riskPct;
      }
      LeaveCriticalSection(&g_stCS);
      free(b);
      fails = 0;
      if (!g_engineReady) { g_engineReady = TRUE; SetStatusW(L"✓ Готово — движок работает"); }
      PostMessageW(g_hWnd, WM_TICK, 0, 0);
    } else if (++fails == 5 && g_engineReady) {
      g_engineReady = FALSE; SetStatusW(L"Движок недоступен — переподключение…");
    }
    ticks++;
    Sleep(1000);
  }
  return 0;
}

/* ================================================================ actions */
static CRITICAL_SECTION g_actCS;
static HANDLE g_actSem;
static char g_actBody[8192];
static char g_actResult[16384];
static volatile LONG g_actBusy = 0;

static DWORD WINAPI ActThread(LPVOID) {
  for (;;) {
    WaitForSingleObject(g_actSem, INFINITE);
    char body[8192], res[16384];
    EnterCriticalSection(&g_actCS);
    lstrcpynA(body, g_actBody, 8191);
    LeaveCriticalSection(&g_actCS);
    int bl; char *b = HttpReq("POST", "/api/native/action", body, &bl);
    if (b) {
      int cp = bl > 16383 ? 16383 : bl;
      memcpy(res, b, cp); res[cp] = 0; free(b);
    } else lstrcpynA(res, "ok=0\nerror=нет соединения с движком", 16383);
    EnterCriticalSection(&g_actCS);
    lstrcpynA(g_actResult, res, 16383);
    g_actBusy = 0;
    LeaveCriticalSection(&g_actCS);
    PostMessageW(g_hWnd, WM_ACT, 0, 0);
  }
  return 0;
}
static void RunActionRaw(const char *body) {
  if (InterlockedCompareExchange(&g_actBusy, 1, 0) != 0) { MessageBeep(MB_ICONWARNING); return; }
  lstrcpynA(g_actBody, body, 8191);
  ReleaseSemaphore(g_actSem, 1, NULL);
}
static void RunActionLogin(const wchar_t *uu, const wchar_t *pp) {
  if (InterlockedCompareExchange(&g_actBusy, 1, 0) != 0) { MessageBeep(MB_ICONWARNING); return; }
  char u8[128], p8[128];
  WideCharToMultiByte(CP_UTF8, 0, uu, -1, u8, 127, NULL, NULL);
  WideCharToMultiByte(CP_UTF8, 0, pp, -1, p8, 127, NULL, NULL);
  _snprintf(g_actBody, 8191, "op=login\nuser=%s\npass=%s", u8, p8);
  ReleaseSemaphore(g_actSem, 1, NULL);
}
static BOOL ActValue(const char *key, char *out, int cap) {
  char snap[16384];
  EnterCriticalSection(&g_actCS);
  lstrcpynA(snap, g_actResult, 16383);
  LeaveCriticalSection(&g_actCS);
  int kl = (int)strlen(key);
  for (char *ln = strtok(snap, "\n"); ln; ln = strtok(NULL, "\n"))
    if (!strncmp(ln, key, kl) && ln[kl] == '=') { lstrcpynA(out, ln + kl + 1, cap); return TRUE; }
  return FALSE;
}

/* ================================================================ controls */
static void ClearCtrls(void) {
  for (int i = 0; i < g_nctrls; i++) DestroyWindow(g_ctrls[i]);
  g_nctrls = 0;
}
static void Reg(HWND h2) { if (g_nctrls < 40) g_ctrls[g_nctrls++] = h2; }
static void AddEdit(int id, int x, int y, int w, int h, const wchar_t *text, DWORD extra) {
  HWND e = CreateWindowW(L"EDIT", text, WS_CHILD | WS_VISIBLE | WS_TABSTOP | extra,
    CX0 + x, CY0 + y, w, h, g_hWnd, (HMENU)(INT_PTR)id, g_hInst, NULL);
  SendMessageW(e, WM_SETFONT, (WPARAM)g_fMono, TRUE);
  Reg(e);
}
static void AddBtn(int id, int x, int y, int w, int h, const wchar_t *text) {
  HWND b2 = CreateWindowW(L"BUTTON", text, WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW,
    CX0 + x, CY0 + y, w, h, g_hWnd, (HMENU)(INT_PTR)id, g_hInst, NULL);
  SendMessageW(b2, WM_SETFONT, (WPARAM)g_fBody, TRUE);
  Reg(b2);
}
static void AddLogBox(int x, int y, int w, int h) {
  HWND e = CreateWindowW(L"EDIT", g_log,
    WS_CHILD | WS_VISIBLE | WS_VSCROLL | ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL,
    CX0 + x, CY0 + y, w, h, g_hWnd, (HMENU)(INT_PTR)IDE_LOG, g_hInst, NULL);
  SendMessageW(e, WM_SETFONT, (WPARAM)g_fMono, TRUE);
  SendMessageW(e, EM_SETLIMITTEXT, 60000, 0);
  Reg(e);
}
static HWND g_hCombo = NULL;
static void AddCombo(int x, int y, int w, const wchar_t *items) {
  g_hCombo = CreateWindowW(L"COMBOBOX", NULL, WS_CHILD | WS_VISIBLE | CBS_DROPDOWNLIST | WS_TABSTOP,
    CX0 + x, CY0 + y, w, 220, g_hWnd, (HMENU)(INT_PTR)99, g_hInst, NULL);
  SendMessageW(g_hCombo, WM_SETFONT, (WPARAM)g_fBody, TRUE);
  const wchar_t *p = items;
  while (*p) { SendMessageW(g_hCombo, CB_ADDSTRING, 0, (LPARAM)p); p += lstrlenW(p) + 1; }
  SendMessageW(g_hCombo, CB_SETCURSEL, 0, 0);
  Reg(g_hCombo);
}

/* ================================================================ widgets init */
static void InitWidgetsForPage(void) {
  memset(g_tg, 0, sizeof g_tg);
  memset(g_sl, 0, sizeof g_sl);
  static const char *uids[5] = { "gun", "report", "lod", "angle", "sh" };
  static const wchar_t *tlabels[5] = { L"Gun-баллистика", L"Отчёт диагностики", L"LOD (lift-off)", L"Angle-snap", L"Шторка сенсора" };
  EccState st = SnapState();
  for (int i = 0; i < 5; i++) {
    g_tg[i].uid = uids[i]; g_tg[i].label = tlabels[i];
    g_tg[i].r.left = CWW - 240; g_tg[i].r.right = g_tg[i].r.left + 180;
    g_tg[i].r.top = 132 + i * 42; g_tg[i].r.bottom = g_tg[i].r.top + 24;
    char key[24]; _snprintf(key, 23, "%s:1", uids[i]);
    g_tg[i].on = strstr(st.unlocks, key) != NULL;
  }
  g_sl[0].min = 35; g_sl[0].max = 253; g_sl[0].val = st.pl1; g_sl[0].label = L"PL1, Вт (sustained)";
  g_sl[1].min = 35; g_sl[1].max = 253; g_sl[1].val = st.pl2; g_sl[1].label = L"PL2, Вт (boost)";
  g_sl[2].min = 20; g_sl[2].max = 45;  g_sl[2].val = g_dba;  g_sl[2].label = L"Акустика, dBA";
  for (int i = 0; i < 3; i++) {
    g_sl[i].r.left = 30; g_sl[i].r.right = 30 + 400;
    g_sl[i].r.top = 430 + i * 74; g_sl[i].r.bottom = g_sl[i].r.top + 26;
    g_sl[i].drag = FALSE;
  }
}

static void SwitchPage(int pg) {
  g_page = pg;
  ClearCtrls();
  g_hCombo = NULL;
  InitWidgetsForPage();
  switch (pg) {
  case PG_DEVICE:
    AddBtn(IDB_DPIAPPLY - 14, 30, 196, 130, 28, L"ЭКСПЕРТ: DPI ▸");     /* placeholder hidden below */
    ShowWindow(g_ctrls[g_nctrls - 1], SW_HIDE);
    for (int i = 0; i < 5; i++) {
      g_profR[i].left = 30 + i * 158; g_profR[i].top = 118;
      AddBtn(IDB_DPIAPPLY + 1 + i, g_profR[i].left, g_profR[i].top, 148, 28,
             i == 0 ? L"Esports" : i == 1 ? L"FPS" : i == 2 ? L"MMO" : i == 3 ? L"Creative" : L"Office");
    }
    AddEdit(IDE_DPI, 30, 196, 330, 26, L"", ES_AUTOHSCROLL);
    AddBtn(IDB_DPIAPPLY, 370, 196, 120, 28, L"Применить DPI");
    AddEdit(IDE_DEB, 30, 250, 110, 26, L"0x500", ES_AUTOHSCROLL);
    AddBtn(IDB_DEBAPPLY, 150, 250, 170, 28, L"Применить дебаунс");
    AddBtn(IDB_SNAP, 30, 306, 200, 30, L"⭳ Экспорт Cfg.ini");
    ShowWindow(g_ctrls[g_nctrls - 1], SW_HIDE);
    {
      /* reuse login-free export button via rect on a real button id */
      AddBtn(IDB_AUDIT, 30, 306, 200, 30, L"⭳ Экспорт Cfg.ini");
      ShowWindow(g_ctrls[g_nctrls - 1], SW_HIDE);
    }
    AddLogBox(30, 400, CWW - 60, CHH - 420);
    break;
  case PG_POWER:
    AddBtn(IDB_PLAPPLY, 30, 660, 230, 32, L"Применить лимиты (guarded)");
    AddLogBox(30, 250, 520, CHH - 280);
    break;
  case PG_THERMAL:
    AddCombo(30, 620, 220, L"Adaptive (ИИ)\0Acoustic (по dBA)\0Manual (кривая)\0");
    AddBtn(IDB_THAPPLY, 270, 620, 200, 30, L"Применить политику");
    AddLogBox(520, 250, CWW - 550, CHH - 280);
    break;
  case PG_NETWORK:
    AddEdit(IDE_PINGHOST, 30, 88, 240, 26, L"1.1.1.1", ES_AUTOHSCROLL);
    AddBtn(IDB_PING, 280, 88, 110, 28, L"Ping");
    AddBtn(IDB_DNS, 398, 88, 130, 28, L"DNS-гонка");
    AddLogBox(30, 136, CWW - 60, CHH - 156);
    break;
  case PG_STABILITY:
    AddEdit(IDE_STAB, 30, 88, 520, 26, L"0x124", ES_AUTOHSCROLL);
    AddBtn(IDB_ANALYZE, 560, 88, 130, 28, L"Анализ");
    AddLogBox(30, 136, CWW - 60, CHH - 156);
    break;
  case PG_AI:
    AddEdit(IDE_AIPROMPT, 30, 88, CWW - 60, 56, L"ember nebula over a matte black gaming rig, volumetric light", ES_MULTILINE | ES_WANTRETURN);
    AddEdit(IDE_AISTEPS, 30, 164, 76, 26, L"28", ES_NUMBER);
    AddBtn(IDB_AIGEN, 120, 164, 210, 28, L"✦ Сгенерировать (локально)");
    AddLogBox(30, 212, CWW - 60, CHH - 232);
    break;
  case PG_ADMIN:
    AddEdit(IDE_AU, 30, 88, 190, 26, g_user, ES_AUTOHSCROLL);
    AddEdit(IDE_AP, 250, 88, 190, 26, L"", ES_PASSWORD | ES_AUTOHSCROLL);
    AddBtn(IDB_LOGIN, 450, 88, 120, 28, L"Войти");
    AddBtn(IDB_SNAP, 30, 134, 180, 28, L"◆ Restore-якорь");
    AddBtn(IDB_AUDIT, 220, 134, 160, 28, L"Аудит-журнал");
    AddLogBox(30, 182, CWW - 60, CHH - 202);
    break;
  }
  RECT r; GetClientRect(g_hWnd, &r);
  r.left = RAIL_W; r.top = HEADER_H;
  InvalidateRect(g_hWnd, &r, TRUE);
}

/* ================================================================ drawing */
static void FillR(HDC dc, int x, int y, int w, int h, COLORREF c) {
  RECT r = { x, y, x + w, y + h };
  HBRUSH b = CreateSolidBrush(c); FillRect(dc, &r, b); DeleteObject(b);
}
static void TextOutF(HDC dc, int x, int y, const wchar_t *s, COLORREF c, HFONT f) {
  SetBkMode(dc, TRANSPARENT); SetTextColor(dc, c); SelectObject(dc, f);
  TextOutW(dc, x, y, s, lstrlenW(s));
}
static void DrawBar(HDC dc, int x, int y, int w, int h, double frac, COLORREF c) {
  FillR(dc, x, y, w, h, C_PANEL2);
  int fw = (int)(w * frac);
  if (fw > 0) FillR(dc, x, y, fw, h, c);
}
static void DrawSpark(HDC dc, RECT r, const float *hist, int n, COLORREF c, float maxv) {
  FillR(dc, r.left, r.top, r.right - r.left, r.bottom - r.top, C_PANEL);
  HBRUSH lb = CreateSolidBrush(C_LINE); FrameRect(dc, &r, lb); DeleteObject(lb);
  if (n < 2) return;
  int w = r.right - r.left - 6, h = r.bottom - r.top - 8;
  if (maxv <= 0) { maxv = 1; for (int i = 0; i < n; i++) if (hist[i] > maxv) maxv = hist[i]; maxv *= 1.15f; }
  POINT pts[120];
  int cnt = n < 120 ? n : 120;
  for (int i = 0; i < cnt; i++) {
    pts[i].x = r.left + 3 + i * w / 119;
    pts[i].y = r.bottom - 4 - (int)((hist[i] / maxv) * (h - 4));
    if (pts[i].y < r.top + 2) pts[i].y = r.top + 2;
    if (pts[i].y > r.bottom - 3) pts[i].y = r.bottom - 3;
  }
  HPEN pen = CreatePen(PS_SOLID, 2, c), op = (HPEN)SelectObject(dc, pen);
  Polyline(dc, pts, cnt);
  SelectObject(dc, op); DeleteObject(pen);
}
static void DrawGauge(HDC dc, int cx, int cy, int rad, double pct, const wchar_t *val, const wchar_t *cap, COLORREF c) {
  if (pct > 100) pct = 100; if (pct < 0) pct = 0;
  HBRUSH nobrush = (HBRUSH)SelectObject(dc, GetStockObject(NULL_BRUSH));
  HPEN pbg = CreatePen(PS_SOLID, 9, C_PANEL2), op = (HPEN)SelectObject(dc, pbg);
  SetArcDirection(dc, AD_COUNTERCLOCKWISE);
  Arc(dc, cx - rad, cy - rad, cx + rad, cy + rad, cx + rad, cy, cx + rad, cy);
  HPEN pfg = CreatePen(PS_SOLID, 9, c);
  SelectObject(dc, pfg);
  SetArcDirection(dc, AD_CLOCKWISE);
  double phi = pct * 3.6 * 3.14159265 / 180.0;
  int ex = cx + (int)(rad * sin(phi)), ey = cy - (int)(rad * cos(phi));
  if (pct >= 99.9) { ex = cx - 1; ey = cy - rad; }
  Arc(dc, cx - rad, cy - rad, cx + rad, cy + rad, cx + rad, cy, ex, ey);
  SelectObject(dc, op); DeleteObject(pbg); DeleteObject(pfg);
  SelectObject(dc, nobrush);
  SetBkMode(dc, TRANSPARENT);
  SetTextColor(dc, C_TEXT); SelectObject(dc, g_fH2);
  RECT rv = { cx - rad, cy - 24, cx + rad, cy + 4 };
  DrawTextW(dc, val, -1, &rv, DT_CENTER | DT_SINGLELINE);
  SetTextColor(dc, C_MUT); SelectObject(dc, g_fSmall);
  RECT rc2 = { cx - rad, cy + 6, cx + rad, cy + 26 };
  DrawTextW(dc, cap, -1, &rc2, DT_CENTER | DT_SINGLELINE);
}
static void DrawCard(HDC dc, int x, int y, int w, int h, const wchar_t *title) {
  RECT r = { x, y, x + w, y + h };
  HBRUSH b = CreateSolidBrush(C_PANEL); FillRect(dc, &r, b); DeleteObject(b);
  HBRUSH lb = CreateSolidBrush(C_LINE); FrameRect(dc, &r, lb); DeleteObject(lb);
  if (title && *title) TextOutF(dc, x + 12, y + 8, title, C_MUT, g_fSmall);
}
static void DrawSlider(HDC dc, Slider *s) {
  TextOutF(dc, s->r.left, s->r.top - 24, s->label, C_MUT, g_fSmall);
  wchar_t vv[16]; _snwprintf(vv, 15, L"%d", s->val);
  TextOutF(dc, s->r.right - 46, s->r.top - 24, vv, C_ACC2, g_fSmall);
  int ty = (s->r.top + s->r.bottom) / 2;
  FillR(dc, s->r.left, ty - 4, s->r.right - s->r.left, 8, C_PANEL2);
  double f = (double)(s->val - s->min) / (s->max - s->min);
  FillR(dc, s->r.left, ty - 4, (int)((s->r.right - s->r.left) * f), 8, C_ACC);
  int kx = s->r.left + (int)((s->r.right - s->r.left) * f) - 8;
  RECT k = { kx, ty - 10, kx + 16, ty + 10 };
  HBRUSH b = CreateSolidBrush(RGB(240, 242, 248)); FillRect(dc, &k, b); DeleteObject(b);
}
static void DrawToggle(HDC dc, Toggle *t) {
  RECT sw = { t->r.left, t->r.top, t->r.left + 44, t->r.top + 22 };
  FillR(dc, sw.left, sw.top, 44, 22, t->on ? C_ACC : C_PANEL2);
  RECT k = t->on ? (RECT){ sw.left + 24, sw.top + 3, sw.left + 41, sw.top + 19 }
                 : (RECT){ sw.left + 3,  sw.top + 3, sw.left + 20, sw.top + 19 };
  HBRUSH b = CreateSolidBrush(RGB(245, 246, 250)); FillRect(dc, &k, b); DeleteObject(b);
  TextOutF(dc, sw.right + 12, t->r.top + 2, t->label, t->on ? C_TEXT : C_MUT, g_fBody);
}

/* ================================================================ paint */
static void PaintContent(HDC dc) {
  EccState st = SnapState();
  wchar_t b[512];
  if (!g_engineReady) {
    DrawCard(dc, 30, 40, CWW - 60, 230, NULL);
    TextOutF(dc, 60, 84, g_extracting ? L"Распаковка движка (первый запуск, ~2 c)…" :
             g_engineDead ? L"✗ Движок не смог запуститься — см. статус внизу" : L"Запуск движка…",
             g_engineDead ? C_BAD : C_TEXT, g_fH2);
    TextOutF(dc, 60, 128, L"Это нативное приложение: весь интерфейс отрисован через Win32/GDI, без браузера.", C_MUT, g_fBody);
    TextOutF(dc, 60, 152, L"Движок — встроенный в EXE сервер телеметрии: невидим, стартует автоматически.", C_MUT, g_fBody);
    TextOutF(dc, 60, 196, L"Статус виден в строке внизу окна.", C_MUT, g_fSmall);
    return;
  }
  switch (g_page) {
  case PG_OVERVIEW: {
    TextOutF(dc, 30, 4, L"Обзор платформы", C_TEXT, g_fH1);
    int cy = 46;
    DrawCard(dc, 30, cy, 260, 150, L"СЕТЬ · СТЕНА");
    _snwprintf(b, 255, L"%.0f W", st.wallW);
    TextOutF(dc, 50, cy + 32, b, C_TEXT, g_fBig);
    _snwprintf(b, 255, L"η %.1f%% · БП %.0f%% %s", st.effPct, st.loadPct, st.sweet ? L"◆ оптимум" : L"");
    TextOutF(dc, 50, cy + 80, b, st.sweet ? C_OK : C_MUT, g_fSmall);
    DrawBar(dc, 50, cy + 106, 220, 8, st.loadPct / 100.0, st.sweet ? C_OK : C_ACC);
    DrawCard(dc, 310, cy, 260, 150, L"ПРОЦЕССОР");
    _snwprintf(b, 255, L"%.0f%%", st.cpu);
    TextOutF(dc, 330, cy + 32, b, C_TEXT, g_fBig);
    _snwprintf(b, 255, L"%d МГц · %d ядер · %.1f°C", st.cpuMhz, st.cores, st.cpuTemp);
    TextOutF(dc, 330, cy + 80, b, C_MUT, g_fSmall);
    DrawBar(dc, 330, cy + 106, 220, 8, st.cpu / 100.0, C_ACC2);
    DrawCard(dc, 590, cy, 260, 150, L"ПАМЯТЬ · 16 ГБ");
    _snwprintf(b, 255, L"%.0f%%", st.memPct);
    TextOutF(dc, 610, cy + 32, b, C_TEXT, g_fBig);
    _snwprintf(b, 255, L"swap %.2f GiB", st.swapGiB);
    TextOutF(dc, 610, cy + 80, b, C_MUT, g_fSmall);
    DrawBar(dc, 610, cy + 106, 220, 8, st.memPct / 100.0, C_INFO);
    DrawCard(dc, 870, cy, 260, 150, L"ТЕРМО-РИСК");
    _snwprintf(b, 255, L"%.0f%%", st.riskPct);
    TextOutF(dc, 890, cy + 32, b, st.riskPct > 60 ? C_BAD : st.riskPct > 30 ? C_ACC2 : C_OK, g_fBig);
    _snwprintf(b, 255, L"CPU %.1f° · GPU %.1f° · fan %.0f%%", st.cpuTemp, st.gpuTemp, st.fanPwm);
    TextOutF(dc, 890, cy + 80, b, C_MUT, g_fSmall);
    DrawBar(dc, 890, cy + 106, 220, 8, st.riskPct / 100.0, st.riskPct > 60 ? C_BAD : C_OK);
    int cy2 = cy + 168;
    DrawCard(dc, 30, cy2, 545, 200, L"СТЕНА, Вт — история");
    RECT r1 = { 42 + CX0 - 16, cy2 + 28, 563 + CX0 - 16, cy2 + 190 };
    DrawSpark(dc, r1, g_hWall, g_hn, C_ACC, 0);
    DrawCard(dc, 595, cy2, 545, 200, L"CPU, °C — история");
    RECT r2 = { 607 + CX0 - 16, cy2 + 28, 1128 + CX0 - 16, cy2 + 190 };
    DrawSpark(dc, r2, g_hTemp, g_hn, C_ACC2, 100);
    int cy3 = cy2 + 216;
    DrawCard(dc, 30, cy3, CWW - 60, 110, L"УСТРОЙСТВО ARDOR EDGE 3327");
    wchar_t dpib[160];
    { char a[160]; lstrcpynA(a, st.dpi, 159); MultiByteToWideChar(CP_UTF8, 0, a, -1, dpib, 159); }
    TextOutF(dc, 50, cy3 + 34, L"DPI:", C_MUT, g_fSmall);
    TextOutF(dc, 100, cy3 + 32, dpib, C_TEXT, g_fBody);
    wchar_t debw[32];
    { MultiByteToWideChar(CP_UTF8, 0, st.debounce, -1, debw, 31); }
    TextOutF(dc, 50, cy3 + 62, L"Дебаунс:", C_MUT, g_fSmall);
    TextOutF(dc, 130, cy3 + 60, debw, C_TEXT, g_fBody);
    _snwprintf(b, 511, L"LOD: %s · класс: %hs · сеть %.0f/%.0f КБ/с",
               st.lod == 0 ? L"низкий" : st.lod == 1 ? L"средний" : L"высокий", st.cls, st.rxKbps, st.txKbps);
    TextOutF(dc, 340, cy3 + 60, b, C_MUT, g_fBody);
    break;
  }
  case PG_DEVICE: {
    TextOutF(dc, 30, 4, L"Мышь ARDOR GAMING Edge 3327 — скрытые модули и редактор", C_TEXT, g_fH1);
    TextOutF(dc, 30, 104, L"Скрытые модули стокового бинарника (переключение — сразу в конфиг):", C_MUT, g_fBody);
    for (int i = 0; i < 5; i++) DrawToggle(dc, &g_tg[i]);
    TextOutF(dc, 30, 226, L"Профили:", C_MUT, g_fSmall);
    TextOutF(dc, 30, 300, L"DPI-ступени (через запятую, 200…12400):", C_MUT, g_fSmall);
    TextOutF(dc, 30, 354, L"Дебаунс DR (напр. 0x300):", C_MUT, g_fSmall);
    TextOutF(dc, 30, 408, L"LOD (lift-off distance):", C_MUT, g_fSmall);
    for (int i = 0; i < 3; i++) {
      g_lodR[i].left = 180 + i * 112; g_lodR[i].top = 404;
      g_lodR[i].right = g_lodR[i].left + 104; g_lodR[i].bottom = g_lodR[i].top + 26;
      BOOL on = st.lod == i;
      FillR(dc, g_lodR[i].left, g_lodR[i].top, 104, 26, on ? C_ACC : C_PANEL2);
      TextOutF(dc, g_lodR[i].left + 16, g_lodR[i].top + 4,
               i == 0 ? L"низкий" : i == 1 ? L"средний" : L"высокий", on ? RGB(255, 244, 240) : C_MUT, g_fSmall);
    }
    break;
  }
  case PG_POWER: {
    TextOutF(dc, 30, 4, L"Питание — БП 750 Вт · 80 PLUS Gold", C_TEXT, g_fH1);
    static wchar_t wv[32], ev[32];
    _snwprintf(wv, 31, L"%.0f W", st.wallW);
    _snwprintf(ev, 31, L"%.1f%%", st.effPct);
    DrawGauge(dc, CX0 + 130, CY0 + 210, 92, st.loadPct, wv, L"СТЕНА / 750 ВТ", C_ACC);
    DrawGauge(dc, CX0 + 370, CY0 + 210, 92, st.effPct, ev, L"КПД", st.sweet ? C_OK : C_ACC2);
    DrawCard(dc, CX0 + 540, CY0 + 100, 620, 220, L"РЕЙКИ И БЮДЖЕТ");
    _snwprintf(b, 511, L"EPS 12V (CPU)      %.1f W", st.epsW);
    TextOutF(dc, CX0 + 560, CY0 + 140, b, C_TEXT, g_fMono);
    _snwprintf(b, 511, L"PCIe 12V (GPU)     %.1f W", st.gpuW);
    TextOutF(dc, CX0 + 560, CY0 + 168, b, C_TEXT, g_fMono);
    TextOutF(dc, CX0 + 560, CY0 + 196, L"Периферия 5V/3.3V  ~28 W", C_TEXT, g_fMono);
    _snwprintf(b, 511, L"Итого DC ≈ %.1f W · у стены ≈ %.1f W (η %.1f%%)", st.epsW + st.gpuW + 28, st.wallW, st.effPct);
    TextOutF(dc, CX0 + 560, CY0 + 232, b, C_MUT, g_fBody);
    _snwprintf(b, 511, L"Позиция КПД: %s", st.sweet ? L"◆ окно 40–60% — оптимум" : L"вне оптимума 40–60%");
    TextOutF(dc, CX0 + 560, CY0 + 262, b, st.sweet ? C_OK : C_ACC2, g_fBody);
    TextOutF(dc, 30, 350, L"Динамические лимиты (защита: PL2 ≤ 1.5×PL1):", C_MUT, g_fBody);
    break;
  }
  case PG_THERMAL: {
    TextOutF(dc, 30, 4, L"Предиктивная термалка", C_TEXT, g_fH1);
    _snwprintf(b, 511, L"CPU %.1f °C · GPU %.1f °C · класс: %hs · вентилятор %.0f%%",
               st.cpuTemp, st.gpuTemp, st.cls, st.fanPwm);
    TextOutF(dc, 30, 42, b, C_MUT, g_fBody);
    DrawCard(dc, 30, 76, CWW - 60, 230, L"ТЕМПЕРАТУРА CPU, °C — ИСТОРИЯ");
    RECT r1 = { 42, 104, CWW - 72, 296 };
    DrawSpark(dc, r1, g_hTemp, g_hn, C_ACC2, 100);
    TextOutF(dc, 30, 322, L"Риск троттлинга:", C_MUT, g_fBody);
    DrawBar(dc, 180, 322, 380, 14, st.riskPct / 100.0, st.riskPct > 60 ? C_BAD : st.riskPct > 30 ? C_ACC2 : C_OK);
    _snwprintf(b, 255, L"%.0f%%", st.riskPct);
    TextOutF(dc, 572, 318, b, C_TEXT, g_fBody);
    _snwprintf(b, 511, L"TTC CPU: %s · TTC GPU: %s",
               st.tttCpu < 0 ? L"стабильно" : L"риск!", st.tttGpu < 0 ? L"стабильно" : L"риск!");
    TextOutF(dc, 640, 320, b, C_MUT, g_fSmall);
    TextOutF(dc, 30, 580, L"Режим контроллера:", C_MUT, g_fBody);
    break;
  }
  case PG_NETWORK:
    TextOutF(dc, 30, 4, L"Сеть — диагностика", C_TEXT, g_fH1);
    _snwprintf(b, 511, L"трафик: %.1f КБ/с ↓ · %.1f КБ/с ↑", st.rxKbps, st.txKbps);
    TextOutF(dc, 620, 92, b, C_MUT, g_fBody);
    break;
  case PG_STABILITY:
    TextOutF(dc, 30, 4, L"Стабильность — анализ сбоев", C_TEXT, g_fH1);
    TextOutF(dc, 30, 56, L"Stop-код / текст BSOD (например 0x124):", C_MUT, g_fSmall);
    break;
  case PG_AI:
    TextOutF(dc, 30, 4, L"ИИ-студия — локальная генерация (без облака)", C_TEXT, g_fH1);
    TextOutF(dc, 30, 56, L"Промпт:", C_MUT, g_fSmall);
    TextOutF(dc, 30, 168, L"Шаги:", C_MUT, g_fSmall);
    _snwprintf(b, 511, L"Задача: %s · статус: %s", g_jobId, g_jobStatus);
    TextOutF(dc, 350, 168, b, C_MUT, g_fBody);
    TextOutF(dc, 30, 640, L"Галерея — кнопка «Веб-панель» в шапке. Генерация и очередь — здесь.", C_MUT, g_fSmall);
    break;
  case PG_ADMIN:
    TextOutF(dc, 30, 4, L"Администратор", C_TEXT, g_fH1);
    TextOutF(dc, 30, 92, L"Логин:", C_MUT, g_fSmall);
    TextOutF(dc, 250, 92, L"Пароль:", C_MUT, g_fSmall);
    TextOutF(dc, 600, 92, g_token[0] ? L"● сессия активна" : L"○ вход не выполнен", g_token[0] ? C_OK : C_MUT, g_fBody);
    break;
  }
  if (g_page == PG_POWER) { DrawSlider(dc, &g_sl[0]); DrawSlider(dc, &g_sl[1]); }
  if (g_page == PG_THERMAL) DrawSlider(dc, &g_sl[2]);
}
static void PaintRail(HDC dc) {
  FillR(dc, 0, 0, RAIL_W, CH, C_PANEL);
  FillR(dc, RAIL_W - 2, 0, 2, CH, C_LINE);
  RECT mk = { 16, 12, 52, 48 };
  HBRUSH mb = CreateSolidBrush(C_ACC), ob = (HBRUSH)SelectObject(dc, mb);
  HPEN np = CreatePen(PS_NULL, 0, 0), op = (HPEN)SelectObject(dc, np);
  RoundRect(dc, mk.left, mk.top, mk.right, mk.bottom, 10, 10);
  SelectObject(dc, ob); SelectObject(dc, op);
  DeleteObject(np); DeleteObject(mb);
  SetBkMode(dc, TRANSPARENT);
  SetTextColor(dc, RGB(26, 10, 6)); SelectObject(dc, g_fMark);
  DrawTextW(dc, L"E", -1, &mk, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
  TextOutF(dc, 60, 14, L"EDGE", C_TEXT, g_fH2);
  TextOutF(dc, 60, 34, L"Control Center", C_MUT, g_fSmall);
  for (int i = 0; i < PG_COUNT; i++) {
    g_railR[i].left = 8; g_railR[i].right = RAIL_W - 8;
    g_railR[i].top = 62 + i * 46; g_railR[i].bottom = g_railR[i].top + 40;
    BOOL act = g_page == i;
    if (act) {
      RECT rr = g_railR[i];
      HBRUSH b2 = CreateSolidBrush(C_PANEL2); FillRect(dc, &rr, b2); DeleteObject(b2);
      FillR(dc, g_railR[i].left, g_railR[i].top, 3, 40, C_ACC);
    }
    RECT ik = { g_railR[i].left + 8, g_railR[i].top + 8, g_railR[i].left + 34, g_railR[i].top + 32 };
    HBRUSH ib = CreateSolidBrush(act ? C_ACC : C_PANEL2); FillRect(dc, &ik, ib); DeleteObject(ib);
    SetTextColor(dc, act ? RGB(28, 11, 6) : C_MUT); SelectObject(dc, g_fSmall);
    DrawTextW(dc, PAGEICONS[i], -1, &ik, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    TextOutF(dc, g_railR[i].left + 44, g_railR[i].top + 10, PAGENAMES[i], act ? C_TEXT : C_MUT, g_fRail);
  }
  TextOutF(dc, 14, CH - 170, L"v2.1.0 «NATIVE»", C_MUT, g_fSmall);
  TextOutF(dc, 14, CH - 150, L"нативный UI · Win32/GDI", C_MUT, g_fSmall);
  TextOutF(dc, 14, CH - 108, L"hasberd · ARDOR GAMING", C_MUT, g_fSmall);
  TextOutF(dc, 14, CH - 92, L"Edge 3327 suite", C_MUT, g_fSmall);
}
static void PaintHeader(HDC dc) {
  FillR(dc, RAIL_W, 0, CW - RAIL_W, HEADER_H, C_PANEL);
  FillR(dc, RAIL_W, HEADER_H - 2, CW - RAIL_W, 2, C_LINE);
  RECT s1 = { RAIL_W, 0, RAIL_W + 180, 3 }; HBRUSH b1 = CreateSolidBrush(C_ACC); FillRect(dc, &s1, b1); DeleteObject(b1);
  RECT s2 = { RAIL_W + 180, 0, CW, 3 }; HBRUSH b2 = CreateSolidBrush(C_ACC2); FillRect(dc, &s2, b2); DeleteObject(b2);
  SetBkMode(dc, TRANSPARENT);
  TextOutF(dc, RAIL_W + 16, 12, L"ARDOR GAMING Edge 3327 — платформенный контроль", C_TEXT, g_fH2);
  TextOutF(dc, RAIL_W + 16, 34, L"750 Вт · 16 ГБ · GPT/UEFI · Windows+Linux", C_MUT, g_fSmall);
  g_webBtnR.left = CW - 156; g_webBtnR.top = 14; g_webBtnR.right = CW - 20; g_webBtnR.bottom = 42;
  FillR(dc, g_webBtnR.left, g_webBtnR.top, 136, 28, C_PANEL2);
  HBRUSH lb = CreateSolidBrush(C_LINE); FrameRect(dc, &g_webBtnR, lb); DeleteObject(lb);
  TextOutF(dc, g_webBtnR.left + 14, g_webBtnR.top + 5, L"🌐 Веб-панель", C_TEXT, g_fSmall);
}
static void PaintStatusBar(HDC dc) {
  FillR(dc, 0, CH - STATUS_H, CW, STATUS_H, C_PANEL);
  FillR(dc, 0, CH - STATUS_H, CW, 1, C_LINE);
  COLORREF cc = g_engineDead ? C_BAD : g_engineReady ? C_OK : C_ACC2;
  FillR(dc, 12, CH - STATUS_H / 2 - 3, 8, 8, cc);
  TextOutF(dc, 28, CH - STATUS_H + 5, g_status, C_MUT, g_fSmall);
  TextOutF(dc, CW - 300, CH - STATUS_H + 5, L"движок: 127.0.0.1:3327 · скрытый процесс", C_MUT, g_fSmall);
}

/* ================================================================ interactions */
static void TokenA(char *tok, int cap) { WideCharToMultiByte(CP_UTF8, 0, g_token, -1, tok, cap - 1, NULL, NULL); }
static void ApplyDpiFromEdit(void) {
  wchar_t v[200]; GetDlgItemTextW(g_hWnd, IDE_DPI, v, 199);
  char tok[96], dv[400];
  TokenA(tok, 95);
  WideCharToMultiByte(CP_UTF8, 0, v, -1, dv, 399, NULL, NULL);
  char body[600]; _snprintf(body, 599, "op=key\nsection=SENSOR_1\nkey=DPI\nvalue=%s\ntoken=%s", dv, tok);
  RunActionRaw(body);
}
static void HitTestCustom(int x, int y) {
  POINT pt = { x, y };
  if (PtInRect(&g_webBtnR, pt)) {
    wchar_t url[64]; _snwprintf(url, 63, L"http://127.0.0.1:%d/", g_port);
    ShellExecuteW(g_hWnd, L"open", url, NULL, NULL, SW_SHOWNORMAL);
    return;
  }
  for (int i = 0; i < PG_COUNT; i++)
    if (PtInRect(&g_railR[i], pt)) { if (g_page != i) SwitchPage(i); return; }
  if (!g_engineReady) return;
  if (g_page == PG_DEVICE) {
    char tok[96]; TokenA(tok, 95);
    for (int i = 0; i < 5; i++) {
      RECT zone = { g_tg[i].r.left - 260, g_tg[i].r.top - 6, g_tg[i].r.right + 12, g_tg[i].r.bottom + 6 };
      if (PtInRect(&zone, pt)) {
        g_tg[i].on = !g_tg[i].on;
        char body[192];
        _snprintf(body, 191, "op=unlock\nid=%s\non=%d\ntoken=%s", g_tg[i].uid, g_tg[i].on ? 1 : 0, tok);
        RunActionRaw(body);
        InvalidateRect(g_hWnd, NULL, FALSE);
        return;
      }
    }
    for (int i = 0; i < 3; i++)
      if (PtInRect(&g_lodR[i], pt)) {
        char body[160]; _snprintf(body, 159, "op=key\nsection=OPT\nkey=DefLOD\nvalue=%d\ntoken=%s", i, tok);
        RunActionRaw(body);
        return;
      }
    RECT r;
    for (int i = 0; i < 5; i++) {
      r.left = CX0 + g_profR[i].left; r.top = CY0 + g_profR[i].top;
      r.right = r.left + 148; r.bottom = r.top + 28;
      if (PtInRect(&r, pt)) {
        static const char *pids[5] = { "esports", "fps", "mmo", "creative", "silent" };
        char body[128]; _snprintf(body, 127, "op=profile\nid=%s\ntoken=%s", pids[i], tok);
        RunActionRaw(body);
        Log(L"Профиль отправлен");
        return;
      }
    }
    r.left = CX0 + 370; r.top = CY0 + 196; r.right = r.left + 120; r.bottom = r.top + 28;
    if (PtInRect(&r, pt)) { ApplyDpiFromEdit(); return; }
    r.left = CX0 + 150; r.top = CY0 + 250; r.right = r.left + 170; r.bottom = r.top + 28;
    if (PtInRect(&r, pt)) {
      wchar_t v[32]; GetDlgItemTextW(g_hWnd, IDE_DEB, v, 31);
      char vb[32]; WideCharToMultiByte(CP_UTF8, 0, v, -1, vb, 31, NULL, NULL);
      char body[192]; _snprintf(body, 191, "op=key\nsection=SENSOR_1\nkey=DR\nvalue=%s\ntoken=%s", vb, tok);
      RunActionRaw(body);
      return;
    }
  }
  if (g_page == PG_POWER) {
    RECT r = { CX0 + 30, CY0 + 660, CX0 + 260, CY0 + 692 };
    if (PtInRect(&r, pt)) {
      char tok2[96]; TokenA(tok2, 95);
      char body[160]; _snprintf(body, 159, "op=pl\npl1=%d\npl2=%d\ntoken=%s", g_sl[0].val, g_sl[1].val, tok2);
      RunActionRaw(body);
      return;
    }
  }
  if (g_page == PG_THERMAL) {
    RECT r = { CX0 + 270, CY0 + 620, CX0 + 470, CY0 + 650 };
    if (PtInRect(&r, pt)) {
      char tok2[96]; TokenA(tok2, 95);
      int idx = g_hCombo ? (int)SendMessageW(g_hCombo, CB_GETCURSEL, 0, 0) : 0;
      if (idx < 0) idx = 0;
      const char *modes[3] = { "adaptive", "acoustic", "manual" };
      char body[192];
      _snprintf(body, 191, "op=thermal\nmode=%s\ndba=%d\ntoken=%s", modes[idx], g_sl[2].val, tok2);
      RunActionRaw(body);
      return;
    }
  }
}

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
  case WM_CREATE: {
    g_hWnd = h;
    InitializeCriticalSection(&g_stCS);
    InitializeCriticalSection(&g_actCS);
    g_actSem = CreateSemaphoreW(NULL, 0, 1, NULL);
    CreateThread(NULL, 0, PollThread, NULL, 0, NULL);
    CreateThread(NULL, 0, ActThread, NULL, 0, NULL);
    CreateThread(NULL, 0, EngineBootThread, NULL, 0, NULL);
    memset(&g_nid, 0, sizeof g_nid);
    g_nid.cbSize = sizeof g_nid; g_nid.hWnd = h; g_nid.uID = 1;
    g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    g_nid.uCallbackMessage = WM_TRAY; g_nid.hIcon = g_hIcon;
    lstrcpynW(g_nid.szTip, L"Edge Control Center — NATIVE v2.1.0", 128);
    Shell_NotifyIconW(NIM_ADD, &g_nid);
    SetTimer(h, 1, 1000, NULL);
    return 0;
  }
  case WM_TIMER:
    if (g_hEngine && !g_engineDead && WaitForSingleObject(g_hEngine, 0) == WAIT_OBJECT_0) {
      g_engineDead = TRUE; g_engineReady = FALSE;
      SetStatusW(L"✗ движок завершился — запусти приложение заново");
      InvalidateRect(h, NULL, TRUE);
    }
    return 0;
  case WM_TICK:
    InvalidateRect(h, NULL, FALSE);
    return 0;
  case WM_ACT: {
    char tmp[1024], okv[8];
    BOOL ok = ActValue("ok", okv, 8) && !strcmp(okv, "1");
    if (!ok) {
      char err[256];
      if (ActValue("error", err, 255)) {
        wchar_t we[300]; MultiByteToWideChar(CP_UTF8, 0, err, -1, we, 299);
        Log(L"✗ %s", we);
      }
    } else {
      if (ActValue("token", tmp, 95)) {
        wchar_t wt[100]; MultiByteToWideChar(CP_UTF8, 0, tmp, -1, wt, 99);
        lstrcpynW(g_token, wt, 95);
        char rot[8]; ActValue("mustRotate", rot, 7);
        Log(L"Вход выполнен (%s)%s", g_user, !strcmp(rot, "1") ? L" — СМЕНИ пароль по умолчанию!" : L"");
      }
      if (ActValue("unlocks", tmp, 200)) {
        for (int i = 0; i < 5; i++) {
          char key[24]; _snprintf(key, 23, "%s:1", g_tg[i].uid);
          g_tg[i].on = strstr(tmp, key) != NULL;
        }
        Log(L"Unlock применён");
      }
      if (ActValue("file", tmp, 250)) { wchar_t wf[300]; MultiByteToWideChar(CP_UTF8, 0, tmp, -1, wf, 299); Log(L"Экспорт: %s", wf); }
      if (ActValue("avg", tmp, 60)) {
        char loss[32], jit[32];
        ActValue("loss", loss, 31); ActValue("jitter", jit, 31);
        Log(L"Ping: avg %s ms · loss %s%% · jitter %s ms", tmp, loss, jit);
      }
      if (ActValue("rows", tmp, 800)) {
        wchar_t wr[900]; MultiByteToWideChar(CP_UTF8, 0, tmp, -1, wr, 899);
        for (int i = 0; wr[i]; i++) if (wr[i] == L'|') wr[i] = L'\n';
        for (int i = 0; wr[i]; i++) if (wr[i] == L'=') wr[i] = L' ';
        Log(L"DNS-гонка:\r\n%s", wr);
      }
      if (ActValue("name", tmp, 200)) {
        char code[32], causes[600], actions[600];
        ActValue("code", code, 31); ActValue("causes", causes, 599); ActValue("actions", actions, 599);
        wchar_t wn[240], wc[700], wa[700], wcd[32];
        MultiByteToWideChar(CP_UTF8, 0, tmp, -1, wn, 239);
        MultiByteToWideChar(CP_UTF8, 0, causes, -1, wc, 699);
        MultiByteToWideChar(CP_UTF8, 0, actions, -1, wa, 699);
        MultiByteToWideChar(CP_UTF8, 0, code, -1, wcd, 31);
        for (int i = 0; wc[i]; i++) if (wc[i] == L'|') wc[i] = L'\n';
        for (int i = 0; wa[i]; i++) if (wa[i] == L'|') wa[i] = L'\n';
        Log(L"Анализ: %s %s\r\nПричины:\r\n%s\r\nДействия:\r\n%s", wcd, wn, wc, wa);
      }
      if (ActValue("jobId", tmp, 45)) {
        wchar_t wj[50]; MultiByteToWideChar(CP_UTF8, 0, tmp, -1, wj, 49);
        lstrcpynW(g_jobId, wj, 47);
        lstrcpynW(g_jobStatus, L"queued", 63);
        Log(L"ИИ-задача в очереди");
      }
      if (ActValue("status", tmp, 60)) MultiByteToWideChar(CP_UTF8, 0, tmp, -1, g_jobStatus, 63);
      if (ActValue("pl1", tmp, 30)) { char p22[32]; ActValue("pl2", p22, 31); Log(L"Лимиты: PL1=%s Вт PL2=%s Вт (guarded)", tmp, p22); }
      if (ActValue("mode", tmp, 30)) Log(L"Термал-политика: %s", tmp);
      if (ActValue("n", tmp, 30)) {
        int cnt = atoi(tmp);
        Log(L"── Аудит (%s) ──", tmp);
        for (int i = cnt - 1; i >= 0; i--) {
          char key[8]; _snprintf(key, 7, "l%d", i);
          char row[400];
          if (ActValue(key, row, 399)) {
            wchar_t wr2[450];
            MultiByteToWideChar(CP_UTF8, 0, row, -1, wr2, 449);
            for (int j = 0; wr2[j]; j++) if (wr2[j] == L'|') wr2[j] = L' ';
            Log(L"%s", wr2);
          }
        }
      }
      if (ActValue("value", tmp, 200)) Log(L"Конфиг применён");
    }
    HWND le = GetDlgItem(h, IDE_LOG);
    if (le && IsWindowVisible(le)) SetWindowTextW(le, g_log);
    InvalidateRect(h, NULL, FALSE);
    return 0;
  }
  case WM_PAINT: {
    PAINTSTRUCT ps; HDC dc = BeginPaint(h, &ps);
    SetBkMode(dc, TRANSPARENT);
    FillR(dc, 0, 0, CW, CH, C_BG);
    PaintRail(dc);
    PaintHeader(dc);
    PaintContent(dc);
    PaintStatusBar(dc);
    EndPaint(h, &ps);
    return 0;
  }
  case WM_CTLCOLOREDIT: {
    HDC dc = (HDC)w;
    SetTextColor(dc, RGB(208, 214, 226));
    SetBkColor(dc, C_EDITBG);
    return (LRESULT)g_brEditBg;
  }
  case WM_CTLCOLORLISTBOX:
  case WM_CTLCOLORSTATIC: {
    HDC dc = (HDC)w;
    SetTextColor(dc, C_TEXT);
    SetBkColor(dc, C_PANEL);
    return (LRESULT)g_brPanel;
  }
  case WM_DRAWITEM: {
    DRAWITEMSTRUCT *d = (DRAWITEMSTRUCT *)l;
    if (d->CtlType != ODT_BUTTON) break;
    wchar_t txt[96]; GetWindowTextW(d->hwndItem, txt, 95);
    BOOL hot = d->itemState & ODS_HOTLIGHT, dn = d->itemState & ODS_SELECTED;
    COLORREF bg = C_PANEL2, fg = C_TEXT;
    if (d->CtlID == IDB_AIGEN || d->CtlID == IDB_LOGIN) { bg = RGB(206, 54, 34); fg = RGB(255, 244, 240); }
    if (hot && !(d->CtlID == IDB_AIGEN || d->CtlID == IDB_LOGIN)) bg = RGB(32, 38, 52);
    if (dn) bg = RGB(28, 33, 46);
    HBRUSH b2 = CreateSolidBrush(bg); FillRect(d->hDC, &d->rcItem, b2); DeleteObject(b2);
    HBRUSH lb = CreateSolidBrush(RGB(52, 60, 78)); FrameRect(d->hDC, &d->rcItem, lb); DeleteObject(lb);
    SetBkMode(d->hDC, TRANSPARENT); SetTextColor(d->hDC, fg);
    SelectObject(d->hDC, g_fBody);
    DrawTextW(d->hDC, txt, -1, &d->rcItem, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    return TRUE;
  }
  case WM_COMMAND: {
    int id = LOWORD(w);
    if (id == IDB_PING || id == IDB_DNS) {
      wchar_t host[128]; GetDlgItemTextW(h, IDE_PINGHOST, host, 127);
      char hb[300]; WideCharToMultiByte(CP_UTF8, 0, host, -1, hb, 299, NULL, NULL);
      char body[340]; _snprintf(body, 339, "op=%s\nhost=%s", id == IDB_PING ? "ping" : "dns", hb);
      RunActionRaw(body);
    } else if (id == IDB_ANALYZE) {
      wchar_t inp[512]; GetDlgItemTextW(h, IDE_STAB, inp, 511);
      char ib[1500]; WideCharToMultiByte(CP_UTF8, 0, inp, -1, ib, 1499, NULL, NULL);
      for (char *q = ib; *q; q++) if (*q == '\n' || *q == '\r') *q = ' ';
      char body[1700]; _snprintf(body, 1699, "op=analyze\ninput=%s", ib);
      RunActionRaw(body);
    } else if (id == IDB_AIGEN) {
      wchar_t pr[1200]; GetDlgItemTextW(h, IDE_AIPROMPT, pr, 1199);
      wchar_t stp[16]; GetDlgItemTextW(h, IDE_AISTEPS, stp, 15);
      char pb[2600], sb[16];
      WideCharToMultiByte(CP_UTF8, 0, pr, -1, pb, 2599, NULL, NULL);
      WideCharToMultiByte(CP_UTF8, 0, stp, -1, sb, 15, NULL, NULL);
      for (char *q = pb; *q; q++) if (*q == '\n' || *q == '\r') *q = ' ';
      char body[2900]; _snprintf(body, 2899, "op=ai\nprompt=%s\nsteps=%s\nsize=768x768", pb, sb);
      RunActionRaw(body);
    } else if (id == IDB_LOGIN) {
      wchar_t uu[64], pp[64];
      GetDlgItemTextW(h, IDE_AU, uu, 63);
      GetDlgItemTextW(h, IDE_AP, pp, 63);
      lstrcpynW(g_user, uu, 39);
      RunActionLogin(uu, pp);
    } else if (id == IDB_SNAP) {
      char tok[96]; TokenA(tok, 95);
      char body[160]; _snprintf(body, 159, "op=snapshot\nnote=native\ntoken=%s", tok);
      RunActionRaw(body);
    } else if (id == IDB_AUDIT) {
      char tok[96]; TokenA(tok, 95);
      char body[160]; _snprintf(body, 159, "op=audit\ntoken=%s", tok);
      RunActionRaw(body);
    } else if (id == IDB_DEBAPPLY) {
      wchar_t v[32]; GetDlgItemTextW(h, IDE_DEB, v, 31);
      char tok[96], vb[32]; TokenA(tok, 95);
      WideCharToMultiByte(CP_UTF8, 0, v, -1, vb, 31, NULL, NULL);
      char body[192]; _snprintf(body, 191, "op=key\nsection=SENSOR_1\nkey=DR\nvalue=%s\ntoken=%s", vb, tok);
      RunActionRaw(body);
    } else if (id == IDB_DPIAPPLY) {
      ApplyDpiFromEdit();
    } else if (id >= IDB_DPIAPPLY + 1 && id <= IDB_DPIAPPLY + 5) {
      /* profile buttons are also clicked as real controls — rect handler does the work */
    }
    return 0;
  }
  case WM_LBUTTONDOWN: {
    SetCapture(h);
    HitTestCustom(GET_X_LPARAM(l), GET_Y_LPARAM(l));
    POINT pt = { GET_X_LPARAM(l), GET_Y_LPARAM(l) };
    for (int i = 0; i < 3; i++) {
      if ((g_page == PG_POWER && i < 2) || (g_page == PG_THERMAL && i == 2)) {
        RECT zone = g_sl[i].r; zone.top -= 8; zone.bottom += 8;
        if (PtInRect(&zone, pt)) g_sl[i].drag = TRUE;
      }
    }
    return 0;
  }
  case WM_MOUSEMOVE: {
    POINT pt = { GET_X_LPARAM(l), GET_Y_LPARAM(l) };
    BOOL changed = FALSE;
    for (int i = 0; i < 3; i++) {
      if (!g_sl[i].drag) continue;
      if ((g_page == PG_POWER && i < 2) || (g_page == PG_THERMAL && i == 2)) {
        int x = pt.x - CX0 - g_sl[i].r.left;
        if (x < 0) x = 0;
        if (x > g_sl[i].r.right - g_sl[i].r.left) x = g_sl[i].r.right - g_sl[i].r.left;
        int nv = g_sl[i].min + (int)((double)x / (g_sl[i].r.right - g_sl[i].r.left) * (g_sl[i].max - g_sl[i].min) + 0.5);
        if (nv != g_sl[i].val) { g_sl[i].val = nv; changed = TRUE; }
      }
    }
    if (changed) InvalidateRect(h, NULL, FALSE);
    return 0;
  }
  case WM_LBUTTONUP:
    ReleaseCapture();
    for (int i = 0; i < 3; i++) g_sl[i].drag = FALSE;
    return 0;
  case WM_TRAY: {
    if (l == WM_RBUTTONUP) {
      POINT p; GetCursorPos(&p);
      HMENU m = CreatePopupMenu();
      AppendMenuW(m, MF_STRING, 1, L"Открыть панель управления");
      AppendMenuW(m, MF_STRING, 2, L"Веб-панель (браузер)");
      AppendMenuW(m, MF_SEPARATOR, 0, NULL);
      AppendMenuW(m, MF_STRING, 3, L"Выход (остановить движок)");
      SetForegroundWindow(h);
      int id = TrackPopupMenu(m, TPM_RETURNCMD | TPM_NONOTIFY, p.x, p.y, 0, h, NULL);
      DestroyMenu(m);
      if (id == 1) { ShowWindow(h, SW_SHOW); SetForegroundWindow(h); }
      if (id == 2) { wchar_t u[64]; _snwprintf(u, 63, L"http://127.0.0.1:%d/", g_port); ShellExecuteW(h, L"open", u, NULL, NULL, SW_SHOWNORMAL); }
      if (id == 3) { if (g_hEngine) TerminateProcess(g_hEngine, 0); Shell_NotifyIconW(NIM_DELETE, &g_nid); PostQuitMessage(0); }
    } else if (l == WM_LBUTTONDBLCLK) { ShowWindow(h, SW_SHOW); SetForegroundWindow(h); }
    return 0;
  }
  case WM_CLOSE:
    ShowWindow(h, SW_HIDE);
    lstrcpynW(g_nid.szTip, L"Edge Control Center — работает в фоне", 128);
    Shell_NotifyIconW(NIM_MODIFY, &g_nid);
    return 0;
  case WM_DESTROY:
    if (g_hEngine) TerminateProcess(g_hEngine, 0);
    Shell_NotifyIconW(NIM_DELETE, &g_nid);
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(h, m, w, l);
}

static void CenterWindow(HWND h2) {
  RECT r; GetWindowRect(h2, &r);
  int wd = r.right - r.left, ht = r.bottom - r.top;
  MoveWindow(h2, (GetSystemMetrics(SM_CXSCREEN) - wd) / 2,
             (GetSystemMetrics(SM_CYSCREEN) - ht) / 2, wd, ht, FALSE);
}

int APIENTRY wWinMain(HINSTANCE hInst, HINSTANCE, PWSTR, int nShow) {
  g_hInst = hInst;
  InitCommonControls();
  g_brPanel = CreateSolidBrush(C_PANEL);
  g_brEditBg = CreateSolidBrush(C_EDITBG);

  wchar_t exeDir[MAX_PATH];
  GetModuleFileNameW(NULL, exeDir, MAX_PATH);
  wchar_t *sl3 = wcsrchr(exeDir, L'\\'); if (sl3) *sl3 = 0;

  wchar_t env[16]; DWORD n = GetEnvironmentVariableW(L"PORT", env, 16);
  if (n > 0 && n < 16) { int p = _wtoi(env); if (p > 0 && p < 65536) g_port = p; }

  CreateMutexW(NULL, TRUE, APP_MUTEX);
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    MessageBoxW(NULL, L"Edge Control Center уже запущен — смотри значок в трее.", L"ECC", MB_OK | MB_ICONINFORMATION);
    return 0;
  }

  g_fH1 = CreateFontW(-22, 0, 0, 0, FW_BOLD, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
  g_fH2 = CreateFontW(-17, 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
  g_fBody = CreateFontW(-14, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
  g_fSmall = CreateFontW(-12, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
  g_fMono = CreateFontW(-13, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Consolas");
  g_fRail = CreateFontW(-14, 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
  g_fBig = CreateFontW(-30, 0, 0, 0, FW_BOLD, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
  g_fMark = CreateFontW(-20, 0, 0, 0, FW_BOLD, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");

  wchar_t icoPath[MAX_PATH];
  _snwprintf(icoPath, MAX_PATH - 1, L"%s\\appico.ico", exeDir);
  g_hIcon = (HICON)LoadImageW(NULL, icoPath, IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE);
  if (!g_hIcon) g_hIcon = LoadIconW(NULL, (LPCWSTR)IDI_APPLICATION);

  WNDCLASSW wc; memset(&wc, 0, sizeof wc);
  wc.lpfnWndProc = WndProc;
  wc.hInstance = hInst;
  wc.hCursor = LoadCursor(NULL, (LPCWSTR)IDC_ARROW);
  wc.hbrBackground = CreateSolidBrush(C_BG);
  wc.hIcon = g_hIcon;
  wc.lpszClassName = APP_CLASS;
  RegisterClassW(&wc);

  RECT r = { 0, 0, CW, CH };
  AdjustWindowRect(&r, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX, FALSE);
  HWND h = CreateWindowExW(0, APP_CLASS, L"Edge Control Center — ARDOR GAMING Edge 3327",
    WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
    CW_USEDEFAULT, CW_USEDEFAULT, r.right - r.left, r.bottom - r.top, NULL, NULL, hInst, NULL);
  g_hWnd = h;
  {
    HMODULE dwm = LoadLibraryW(L"dwmapi.dll");
    if (dwm) {
      typedef HRESULT(WINAPI * PFC)(HWND, DWORD, LPCVOID, DWORD);
      PFC f = (PFC)GetProcAddress(dwm, "DwmSetWindowAttribute");
      BOOL v = TRUE;
      if (f) f(h, 20, &v, sizeof v);
    }
  }
  if (g_hIcon) {
    SendMessageW(h, WM_SETICON, ICON_BIG, (LPARAM)g_hIcon);
    SendMessageW(h, WM_SETICON, ICON_SMALL, (LPARAM)g_hIcon);
  }
  SwitchPage(PG_OVERVIEW);
  CenterWindow(h);
  ShowWindow(h, nShow ? nShow : SW_SHOW);
  UpdateWindow(h);

  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) {
    if (!IsDialogMessageW(h, &msg)) { TranslateMessage(&msg); DispatchMessageW(&msg); }
  }
  return 0;
}
