# dsh-plugin-bash-wsl

面向 DSH `0.1.0-rc.6` 的原生 Git Bash 与 WSL 后端插件。插件保留已有的 `pwsh` 工具，并新增：

- `bash`：按 Agent 所有权隔离的 WSL 持久 Shell；
- `wsl_bash`：WSL 一次性命令；
- `git_bash`：Git Bash 一次性命令。

目标运行时为 Node.js `>=22`，并严格匹配 DSH `0.1.0-rc.6`。仓库只生成本地可发布制品，不会替用户发布到 npm，也不会从未锁定的远端 `latest` 安装。

> **非官方社区项目。** 本插件是独立、社区维护的扩展，**与 DeepSeek 无隶属、背书或赞助关系**。"DeepSeek Harness"与"DSH"为其各自所有者的商标。插件基于 DSH `0.1.0-rc.6` 的公开插件 seam，并复用官方包作为依赖；本插件的任何缺陷、安全问题或行为变更均由本仓库负责，与 DeepSeek 或 DSH 项目无关。

## 安全摘要

默认模式是 `workspace-write`。可写根目录只能来自 DSH 的不可变 `sandboxPolicy.workspaceRoot`；模型传入的 `workdir` 只能选择该根目录内部的 cwd，不能选择或扩大可写根。所有 WSL 模式都使用 bubblewrap（`bwrap`）和 `script`；缺少依赖或策略服务时直接失败关闭，禁止降级成宿主全权限。

受限 WSL 模式（`read-only` 与 `workspace-write`）会遮蔽 `/run` 中的 Windows interop broker，并清除 `WSL_INTEROP`/`WSLENV`，因此 WSL 不能通过该 broker 启动 Windows `.exe`（例如 `cmd.exe`）。`danger-full-access` 作为明确的显式选择，故意保留宿主 interop。这是针对 Windows interop 的边界，不是通用 IPC 或服务隔离；宿主允许时，仍可能通过可达的本地服务或网络路径执行写入。

Git Bash restricted 模式失败关闭：被拒绝的命令启动零进程。只有 `danger-full-access`，或宿主审批授予的一次精确重试，才允许执行。持久会话不会原地升权。插件不提供网络隔离；宿主/后端允许时，命令可能访问网络。`doctor` 只读，绝不自动安装依赖。

## 安装要求

- Windows，并已安装 Git Bash 和 WSL；
- Node.js `>=22`；
- DSH `0.1.0-rc.6`；
- 所有 WSL 模式需要所选发行版内的 `bwrap`、`script` 与 `realpath`；
- Windows 集成测试需要可用的 Git Bash 可执行文件和 `wsl.exe`。

默认发行版为 `Ubuntu`。插件启动干净的 WSL Shell（`--noprofile --norc`）；只有宿主策略允许时才配置其他发行版或 Shell 参数。

## 安装插件

从检出的目录或本地 tarball 安装，避免使用未锁定的远端 `latest`：

```sh
npm install --save ./dsh-plugin-bash-wsl-0.1.0.tgz
```

在目标 DSH profile 目录执行安装命令。包元数据会加载随包提供的 `cordis.patch.yml`；请保留 profile 中已有的 PowerShell bundle。最小的 headless profile `package.json` 片段是：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-plugin-bash-wsl"]
    }
  }
}
```

如需覆盖配置，请按真实的 `profiles/windows.example.cordis.patch.yml` 结构使用 `distro`、`shellPath`、`shellArgs` 等字段。宿主 profile 仍负责授权 `sandboxPolicy.workspaceRoot`、审批和 Agent 身份。

不要在 profile patch 中写入密钥、凭据或可写根目录。

## 工具调用示例

一次性 `wsl_bash`/`git_bash` 调用需要 `command` 和 `description`；`description` 只用于 UI/日志，不影响执行。持久 `bash` 只需要 `command`，并保留按 Agent 隔离的状态：

```json
{
  "command": "printf '%s\\n' hello",
  "description": "Print a greeting",
  "workdir": "src"
}
```

无状态命令使用默认 Ubuntu 中的一次性 `wsl_bash`：

```json
{
  "tool": "wsl_bash",
  "command": "git status --short",
  "description": "Show repository status",
  "workdir": "."
}
```

需要保留状态时使用 `bash`：

```json
{
  "tool": "bash",
  "command": "export DSH_TEST=kept; cd src; pwd"
}
```

面向模型的持久 `bash` 工具按 Agent 所有权隔离：其他 Agent 不能列出、读取、发信号、写入或关闭该会话。按照官方 DSH `0.1.0-rc.6` tool contract，命令超时或被取消时会 reset/close 该所有者的 Shell；下一次调用会新建干净 Shell。底层 terminal backend 可能对单次 `startSend` 操作发送中断并结算，但这是实现细节，不能据此声称面向模型的工具会保留会话。相反，一次性 `wsl_bash`/`git_bash` 的取消或超时会终止其受管进程树。

`git_bash` 用于原生 Git Bash 命令。restricted 模式下被拒绝的调用不会启动进程；通过宿主审批后只能用同一个 command/cwd 进行一次精确的更宽模式重试，不能静默替换命令或可写根目录。

## doctor

在安装插件的宿主上执行独立的只读 doctor：

```sh
dsh-bash-wsl doctor
```

该独立命令以默认值和进程环境变量覆盖调用 `runDoctor`，不会解析 Cordis profile patch。默认使用 Ubuntu 与 `C:\Windows\System32\wsl.exe`；可用 `DSH_WSL_DISTRO`、`DSH_WSL_PATH`、`DSH_GIT_BASH_PATH` 覆盖。workspace mapping 默认使用当前目录。它报告 DSH 版本兼容性、Git Bash 发现结果、WSL 发行版、`bwrap`、`script`、`realpath` 以及 Windows↔WSL 路径映射。依赖缺失会使对应模式失败；doctor 不下载、安装、修改 PATH/profile，也不会用更高权限启动 Shell。

## 卸载

先停止所有持久会话，再用安装时相同的包管理器卸载：

```sh
npm uninstall dsh-plugin-bash-wsl
```

从 DSH profile 移除插件条目并重启 DSH。卸载不会删除 WSL 发行版、Git Bash、用户文件、工作区数据或保留的 `pwsh` 插件。删除检出目录或 tarball 前，请核查插件进程已无残留。

## 兼容性与故障排查

| 现象 | 检查 |
| --- | --- |
| 插件不加载 | 确认 DSH 为 `0.1.0-rc.6`、Node `>=22`，以及已安装插件包为 `0.1.0`。 |
| `workspace-write` 不可用 | 运行 `doctor`；由宿主的正常系统流程安装 `bwrap`/`script` 后重启 DSH。插件不会降级到不受限执行。 |
| 空格或中文路径失败 | 通过 `workdir` 传递，不要拼进 Shell 字符串；确认它位于 `sandboxPolicy.workspaceRoot` 内。 |
| 外部 `workdir` 被拒绝 | 这是预期行为。`workdir` 只是 cwd，不能扩大不可变可写根。 |
| Git Bash 被拒绝且零进程 | restricted 模式的预期结果。为同一精确重试取得宿主审批，不要换命令重试。 |
| 受限 WSL 中 Windows `.exe`/`cmd.exe` 失败 | 这是预期行为：受限模式隐藏 `/run` interop broker，并清除 `WSL_INTEROP`/`WSLENV`。请使用原生宿主工具；只有在接受宿主 interop 风险时，才使用经过明确审批的 `danger-full-access`。这不是通用 IPC 或网络边界。 |
| 持久状态消失 | 使用 `bash` 而不是 `wsl_bash`，并确认会话属于当前 Agent。持久会话是干净 Shell，不继承无关宿主 Shell 状态。 |
| 命令可以联网 | 这是已披露限制。插件不隔离网络；需要隔离时请使用宿主/网络策略。 |

发布候选版本请在源码检出目录运行 `node scripts/release-check.mjs`（npm tarball 不含 `scripts/`），并保留输出。脚本检查源码树的 typecheck/tests、使用 `npm --offline` 安装本地 tarball 的隔离 profile、`dsh --dump-config`、Windows 宿主上的 `dsh --help` 真实激活，以及 `npm pack --dry-run` 与 tarball 内容；不会发布、推送或修改用户 DSH profile。

## 许可证与归属

本包采用 MIT 许可证。复制或改编代码时必须保留原始版权与许可证声明，并在 `SECURITY.md` 或对应源文件注明借鉴内容。设计借鉴官方 DSH `rc.6` contract；适配的 terminal state-machine material 已在 `SECURITY.md` 与 `NOTICE` 标明，不暗示存在其他审计项目。

参见 [SECURITY.md](SECURITY.md)、[CONTRIBUTING.md](CONTRIBUTING.md) 与 [CHANGELOG.md](CHANGELOG.md)。
