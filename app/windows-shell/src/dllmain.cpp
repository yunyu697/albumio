// AlbumioShell.dll：Win11 右键菜单的 COM 入口（M9）。
// 清单里的 CLSID 与 identity.json 同源（build.ps1 生成 clsid.h），
// 注册走 MSIX sparse 包的 com:SurrogateServer，不需要写 HKCU/HKLM。

#include <windows.h>
#include <shobjidl.h>

#include <new>

#include "clsid.h"
#include "context_menu.h"

HMODULE g_module = nullptr;
LONG g_object_count = 0;

namespace {

const CLSID kAlbumioShellClsid = ALBUMIO_SHELL_CLSID;

class ClassFactory final : public IClassFactory {
 public:
  ClassFactory() { InterlockedIncrement(&g_object_count); }
  ~ClassFactory() { InterlockedDecrement(&g_object_count); }

  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (ppv == nullptr) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IClassFactory) {
      *ppv = static_cast<IClassFactory*>(this);
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

  STDMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** ppv) override {
    if (outer != nullptr) return CLASS_E_NOAGGREGATION;
    return CreateAlbumioContextMenu(riid, ppv);
  }

  STDMETHODIMP LockServer(BOOL lock) override {
    if (lock) {
      InterlockedIncrement(&g_object_count);
    } else {
      InterlockedDecrement(&g_object_count);
    }
    return S_OK;
  }

 private:
  LONG refs_ = 1;
};

}  // namespace

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    g_module = instance;
    DisableThreadLibraryCalls(instance);
  }
  return TRUE;
}

STDAPI DllGetClassObject(REFCLSID clsid, REFIID riid, void** ppv) {
  if (ppv == nullptr) return E_POINTER;
  *ppv = nullptr;
  if (clsid != kAlbumioShellClsid) return CLASS_E_CLASSNOTAVAILABLE;

  ClassFactory* factory = new (std::nothrow) ClassFactory();
  if (factory == nullptr) return E_OUTOFMEMORY;

  const HRESULT hr = factory->QueryInterface(riid, ppv);
  factory->Release();
  return hr;
}

STDAPI DllCanUnloadNow() {
  return g_object_count == 0 ? S_OK : S_FALSE;
}
