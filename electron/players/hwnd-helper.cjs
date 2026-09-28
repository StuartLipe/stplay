/**
 * HWND helper nativo (koffi) — mesmo papel do mpv-window.ps1, sem PowerShell.
 * O PowerShell bloqueava o processo principal e congelava a UI.
 */
const koffi = require('koffi')

const GWL_STYLE = -16
const GWL_EXSTYLE = -20
const WS_CLIPCHILDREN = 0x02000000
const WS_CLIPSIBLINGS = 0x04000000
const WS_CHILD = 0x40000000
const WS_VISIBLE = 0x10000000
const WS_POPUP = 0x80000000
const WS_CAPTION = 0x00c00000
const WS_THICKFRAME = 0x00040000
const WS_SYSMENU = 0x00080000
const WS_EX_TOPMOST = 0x00000008
const WS_EX_APPWINDOW = 0x00040000
const WS_EX_TOOLWINDOW = 0x00000080
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOACTIVATE = 0x0010
const SWP_SHOWWINDOW = 0x0040
const SWP_FRAMECHANGED = 0x0020
const SW_HIDE = 0
const SW_SHOWNA = 8
const HWND_TOP = 0

let cachedParent = 0
let cachedVideoHwnd = 0

const winApi =
  process.platform === 'win32'
    ? (() => {
        const user32 = koffi.load('user32.dll')
        const EnumChildProc = koffi.proto('bool __stdcall EnumChildProc(intptr hwnd, intptr lParam)')
        const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(intptr hwnd, intptr lParam)')
        return {
          EnumChildProc,
          EnumWindowsProc,
          IsWindow: user32.func('bool __stdcall IsWindow(intptr hWnd)'),
          FindWindowExW: user32.func('intptr __stdcall FindWindowExW(intptr, intptr, str16, str16)'),
          GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr, _Out_ uint32*)'),
          SetParent: user32.func('intptr __stdcall SetParent(intptr, intptr)'),
          GetWindowLongPtrW: user32.func('intptr __stdcall GetWindowLongPtrW(intptr, int)'),
          SetWindowLongPtrW: user32.func('intptr __stdcall SetWindowLongPtrW(intptr, int, intptr)'),
          MoveWindow: user32.func('bool __stdcall MoveWindow(intptr, int, int, int, int, bool)'),
          ShowWindow: user32.func('bool __stdcall ShowWindow(intptr, int)'),
          SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr, intptr, int, int, int, int, uint32)'),
          EnumChildWindows: user32.func('bool __stdcall EnumChildWindows(intptr hWndParent, EnumChildProc *pfnEnum, intptr lParam)'),
          EnumWindows: user32.func('bool __stdcall EnumWindows(EnumWindowsProc *pfnEnum, intptr lParam)'),
          GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr hWnd, _Out_ uint16 *lpString, int nMaxCount)'),
          GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr hWnd, _Out_ uint16 *lpString, int nMaxCount)'),
        }
      })()
    : null

function orStyle(hwnd, flags) {
  if (!winApi || !hwnd || !winApi.IsWindow(hwnd)) return
  const style = Number(winApi.GetWindowLongPtrW(hwnd, GWL_STYLE))
  winApi.SetWindowLongPtrW(hwnd, GWL_STYLE, style | flags)
}

function readWide(getFn, hwnd) {
  const buf = Buffer.alloc(512)
  const len = getFn(hwnd, buf, 256)
  if (len <= 0) return ''
  return buf.toString('utf16le', 0, len * 2).replace(/\0.*$/, '')
}

function shouldClipChild(hwnd) {
  const title = readWide(winApi.GetWindowTextW, hwnd)
  const cls = readWide(winApi.GetClassNameW, hwnd)
  if (/Intermediate D3D/i.test(title) || /Intermediate D3D/i.test(cls)) return true
  if (/Chrome_RenderWidgetHostHWND/i.test(cls)) return true
  if (/Chrome_WidgetWin/i.test(cls)) return true
  return false
}

function prepareParent(parentHwnd) {
  if (!winApi || !parentHwnd || !winApi.IsWindow(parentHwnd)) return false
  cachedParent = parentHwnd
  orStyle(parentHwnd, WS_CLIPCHILDREN)
  const cb = koffi.register((hwnd) => {
    if (!hwnd || !winApi.IsWindow(hwnd)) return true
    if (shouldClipChild(hwnd)) orStyle(hwnd, WS_CLIPSIBLINGS)
    return true
  }, koffi.pointer(winApi.EnumChildProc))
  try {
    winApi.EnumChildWindows(parentHwnd, cb, 0)
  } catch {
    // ignore
  } finally {
    koffi.unregister(cb)
  }
  return true
}

function childRaise(childHwnd) {
  if (!winApi || !childHwnd || !winApi.IsWindow(childHwnd)) return false
  if (cachedParent) prepareParent(cachedParent)
  winApi.SetWindowPos(childHwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW)
  return true
}

function findMpvByPid(pid) {
  if (!winApi || !pid) return 0
  let cur = 0
  for (let i = 0; i < 128; i++) {
    cur = Number(winApi.FindWindowExW(0, cur, 'mpv', null))
    if (!cur) break
    const pidOut = [0]
    winApi.GetWindowThreadProcessId(cur, pidOut)
    if (pidOut[0] === pid) return cur
  }
  let found = 0
  const cb = koffi.register((hwnd) => {
    const pidOut = [0]
    winApi.GetWindowThreadProcessId(hwnd, pidOut)
    if (pidOut[0] !== pid) return true
    const cls = readWide(winApi.GetClassNameW, hwnd)
    if (/Console/i.test(cls) || /IME/i.test(cls)) return true
    found = hwnd
    return false
  }, koffi.pointer(winApi.EnumWindowsProc))
  try {
    winApi.EnumWindows(cb, 0)
  } catch {
    // ignore
  } finally {
    koffi.unregister(cb)
  }
  return found
}

function makeChild(hwnd, parent) {
  if (!winApi || !hwnd || !parent) return
  let style = Number(winApi.GetWindowLongPtrW(hwnd, GWL_STYLE))
  style = (style | WS_CHILD | WS_CLIPSIBLINGS | WS_VISIBLE) & ~WS_POPUP & ~WS_CAPTION & ~WS_THICKFRAME & ~WS_SYSMENU
  winApi.SetWindowLongPtrW(hwnd, GWL_STYLE, style)
  let ex = Number(winApi.GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
  ex = (ex & ~WS_EX_TOPMOST & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW
  winApi.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex)
  winApi.SetParent(hwnd, parent)
  winApi.SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED)
}

function adopt(parentHwnd, pid) {
  if (!winApi || !parentHwnd || !pid) return 0
  cachedParent = parentHwnd
  prepareParent(parentHwnd)
  const hwnd = findMpvByPid(pid)
  if (!hwnd) return 0
  makeChild(hwnd, parentHwnd)
  winApi.ShowWindow(hwnd, SW_HIDE)
  winApi.MoveWindow(hwnd, -32000, -32000, 16, 16, false)
  cachedVideoHwnd = hwnd
  return hwnd
}

function place(x, y, w, h) {
  if (!winApi || !cachedVideoHwnd || !winApi.IsWindow(cachedVideoHwnd)) return false
  if (cachedParent) prepareParent(cachedParent)
  const width = Math.max(16, w)
  const height = Math.max(16, h)
  winApi.MoveWindow(cachedVideoHwnd, x, y, width, height, true)
  winApi.ShowWindow(cachedVideoHwnd, SW_SHOWNA)
  childRaise(cachedVideoHwnd)
  return true
}

function raise() {
  if (cachedVideoHwnd) childRaise(cachedVideoHwnd)
}

function hide() {
  if (!winApi || !cachedVideoHwnd || !winApi.IsWindow(cachedVideoHwnd)) return
  winApi.ShowWindow(cachedVideoHwnd, SW_HIDE)
  winApi.MoveWindow(cachedVideoHwnd, -32000, -32000, 16, 16, false)
}

function release() {
  if (!winApi || !cachedVideoHwnd || !winApi.IsWindow(cachedVideoHwnd)) {
    cachedVideoHwnd = 0
    return
  }
  try {
    winApi.SetParent(cachedVideoHwnd, 0)
  } catch {
    // ignore
  }
  winApi.ShowWindow(cachedVideoHwnd, SW_HIDE)
  cachedVideoHwnd = 0
}

function shutdown() {
  release()
  cachedParent = 0
}

module.exports = { adopt, place, raise, hide, release, shutdown, prepareParent, childRaise }
