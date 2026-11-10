; Codex Speed 安装/卸载定制脚本
;
; electron-builder 会自动加载 buildResources 目录下的 installer.nsh，无需在
; package.json 里额外配置。
;
; 目的：卸载向导在「卸载已完成」之后、关闭之前，显示一个勾选框，让用户决定
; 是否保留配置、日志和缓存 —— 和常见 Windows 程序的做法一致。
;
; 实现位置：customUninstallPage。模板把它插在 MUI_UNPAGE_INSTFILES 之后、
; MUI_UNPAGE_FINISH 之前（templates/nsis/assistedInstaller.nsh:78）。
; 此时 $INSTDIR 已经删干净，但 %APPDATA%\Codex Speed 是独立目录，仍然可以删，
; 所以在这个页面上处理数据目录时机正好。
;
; 注意：本文件被 include 的时机早于 MUI2 的宏定义，所以不能使用
; MUI_HEADER_TEXT 之类的 MUI 宏（会报 macro not found）。页面标题直接用
; WM_SETTEXT 写给 MUI 的标题控件（1037/1038）。
;
; 默认勾选「保留」：静默卸载（/S，自动升级也走静默）不会走到这个页面，
; 因此默认不会删数据，避免升级或脚本化卸载误删用户配置。

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!define CS_WM_SETTEXT 0x000C
!define CS_MUI_HEADER_TEXT 1037
!define CS_MUI_HEADER_SUBTEXT 1038

; 卸载器相关代码只在 BUILD_UNINSTALLER 那一遍编译里存在。
; 否则安装器那一遍也会带上 un.* 函数，触发
; warning 6020: Uninstaller script code found but WriteUninstaller never used，
; 而 electron-builder 把 warning 当错误（-WX）处理。
!ifdef BUILD_UNINSTALLER

Var KeepAppDataCheckbox
Var KeepAppDataLabel

!macro customUninstallPage
  UninstPage custom un.KeepDataPageCreate un.KeepDataPageLeave
!macroend

Function un.KeepDataPageCreate
  ; 页面标题（MUI 头部两个静态控件）
  GetDlgItem $0 $HWNDPARENT ${CS_MUI_HEADER_TEXT}
  SendMessage $0 ${CS_WM_SETTEXT} 0 "STR:卸载完成"
  GetDlgItem $0 $HWNDPARENT ${CS_MUI_HEADER_SUBTEXT}
  SendMessage $0 ${CS_WM_SETTEXT} 0 "STR:选择是否保留数据"

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "Codex Speed 已从本机移除。"
  Pop $KeepAppDataLabel

  ${NSD_CreateCheckbox} 0 30u 100% 12u "保留配置、日志和缓存（$APPDATA\Codex Speed）"
  Pop $KeepAppDataCheckbox
  ${NSD_SetState} $KeepAppDataCheckbox ${BST_CHECKED}

  nsDialogs::Show
FunctionEnd

Function un.KeepDataPageLeave
  ${NSD_GetState} $KeepAppDataCheckbox $0
  ${If} $0 != ${BST_CHECKED}
    ; 用户取消勾选 = 要求一并清理
    RMDir /r "$APPDATA\Codex Speed"
  ${EndIf}
FunctionEnd

!endif
