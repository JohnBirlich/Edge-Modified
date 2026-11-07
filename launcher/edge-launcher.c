/* ============================================================================
 * Edge Control Center — native Windows launcher (Win32, no dependencies)
 * Compiled with: zig cc -target x86_64-windows-gnu (mingw-w64 CRT)
 *
 * What it does:
 *   1. Shows a dark native splash/controller window ("Edge Control Center")
 *   2. Starts the hidden SEA engine (ecc-engine.exe) in the same folder
 *   3. Waits until http://127.0.0.1:<port>/api/state answers 200
 *   4. Opens the panel in a standalone APP WINDOW (msedge --app; chrome
 *      fallback; default browser last) — no address bar, own taskbar icon
 *   5. Tray icon: open panel / show window / exit (kills the engine)
 * ==========================================================================*/
#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#define _WIN32_IE 0x0600
#include <windows.h>
#include <shellapi.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <string.h>
#include <stdlib.h>

#define APP_CLASS   L"ECCtrlMainWindow"
#define APP_MUTEX   L"EdgeControlCenter.App.Mutex"
#define WM_TRAY     (WM_APP + 1)
#define ID_BTN_OPEN 1001
#define ID_BTN_EXIT 1002
#define ID_TIMER    1

static HINSTANCE g_hInst;
static HWND      g_hWnd, g_btnOpen, g_btnExit;
static HANDLE    g_hEngine = NULL;
static BOOL      g_ready = FALSE, g_engineDead = FALSE, g_opened = FALSE;
static int       g_port = 3327;
static int       g_dots = 0;
static wchar_t   g_status[256] = L"Инициализация…";
static wchar_t   g_dir[MAX_PATH];
static HICON     g_hIcon = NULL;
static HFONT     g_fTitle, g_fSub, g_fStatus, g_fMark, g_fBtn;
static HBRUSH    g_bgBrush;
static NOTIFYICONDATAW g_nid;

/* ------------------------------------------------------------------ utils */
static void SetStatus(const wchar_t *s) {
  lstrcpynW(g_status, s, 256);
  InvalidateRect(g_hWnd, NULL, TRUE);
}

static BOOL FileExists(const wchar_t *p) {
  DWORD a = GetFileAttributesW(p);
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

/* --------------------------------------------------------------- probing */
static BOOL Probe(void) {
  static BOOL wsa = FALSE;
  if (!wsa) { WSADATA w; if (WSAStartup(MAKEWORD(2, 2), &w) != 0) return FALSE; wsa = TRUE; }
  SOCKET s = socket(AF_INET, SOCK_STREAM, 0);
  if (s == INVALID_SOCKET) return FALSE;
  u_long nb = 1; ioctlsocket(s, FIONBIO, &nb);
  struct sockaddr_in a; memset(&a, 0, sizeof a);
  a.sin_family = AF_INET; a.sin_port = htons((u_short)g_port);
  inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
  connect(s, (struct sockaddr *)&a, sizeof a);
  fd_set wset; FD_ZERO(&wset); FD_SET(s, &wset);
  struct timeval tv; tv.tv_sec = 0; tv.tv_usec = 450000;
  BOOL ok = FALSE;
  if (select(0, NULL, &wset, NULL, &tv) > 0) {
    const char *req = "GET /api/state HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n";
    if (send(s, req, (int)strlen(req), 0) > 0) {
      char buf[300]; memset(buf, 0, sizeof buf);
      int n = recv(s, buf, (int)sizeof buf - 1, 0);
      ok = n > 12 && strstr(buf, " 200") != NULL;
    }
  }
  closesocket(s);
  return ok;
}

/* ---------------------------------------------------------------- engine */
static void StartEngine(void) {
  wchar_t exe[MAX_PATH], cmd[MAX_PATH + 2];
  wsprintfW(exe, L"%s\\ecc-engine.exe", g_dir);
  if (!FileExists(exe)) {
    g_engineDead = TRUE;
    SetStatus(L"✗ ecc-engine.exe не найден рядом с приложением — распакуй ZIP целиком.");
    return;
  }
  lstrcpynW(cmd, L"\"", MAX_PATH); lstrcatW(cmd, exe); lstrcatW(cmd, L"\"");
  STARTUPINFOW si; PROCESS_INFORMATION pi;
  memset(&si, 0, sizeof si); si.cb = sizeof si;
  memset(&pi, 0, sizeof pi);
  if (!CreateProcessW(exe, cmd, NULL, NULL, FALSE,
                      CREATE_NO_WINDOW, NULL, g_dir, &si, &pi)) {
    g_engineDead = TRUE;
    SetStatus(L"✗ не удалось запустить движок (антивирус? права?). См. README.txt");
    return;
  }
  g_hEngine = pi.hProcess;
  CloseHandle(pi.hThread);
  SetStatus(L"Запуск движка…");
}

static void StopEngine(void) {
  if (g_hEngine) { TerminateProcess(g_hEngine, 0); CloseHandle(g_hEngine); g_hEngine = NULL; }
}

/* ------------------------------------------------------------ panel open */
static void OpenPanel(void) {
  wchar_t params[160];
  wsprintfW(params, L"--app=http://127.0.0.1:%d/ --window-size=1380,920", g_port);
  INT_PTR r = (INT_PTR)ShellExecuteW(g_hWnd, L"open", L"msedge.exe", params, NULL, SW_SHOWNORMAL);
  if (r <= 32) r = (INT_PTR)ShellExecuteW(g_hWnd, L"open", L"chrome.exe", params, NULL, SW_SHOWNORMAL);
  if (r <= 32) {
    wchar_t url[96];
    wsprintfW(url, L"http://127.0.0.1:%d/", g_port);
    ShellExecuteW(g_hWnd, L"open", url, NULL, NULL, SW_SHOWNORMAL);
  }
}

/* ------------------------------------------------------------------ exit */
static void ExitApp(void) {
  StopEngine();
  Shell_NotifyIconW(NIM_DELETE, &g_nid);
  PostQuitMessage(0);
}

/* ---------------------------------------------------------------- window */
static void CenterWindow(HWND h) {
  RECT r; GetWindowRect(h, &r);
  int w = r.right - r.left, hh = r.bottom - r.top;
  int x = (GetSystemMetrics(SM_CXSCREEN) - w) / 2;
  int y = (GetSystemMetrics(SM_CYSCREEN) - hh) / 2;
  MoveWindow(h, x, y, w, hh, FALSE);
}

static void AddTray(void) {
  memset(&g_nid, 0, sizeof g_nid);
  g_nid.cbSize = sizeof g_nid;
  g_nid.hWnd = g_hWnd;
  g_nid.uID = 1;
  g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
  g_nid.uCallbackMessage = WM_TRAY;
  g_nid.hIcon = g_hIcon;
  lstrcpynW(g_nid.szTip, L"Edge Control Center — работает (движок :3327)", 128);
  Shell_NotifyIconW(NIM_ADD, &g_nid);
}

static void OnTray(UINT msg) {
  if (msg == WM_LBUTTONDBLCLK) { OpenPanel(); return; }
  if (msg != WM_RBUTTONUP) return;
  POINT p; GetCursorPos(&p);
  HMENU m = CreatePopupMenu();
  AppendMenuW(m, MF_STRING, 1, L"Открыть панель");
  AppendMenuW(m, MF_STRING, 2, L"Показать окно");
  AppendMenuW(m, MF_SEPARATOR, 0, NULL);
  AppendMenuW(m, MF_STRING, 3, L"Выход (остановить движок)");
  SetForegroundWindow(g_hWnd);
  int id = TrackPopupMenu(m, TPM_RETURNCMD | TPM_NONOTIFY, p.x, p.y, 0, g_hWnd, NULL);
  DestroyMenu(m);
  if (id == 1) OpenPanel();
  if (id == 2) { ShowWindow(g_hWnd, SW_SHOW); SetForegroundWindow(g_hWnd); }
  if (id == 3) ExitApp();
}

static void OnPaint(HDC dc) {
  RECT rc; GetClientRect(g_hWnd, &rc);
  HBRUSH bg = CreateSolidBrush(RGB(12, 14, 19));
  FillRect(dc, &rc, bg); DeleteObject(bg);
  /* top ember strip */
  RECT s1 = rc; s1.right = rc.right / 2; s1.bottom = 3;
  HBRUSH b1 = CreateSolidBrush(RGB(255, 77, 46));
  FillRect(dc, &s1, b1); DeleteObject(b1);
  RECT s2 = rc; s2.left = rc.right / 2; s2.bottom = 3;
  HBRUSH b2 = CreateSolidBrush(RGB(255, 157, 46));
  FillRect(dc, &s2, b2); DeleteObject(b2);
  /* logo mark */
  RECT mk = { 24, 26, 24 + 48, 26 + 48 };
  HBRUSH mb = CreateSolidBrush(RGB(255, 77, 46));
  HBRUSH ob = (HBRUSH)SelectObject(dc, mb);
  HPEN np = CreatePen(PS_NULL, 0, 0);
  HPEN op = (HPEN)SelectObject(dc, np);
  RoundRect(dc, mk.left, mk.top, mk.right, mk.bottom, 14, 14);
  SelectObject(dc, ob); SelectObject(dc, op);
  DeleteObject(np); DeleteObject(mb);
  SetBkMode(dc, TRANSPARENT);
  SetTextColor(dc, RGB(24, 9, 6));
  HFONT of = (HFONT)SelectObject(dc, g_fMark);
  DrawTextW(dc, L"E", -1, &mk, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
  /* title + subtitle */
  RECT t = { 86, 26, rc.right - 16, 60 };
  SelectObject(dc, g_fTitle);
  SetTextColor(dc, RGB(232, 234, 240));
  DrawTextW(dc, L"EDGE CONTROL CENTER", -1, &t, DT_LEFT | DT_SINGLELINE);
  RECT st = { 86, 60, rc.right - 16, 82 };
  SelectObject(dc, g_fSub);
  SetTextColor(dc, RGB(152, 160, 179));
  DrawTextW(dc, L"ARDOR GAMING Edge 3327 · v1.0.0 «IGNITION»", -1, &st, DT_LEFT | DT_SINGLELINE);
  /* status */
  RECT ss = { 24, 92, rc.right - 24, 116 };
  SelectObject(dc, g_fStatus);
  SetTextColor(dc, g_engineDead ? RGB(255, 77, 94) : g_ready ? RGB(63, 211, 159) : RGB(180, 188, 205));
  DrawTextW(dc, g_status, -1, &ss, DT_LEFT | DT_SINGLELINE);
  RECT hint = { 24, 120, rc.right - 24, 158 };
  SelectObject(dc, g_fSub);
  SetTextColor(dc, RGB(110, 118, 136));
  DrawTextW(dc, L"Движок работает скрыто. Панель открывается отдельным окном приложения; значок — в трее.", -1, &hint, DT_LEFT | DT_WORDBREAK);
  SelectObject(dc, of);
}

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
  case WM_CREATE: {
    g_btnOpen = CreateWindowW(L"BUTTON", L"Открыть панель",
      WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 24, 168, 200, 40, h,
      (HMENU)ID_BTN_OPEN, g_hInst, NULL);
    g_btnExit = CreateWindowW(L"BUTTON", L"Выход",
      WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 236, 168, 200, 40, h,
      (HMENU)ID_BTN_EXIT, g_hInst, NULL);
    SendMessageW(g_btnOpen, WM_SETFONT, (WPARAM)g_fBtn, TRUE);
    SendMessageW(g_btnExit, WM_SETFONT, (WPARAM)g_fBtn, TRUE);
    SetTimer(h, ID_TIMER, 450, NULL);
    StartEngine();
    AddTray();
    return 0;
  }
  case WM_TIMER: {
    if (g_engineDead) { KillTimer(h, ID_TIMER); return 0; }
    if (!g_ready && g_hEngine &&
        WaitForSingleObject(g_hEngine, 0) == WAIT_OBJECT_0) {
      g_engineDead = TRUE;
      SetStatus(L"✗ движок завершился раньше времени — порт занят? См. README.txt");
      InvalidateRect(h, NULL, TRUE);
      KillTimer(h, ID_TIMER);
      return 0;
    }
    if (!g_ready) {
      if (Probe()) {
        g_ready = TRUE;
        SetStatus(L"✓ Панель запущена — открываю окно приложения…");
        if (!g_opened) {
          g_opened = TRUE;
          wchar_t nb[8]; DWORD nn = GetEnvironmentVariableW(L"ECC_NO_APPWINDOW", nb, 8);
          if (nn == 0) OpenPanel();
        }
        InvalidateRect(h, NULL, TRUE);
      } else {
        g_dots = (g_dots + 1) % 4;
        wchar_t buf[64]; int i;
        lstrcpynW(buf, L"Подключение к движку", 64);
        for (i = 0; i < g_dots; i++) lstrcatW(buf, L".");
        SetStatus(buf);
      }
    }
    return 0;
  }
  case WM_PAINT: {
    PAINTSTRUCT ps;
    HDC dc = BeginPaint(h, &ps);
    OnPaint(dc);
    EndPaint(h, &ps);
    return 0;
  }
  case WM_DRAWITEM: {
    DRAWITEMSTRUCT *d = (DRAWITEMSTRUCT *)l;
    if (d->CtlID != ID_BTN_OPEN && d->CtlID != ID_BTN_EXIT) break;
    BOOL acc = (d->CtlID == ID_BTN_OPEN);
    HBRUSH br = CreateSolidBrush(acc ? RGB(206, 54, 34) : RGB(23, 27, 38));
    FillRect(d->hDC, &d->rcItem, br); DeleteObject(br);
    br = CreateSolidBrush(acc ? RGB(255, 120, 60) : RGB(52, 60, 78));
    FrameRect(d->hDC, &d->rcItem, br); DeleteObject(br);
    SetBkMode(d->hDC, TRANSPARENT);
    SetTextColor(d->hDC, acc ? RGB(255, 242, 235) : RGB(200, 206, 220));
    DrawTextW(d->hDC, acc ? L"Открыть панель" : L"Выход", -1, &d->rcItem,
              DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    return TRUE;
  }
  case WM_COMMAND:
    if (LOWORD(w) == ID_BTN_OPEN) OpenPanel();
    if (LOWORD(w) == ID_BTN_EXIT) ExitApp();
    return 0;
  case WM_TRAY:
    OnTray((UINT)l);
    return 0;
  case WM_CLOSE:
    ShowWindow(h, SW_HIDE);
    lstrcpynW(g_nid.szTip, L"Edge Control Center — работает в фоне", 128);
    Shell_NotifyIconW(NIM_MODIFY, &g_nid);
    return 0;
  case WM_DESTROY:
    ExitApp();
    return 0;
  }
  return DefWindowProcW(h, m, w, l);
}

int APIENTRY wWinMain(HINSTANCE hInst, HINSTANCE hPrev, PWSTR cmdLine, int nShow) {
  (void)hPrev; (void)cmdLine;
  g_hInst = hInst;
  g_bgBrush = CreateSolidBrush(RGB(12, 14, 19));

  /* folder next to this exe */
  GetModuleFileNameW(NULL, g_dir, MAX_PATH);
  wchar_t *slash = wcsrchr(g_dir, L'\\');
  if (slash) *slash = 0;

  /* port override */
  wchar_t env[16];
  DWORD n = GetEnvironmentVariableW(L"PORT", env, 16);
  if (n > 0 && n < 16) { int p = _wtoi(env); if (p > 0 && p < 65536) g_port = p; }

  /* single instance: second launch just opens the panel */
  CreateMutexW(NULL, TRUE, APP_MUTEX);
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    wchar_t url[96];
    wsprintfW(url, L"http://127.0.0.1:%d/", g_port);
    ShellExecuteW(NULL, L"open", L"msedge.exe",
                  url, NULL, SW_SHOWNORMAL); /* app-mode of running panel */
    return 0;
  }

  /* fonts */
  g_fTitle = CreateFontW(-24, 0, 0, 0, FW_BOLD, 0, 0, 0, DEFAULT_CHARSET,
                         OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                         DEFAULT_PITCH, L"Segoe UI");
  g_fSub = CreateFontW(-13, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET,
                       OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                       DEFAULT_PITCH, L"Segoe UI");
  g_fStatus = CreateFontW(-15, 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET,
                          OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                          DEFAULT_PITCH, L"Segoe UI");
  g_fMark = CreateFontW(-26, 0, 0, 0, FW_BOLD, 0, 0, 0, DEFAULT_CHARSET,
                        OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                        DEFAULT_PITCH, L"Segoe UI");
  g_fBtn = CreateFontW(-15, 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET,
                       OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                       DEFAULT_PITCH, L"Segoe UI");

  /* icon: ARDOR appico.ico next to exe */
  wchar_t icoPath[MAX_PATH];
  wsprintfW(icoPath, L"%s\\appico.ico", g_dir);
  g_hIcon = (HICON)LoadImageW(NULL, icoPath, IMAGE_ICON, 0, 0,
                              LR_LOADFROMFILE | LR_DEFAULTSIZE);
  if (!g_hIcon) g_hIcon = LoadIconW(NULL, (LPCWSTR)IDI_APPLICATION);

  WNDCLASSW wc; memset(&wc, 0, sizeof wc);
  wc.lpfnWndProc = WndProc;
  wc.hInstance = hInst;
  wc.hCursor = LoadCursor(NULL, (LPCWSTR)IDC_ARROW);
  wc.hbrBackground = g_bgBrush;
  wc.hIcon = g_hIcon;
  wc.lpszClassName = APP_CLASS;
  RegisterClassW(&wc);

  RECT r = { 0, 0, 460, 228 };
  AdjustWindowRect(&r, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX, FALSE);
  g_hWnd = CreateWindowExW(0, APP_CLASS,
    L"Edge Control Center — ARDOR GAMING Edge 3327",
    WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
    CW_USEDEFAULT, CW_USEDEFAULT, r.right - r.left, r.bottom - r.top,
    NULL, NULL, hInst, NULL);

  /* dark title bar (best effort) */
  {
    HMODULE dwm = LoadLibraryW(L"dwmapi.dll");
    if (dwm) {
      typedef HRESULT (WINAPI *P)(HWND, DWORD, LPCVOID, DWORD);
      P f = (P)GetProcAddress(dwm, "DwmSetWindowAttribute");
      BOOL v = TRUE;
      if (f) f(g_hWnd, 20 /*DWMWA_USE_IMMERSIVE_DARK_MODE*/, &v, sizeof v);
    }
  }
  if (g_hIcon) {
    SendMessageW(g_hWnd, WM_SETICON, ICON_BIG, (LPARAM)g_hIcon);
    SendMessageW(g_hWnd, WM_SETICON, ICON_SMALL, (LPARAM)g_hIcon);
  }
  CenterWindow(g_hWnd);
  ShowWindow(g_hWnd, nShow ? nShow : SW_SHOW);
  UpdateWindow(g_hWnd);

  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  return 0;
}
