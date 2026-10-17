# 0.2.1 验收报告

验收日期：2026-10-18（Asia/Shanghai）

## 结论

`dsh-plugin-bash-wsl@0.2.1` 已针对以下实际宿主完成验收：

- DeepSeek Harness CLI `0.2.1-rc.2`
- DeepSeek Harness Desktop `0.2.1-rc.2`
- Desktop `app.asar` SHA-256：`47874618bf5b3011fcaac10cd4c85f69da333e70d4f99b921207c78d0999512a`
- Desktop 可执行文件 SHA-256：`9c789407850773ce7d914a3ec0476852bf1ceea69789d8ccf4e39be953f4bf52`

最终发布门禁结果为 **43 PASS / 0 SKIP / 0 FAIL**。候选包、安全探针使用包和门禁最终重打包逐字节一致：

- `dsh-plugin-bash-wsl-0.2.1.tgz`
- 143 个发布文件
- SHA-256：`16ccf78d367fcd1d11100550024e2dc7cbf62a38ccb3a8637b6e0b73c51e91b0`

任何此前绑定其他 TGZ 哈希的结果均未计入最终资格。

## 自动化验证

| 范围 | 结果 |
| --- | --- |
| Windows Vitest | 36 个文件、307/307 通过、0 跳过 |
| TypeScript 类型检查 | PASS |
| clean build、stale `dist` 清理、Windows `pnpm@11.21.0` 打包 | PASS |
| 包清单、私人绝对路径与敏感文本审计 | 143 个文件，PASS |
| WSL restricted PTY、几何尺寸与 Windows interop 越界防护 | PASS |
| CLI 集成与 malformed UTF-8/输出上限 | PASS |
| CLI 原生 WSL/Git Bash 双模式 | PASS / PASS |
| Desktop 上下文、安全矩阵与卸载清理 | 157 通过、0 跳过、0 失败 |
| Desktop 新模式、提示词、pwsh、生命周期 | 10 通过、0 跳过、0 失败 |
| 旧 `0.1.0-rc.6` 插件在新宿主上的拒绝 | PASS（loader 与完整 Host 双重验证） |

CLI 和 Desktop 验证覆盖了规范路径与符号链接边界、启动环境变量清理、命令/参数保真、审批拒绝零进程、沙盒依赖故障关闭、不可变工作区、Windows interop 防护、所有者隔离、持久状态、自然退出、后台进程、超时、取消、输出缺口/上限、错误呈现和卸载清理。目标 Windows 宿主上的 required 项没有 SKIP。

## 真实 Desktop GUI 验收

最终 TGZ 分别建立了两个独立真实会话，并调用 DeepSeek Flash 完成最小工具验证：

- `WSL 模式`：`workspace-write`；两次 `bash` 调用均退出码 0。
- `Git Bash 模式`：用户授权的会话级 `danger-full-access`；两次 `bash` 调用均退出码 0。
- 第一条输出：`DSH_GUI_TURN1:DSH_GUI_TURN1`
- 第二条输出：`DSH_GUI_TURN2:DSH_GUI_TURN1`
- 两个模式、权限状态、两张工具卡和两条实际输出均在 Desktop UI 中观察。
- 两次均通过应用菜单正常退出；未强制结束进程。WSL marker 和 Windows PID/CreationDate 进程树退出后均为空。

rc.2 会从普通聊天流隐藏 system-prompt 行，因此报告不宣称提示词在聊天界面可见。提示词的安装、按模式组装、schema 内容、卸载移除和 opposite-mode 隔离由真实 Desktop Host 探针验证。

## 最终本地证据

原始运行产物保留在本地忽略目录，不进入 Git 或安装包：

| 证据 | SHA-256 |
| --- | --- |
| CLI 原生双模式 | `9053151a9007f98662a658d8a9a27444c6a611821ae91d3eca1972b35fe5ba5b` |
| 安全探针 | `ad2b35201c7b9a3b1f4a30bfc999093cbdc247bb470088198ad6a65559b2f6ce` |
| Desktop 157 项上下文探针 | `d5721f18036472306821fd23d707b2f808032a3dc6ac89b3dc381dcb6c7c9371` |
| Desktop 新模式探针 | `e404f48b1a28828bde6264f56388b0f57b82b5925783bf271b7281ab33affb01` |
| 独立 GUI roster | `5a5ffade773199f600d77294f811b8143d828814c44b680ba6b3faf425074406` |
| GUI D16 汇总证据 | `a9db0007cd1644e83b325ef77c41e9ca18f8c8e05bbd16294bed30f607e1cf30` |

## 支持边界

- `0.2.1` 只声明支持 Desktop 与 CLI `0.2.1-rc.2`；旧宿主继续使用 `0.2.0` 或对应旧版插件。
- WSL 模式保留受限工作区沙盒与 Windows interop 防护。
- 原生 Git Bash 无法在当前 DSH Windows 文件沙盒中可靠启动，因此 Git Bash 模式仍要求调用者先明确选择完全权限；选择模式本身不会自动提升权限。
- 本次验证覆盖本机 Ubuntu/WSL2，不外推为所有历史 WSL 版本均已实机验证。
- rc.2 发布当日的依赖安装曾在隔离测试目录中使用一次性 `minimumReleaseAge=0`；项目和用户全局供应链策略均未被放宽。
- 本报告不表示 npm 已发布。
