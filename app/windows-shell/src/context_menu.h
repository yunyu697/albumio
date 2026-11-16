#pragma once

#include <windows.h>

// DLL 模块句柄：用来从自身路径推断 albumio.exe 的位置。
extern HMODULE g_module;

// 存活的 COM 对象计数，DllCanUnloadNow 据此回答。
extern LONG g_object_count;

// 创建 IExplorerCommand 实例（清单里登记的 CLSID 指向它）。
HRESULT CreateAlbumioContextMenu(REFIID riid, void** ppv);
