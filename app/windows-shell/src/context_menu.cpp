// Win11 资源管理器右键菜单：IExplorerCommand 实现（M9）。
// 只对图片显示；点击后用 ShellExecute 把文件路径交给 albumio.exe
// （应用是单实例，第二个进程会把路径转给已运行的窗口）。

#include <windows.h>
#include <shobjidl.h>
#include <shellapi.h>

#include <cwchar>
#include <new>
#include <string>

#include "clsid.h" // build.ps1 从 identity.json 生成：ALBUMIO_APP_EXE
#include "context_menu.h"

namespace {

// 与 Rust 侧 `listing::read_images`、前端 IMAGE_EXT 保持同一张扩展名表。
const wchar_t* const kImageExtensions[] = {
    L".jpg",  L".jpeg", L".jpe", L".png",  L".webp",
    L".heic", L".heif", L".heics", L".heifs",
    L".tif",  L".tiff", L".bmp", L".gif", L".avif",
};

bool IsImagePath(const std::wstring& path) {
  const wchar_t* dot = wcsrchr(path.c_str(), L'.');
  if (dot == nullptr) return false;
  for (const wchar_t* ext : kImageExtensions) {
    if (_wcsicmp(dot, ext) == 0) return true;
  }
  return false;
}

HRESULT DuplicateString(const wchar_t* text, LPWSTR* out) {
  if (out == nullptr) return E_POINTER;
  *out = nullptr;
  const size_t bytes = (wcslen(text) + 1) * sizeof(wchar_t);
  *out = static_cast<LPWSTR>(CoTaskMemAlloc(bytes));
  if (*out == nullptr) return E_OUTOFMEMORY;
  memcpy(*out, text, bytes);
  return S_OK;
}

// 取选中项的文件系统路径（多选时只取第一项，与应用的"打开一个目标"一致）。
bool FirstSelectedPath(IShellItemArray* items, std::wstring& out) {
  if (items == nullptr) return false;
  DWORD count = 0;
  if (FAILED(items->GetCount(&count)) || count == 0) return false;

  IShellItem* item = nullptr;
  if (FAILED(items->GetItemAt(0, &item)) || item == nullptr) return false;

  PWSTR path = nullptr;
  const HRESULT hr = item->GetDisplayName(SIGDN_FILESYSPATH, &path);
  item->Release();
  if (FAILED(hr) || path == nullptr) return false;

  out.assign(path);
  CoTaskMemFree(path);
  return true;
}

// 选中项全部是图片时才显示；混选文件夹或非图片一律隐藏，避免误点。
bool AllSelectedAreImages(IShellItemArray* items) {
  if (items == nullptr) return false;
  DWORD count = 0;
  if (FAILED(items->GetCount(&count)) || count == 0) return false;

  bool all_images = true;
  for (DWORD i = 0; i < count && all_images; ++i) {
    IShellItem* item = nullptr;
    if (FAILED(items->GetItemAt(i, &item)) || item == nullptr) return false;

    PWSTR path = nullptr;
    const HRESULT hr = item->GetDisplayName(SIGDN_FILESYSPATH, &path);
    item->Release();
    if (FAILED(hr) || path == nullptr) return false;

    all_images = IsImagePath(path);
    CoTaskMemFree(path);
  }
  return all_images;
}

// albumio.exe 与 DLL 同目录（MSIX sparse 包的 external location）。
std::wstring ExecutablePath() {
  wchar_t buffer[MAX_PATH];
  const DWORD len = GetModuleFileNameW(g_module, buffer, MAX_PATH);
  if (len == 0 || len == MAX_PATH) return std::wstring();

  std::wstring path(buffer, len);
  const size_t slash = path.find_last_of(L"\\/");
  if (slash == std::wstring::npos) return std::wstring();
  path.resize(slash + 1);
  path += ALBUMIO_APP_EXE;
  return path;
}

class AlbumioContextMenu final : public IExplorerCommand {
 public:
  AlbumioContextMenu() { InterlockedIncrement(&g_object_count); }
  ~AlbumioContextMenu() { InterlockedDecrement(&g_object_count); }

  // IUnknown
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (ppv == nullptr) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IExplorerCommand) {
      *ppv = static_cast<IExplorerCommand*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }

  STDMETHODIMP_(ULONG) AddRef() override {
    return static_cast<ULONG>(InterlockedIncrement(&refs_));
  }

  STDMETHODIMP_(ULONG) Release() override {
    const LONG left = InterlockedDecrement(&refs_);
    if (left == 0) delete this;
    return static_cast<ULONG>(left);
  }

  // IExplorerCommand
  STDMETHODIMP GetTitle(IShellItemArray*, LPWSTR* name) override {
    return DuplicateString(L"用 Albumio 打开", name);
  }

  STDMETHODIMP GetIcon(IShellItemArray*, LPWSTR* icon) override {
    if (icon == nullptr) return E_POINTER;
    *icon = nullptr;
    const std::wstring exe = ExecutablePath();
    if (exe.empty()) return S_FALSE;
    return DuplicateString(exe.c_str(), icon);
  }

  STDMETHODIMP GetToolTip(IShellItemArray*, LPWSTR* tip) override {
    return DuplicateString(L"在 Albumio 中查看这张图片", tip);
  }

  STDMETHODIMP GetCanonicalName(GUID* guid) override {
    if (guid == nullptr) return E_POINTER;
    *guid = GUID_NULL;
    return S_OK;
  }

  STDMETHODIMP GetState(IShellItemArray* items, BOOL, EXPCMDSTATE* state) override {
    if (state == nullptr) return E_POINTER;
    *state = AllSelectedAreImages(items) ? ECS_ENABLED : ECS_HIDDEN;
    return S_OK;
  }

  STDMETHODIMP Invoke(IShellItemArray* items, IBindCtx*) override {
    std::wstring target;
    if (!FirstSelectedPath(items, target)) return S_FALSE;

    const std::wstring exe = ExecutablePath();
    if (exe.empty()) return E_FAIL;

    // 路径带空格时要加引号；albumio 的启动参数解析按单个参数处理。
    const std::wstring args = L"\"" + target + L"\"";
    const HINSTANCE result =
        ShellExecuteW(nullptr, L"open", exe.c_str(), args.c_str(), nullptr, SW_SHOWNORMAL);
    return reinterpret_cast<INT_PTR>(result) > 32 ? S_OK : E_FAIL;
  }

  STDMETHODIMP GetFlags(EXPCMDFLAGS* flags) override {
    if (flags == nullptr) return E_POINTER;
    *flags = ECF_DEFAULT;
    return S_OK;
  }

  STDMETHODIMP EnumSubCommands(IEnumExplorerCommand** commands) override {
    if (commands == nullptr) return E_POINTER;
    *commands = nullptr;
    return E_NOTIMPL;
  }

 private:
  LONG refs_ = 1;
};

}  // namespace

HRESULT CreateAlbumioContextMenu(REFIID riid, void** ppv) {
  if (ppv == nullptr) return E_POINTER;
  *ppv = nullptr;

  AlbumioContextMenu* menu = new (std::nothrow) AlbumioContextMenu();
  if (menu == nullptr) return E_OUTOFMEMORY;

  const HRESULT hr = menu->QueryInterface(riid, ppv);
  menu->Release();
  return hr;
}
