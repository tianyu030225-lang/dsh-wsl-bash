# dsh-plugin-bash-wsl 0.2.1

[English](README.md)

面向 Windows DSH 的原生 Git Bash 与 WSL 后端插件，当前版本为 `0.2.1`。桌面版与 CLI `0.2.1-rc.2` 共用同一个安装包。保留已有的 `pwsh` 工具，并为 Web/桌面版额外新增两个模式：

- **WSL 模式**（`bash-wsl`）：保留标准模式其他能力，默认使用按 Agent 隔离的持久 WSL `bash`；
- **Git Bash 模式**（`bash-git-bash`）：保留标准模式其他能力，默认使用持久原生 Git Bash `bash`，需要当前会话明确选择完全权限。

两个模式都提供一次性 `wsl_bash`、`git_bash` 和官方 `pwsh`。它们读取实际运行宿主自带的标准模式组合，不替换原有模式，也不改变默认选择；用户另行修改标准模式的内容不会自动复制。无界面的 CLI 仍默认使用持久 WSL，模式下拉菜单属于 Web/桌面版功能。

目标运行时为 Node.js `>=22`，只接受 DSH `0.2.1-rc.2`，不支持更早的 DSH；如需使用历史版本，请切换到对应标签查看说明。GitHub 源码公开与 npm 发布是两件事；当前尚未宣布 npm 发布，不要假定使用包名或未锁定的 `latest` 就能安装到本仓库的当前内容。

默认分支介绍当前 `0.2.1` 发布源码。历史版本继续保留在标签中：上一版使用 `v0.2.0`，只有 DSH `0.1.0-rc.6` 才使用 `v0.1.0`。

公开的回归源码、smoke 脚本及夹具统一放在 [`dev/测试/`](dev/测试/)。历史运行产物仍保留在已忽略的根目录 `测试/运行产物/`，不进入 Git 或 npm 包。`0.2.1` 报告记录本次重新执行的测试、构建与发布门禁；旧报告只证明其明确绑定的历史制品。

## 0.2.1 兼容性与发布证据

| 宿主 | 支持的 DSH 版本 |
| --- | --- |
| 桌面版 | `0.2.1-rc.2` |
| CLI | `0.2.1-rc.2` |

`0.2.1` 发布报告只对应一份由完整 SHA-256 标识的冻结候选包。[0.2.0 双宿主报告](docs/testing-report-0.2.0.md)只作为 `v0.2.0` 的历史证据保留。同名文件或相同版本号不等于同一份已测制品。安装时应选择目标源码修订自行构建，或使用明确发布且附有校验值的 Release 附件。

> **非官方社区项目。** 本插件是独立、社区维护的扩展，**与 DeepSeek 无隶属、背书或赞助关系**。"DeepSeek Harness"与"DSH"为其各自所有者的商标。插件使用官方公开服务与依赖；本插件的任何缺陷、安全问题或行为变更均由本仓库负责，与 DeepSeek 或 DSH 项目无关。

## 安全摘要

默认模式是 `workspace-write`。受限 WSL 的可写工作区根目录只能来自 DSH 的不可变 `sandboxPolicy.workspaceRoot`；WSL 的 `workdir` 只能选择该根目录内部的 cwd，不能扩大可写挂载。所有 WSL 模式都使用 bubblewrap（`bwrap`）和 `script`；缺少依赖或策略服务时直接失败关闭，禁止降级成宿主全权限。明确选择完全权限后，写入不再受工作区限制；此时 Git Bash 也可以使用经过路径检查的工作区外本地目录，选择目录本身不会授予权限。

受限 WSL 模式（`read-only` 与 `workspace-write`）会遮蔽 `/run` 中的 Windows interop broker，并清除 `WSL_INTEROP`/`WSLENV`，因此 WSL 不能通过该 broker 启动 Windows `.exe`（例如 `cmd.exe`）。`danger-full-access` 作为明确的显式选择，故意保留宿主 interop。这是针对 Windows interop 的边界，不是通用 IPC 或服务隔离；宿主允许时，仍可能通过可达的本地服务或网络路径执行写入。

所有 WSL Bash 入口都会在 Bash 有机会读取之前清除继承的启动控制变量，并在沙盒内明确建立可信的 `/bin/bash` Shell 身份。用户或父进程设置的 `BASH_ENV`、`ENV`、`SHELLOPTS`、`BASHOPTS` 不能在沙盒检查之前执行代码。

Git Bash restricted 模式失败关闭：被拒绝的命令启动零进程。一次性命令只在 `danger-full-access`，或宿主审批授予的一次精确重试中执行；持久 Git Bash 则必须使用当前会话明确选择的 `danger-full-access`，一次性审批不能授权整个持久 Shell。选择 Git Bash 模式不会自动升权，持久会话也不会原地改变权限。插件不提供网络隔离；宿主/后端允许时，命令可能访问网络。`doctor` 只读，绝不自动安装依赖。

持久 Git Bash 的命令直接在 Git Bash 中执行，不经过 PowerShell 或 WSL。插件使用一个小型宿主运行时助手统一回收终端及后台进程；它负责退出清理，不提供文件沙盒。缺少所需宿主运行库或 Windows 进程组能力时，启动失败，不转为无保护的执行方式。

## 安装要求

- Windows，并已安装 Git Bash 和 WSL；
- Node.js `>=22`；
- 桌面版或 CLI DSH `0.2.1-rc.2`；
- 所有 WSL 模式需要所选发行版内的 `bwrap`、`script` 与 `realpath`；
- Windows 集成测试需要可用的 Git Bash 可执行文件和 `wsl.exe`。

默认发行版为 `Ubuntu`。插件启动干净的 WSL Shell（`--noprofile --norc`）；只有宿主策略允许时才配置其他发行版或 Shell 参数。

## 安装插件

### 获取或构建安装包

Git 不包含 `dist/` 和生成的 TGZ。GitHub 源码 ZIP 不是可直接安装的 DSH 插件包；检出目录中遗留的旧同名 TGZ 也不能当成后续版本使用。

构建 `0.2.1` 源码需要 Windows Node.js `>=22`，以及 `package.json` 指定的 `pnpm@11.21.0`。克隆本仓库、选择要安装的源码修订后，在该检出目录中使用 Windows PowerShell 执行：

```powershell
pnpm install --frozen-lockfile
New-Item -ItemType Directory -Force -Path ".packages" | Out-Null
pnpm pack --pack-destination ".packages"
```

现有 `prepack` 会执行 `pnpm run build`，只清理和重建当前检出目录的 `dist/`；源码构建时不要省略开发依赖。生成的 `0.2.1` 安装包位于 `.packages/dsh-plugin-bash-wsl-0.2.1.tgz`，正式发布时应同时提供该包的校验值。这些是构建步骤，不代表新生成的包已经通过完整门禁。

`file:` 或 hoisted 本地安装得到的是部署副本或硬链接；即使当前检出目录完成 clean rebuild，profile 中已安装文件的 inode 也可能没有更新。因此，只重建或只重启不能证明宿主已加载新代码。必须把新 TGZ 重新安装到准确的目标或隔离 profile，核对运行时 `installAnchor`，并比较已安装 `dist` 与当前构建的哈希。`link:` 只适合经过明确核验的本地开发，不能充当发布证据。

开发可以使用 WSL 作为命令环境，但目标仍是 Windows DSH：从 WSL 工作时应调用 Windows 侧 Node/包管理工具，项目和产物保留在 Windows 盘，不要为本插件把 DSH 安装到 WSL。当前不承诺直接 Git URL 安装，请使用构建后的 TGZ。单独执行 `npm install` 安装依赖，不等于已经构建插件或注册到 DSH 配置。

### 安装到 Windows DSH

替换前先备份目标配置的清单、锁文件及本插件目录。给 Windows DSH 传入刚构建或下载的包的真实 Windows 绝对路径，不要传 `/mnt/c/...`。例如检出目录为 `C:\work\dsh-wsl-bash` 时，在 Windows PowerShell 中执行：

```powershell
Get-Command dsh
dsh plugin --profile web add "C:\work\dsh-wsl-bash\.packages\dsh-plugin-bash-wsl-0.2.1.tgz"
```

确认 `Get-Command dsh` 命中 Windows 安装入口。该命令针对其 `web` 配置；桌面版使用独立的 `desktop` 配置，请在 **设置 → 插件 → 添加插件** 中选择同一个 TGZ。装到 `web` 不等于装到桌面版。安装后重启对应宿主并新建会话。包元数据会加载 `cordis.patch.yml`；请保留已有 PowerShell bundle。最小隔离 headless 配置片段是：

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

安装并重启后，在 Web/桌面版新建对话时选择 **WSL 模式** 或 **Git Bash 模式**，`bash` 就使用对应环境并保持状态。Git Bash 模式下的受限调用会在启动前拒绝；只有确实适合完全权限时，才由用户通过宿主权限选择器明确选择。模式菜单与权限选择器是两件事，已有对话仍使用原来的工具组合。

无界面的 CLI 若要把持久 WSL 换为原生 Git Bash，需要同时覆盖后端与工具两行；不会修改宿主权限策略：

```yaml
- id: bash-wsl-native
  config:
    - id: bash-wsl-backend-and-tools
      config:
        persistentShell: git-bash
        backendType: git-bash
    - id: bash-wsl-persistent-tool
      config:
        backendType: git-bash
        description: Persistent native Git Bash; requires explicit full-access permission for this session.
```

一次性 `wsl_bash`/`git_bash` 调用需要 `command` 和 `description`；`description` 只用于 UI/日志，不影响执行。持久 `bash` 只需要 `command`，并保留按 Agent 隔离的状态。

`wsl_bash` 的 `workdir` 可用相对路径、Windows 驱动器路径或所选发行版中的等价 Linux 路径。生产运行时通过该发行版真实的 `wslpath` 与 `realpath` 解析，所以 automount 根目录不必固定为 `/mnt`。所有写法都必须解析到宿主指定的同一工作区内部，符号链接或 junction 逃逸仍会被拒绝。

`git_bash` 省略 `workdir` 时使用宿主提供的当前代理工作区，相对路径也从该工作区解析，不使用 DSH 进程目录。显式 Windows 路径仍经过原有路径检查。

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

持久 `bash` 按 Agent 所有权隔离：其他 Agent 不能列出、读取、发信号、写入或关闭该会话。两个受支持的官方版本都在超时或取消时重置并关闭该 Shell；下次调用新建干净 Shell。新版官方工具用 `stty -echo` 初始化、用逐命令标记读取输出；终端就绪由插件后端负责。底层 `startSend` 的中断行为不能当作保留会话的承诺。一次性工具的超时或取消则终止其受管进程树。

`git_bash` 用于原生 Git Bash 命令。restricted 模式下被拒绝的调用不会启动进程；通过宿主审批后只能用同一个 command/cwd 进行一次精确的更宽模式重试，不能静默替换命令或可写根目录。

新版受管管道不公开可验证的进程 ID 和 Linux 前台进程组。插件会省略这些信息，并拒绝无法验证目标的底层前台信号请求，不会伪造进程组；正常工具取消及 Shell 关闭、重置仍可用。

持久 `bash` 使用插件内固定版本的官方工具适配（`dsh-plugin-bash-wsl/persistent`）。后台输出挤掉最新页面中的结束标记时，它仍可从实际增量输出识别当前命令的完成结果；不会猜测退出码。备用输出缓冲上限为 256 KiB，默认展示上限仍为 16,000 字符。超时、取消优先于完成标记，不修改本机 DSH 安装文件；上游归属见 `NOTICE`。

## 随插件附带的系统提示词

启用插件时，它会通过官方 `systemPrompt` 服务自动附加一段系统级使用说明。两个新模式分别提供对应环境的说明，覆盖同名全局说明，不重复叠加；不改用户 `AGENTS.md`、原有预设或权限策略。

说明包含：默认使用持久 `bash` 做连续开发；WSL 执行不等于把项目搬进 Linux；一次性工具不共享状态；同一会话串行调用；超时、取消后重新确认目录并初始化状态；遵守审批、目录边界和进程归属。内容不含个人路径或账号信息，也不替用户授权命令。

实际随包文本可从 `dsh-plugin-bash-wsl/prompt` 或包根导出的 `BASH_WSL_SYSTEM_PROMPT`、`GIT_BASH_SYSTEM_PROMPT` 读取。注册时关闭模板插值，避免说明里的 Bash 变量被误解释。说明涵盖持久工具仅接受 `command`、非交互执行、输出不完整的判断、重置不回滚副作用、一次性审批与持久权限的区别，以及 WSL 不改变 Windows 构建目标。本机 `AGENTS.md` 的终端说明也应区分所选模式；插件自身不会改写该文件。所属插件组合卸载时移除对应说明；DSH 会为仍在运行的 Agent 保留旧模式组合，因此卸载前先停止会话，卸载后重启宿主。

## doctor

在安装插件的宿主上执行独立的只读 doctor：

```sh
dsh-bash-wsl doctor
```

独立命令使用默认值和环境变量，不解析配置补丁。它通过模块解析发现 DSH 包版本，该结果不代表实际运行的桌面/CLI 宿主；插件激活时会读取宿主提供的 `profileContext.installAnchor`，嵌入式 doctor 调用也可传入这个锚点。默认 Ubuntu 与 `C:\Windows\System32\wsl.exe`，支持 `DSH_WSL_DISTRO`、`DSH_WSL_PATH`、`DSH_GIT_BASH_PATH` 覆盖，目录映射默认当前目录。检查版本、工具、依赖和路径；不会下载、安装、修改 PATH/配置或升权。

## 卸载

先停止所有持久会话。Windows CLI 的 `web` 安装只从同一个配置移除本插件：

```sh
dsh plugin --profile web remove dsh-plugin-bash-wsl
```

桌面版请通过桌面版插件管理移除，不能用 CLI 的 `web` 配置代替；随后重启对应宿主。卸载不会删除 WSL 发行版、Git Bash、用户文件、工作区数据或保留的 `pwsh` 插件。删除检出目录或 tarball 前，请核查插件进程已无残留。

## 兼容性与故障排查

| 现象 | 检查 |
| --- | --- |
| 插件不加载 | 确认插件为 `0.2.1`、Node `>=22`，实际宿主为 `0.2.1-rc.2`；不要忽略版本检查。 |
| CLI 可用但桌面版没有 | `web` 与 `desktop` 配置独立，确认真正运行的宿主加载了目标配置，安装后重启对应宿主。 |
| `workspace-write` 不可用 | 运行 `doctor`；由宿主的正常系统流程安装 `bwrap`/`script` 后重启 DSH。插件不会降级到不受限执行。 |
| 空格或中文路径失败 | 一次性工具可传 `workdir`；持久 `bash` 只接受 `command`，应在命令中使用正确引用的 `cd`，并遵守对应工作区边界。 |
| WSL 的外部 `workdir` 被拒绝 | 这是预期行为。WSL `workdir` 只是 cwd，不能扩大不可变可写根。 |
| Git Bash 被拒绝且零进程 | restricted 模式的预期结果。为同一精确重试取得宿主审批，不要换命令重试。 |
| 持久 Git Bash 被拒绝 | 当前会话需要明确选择 `danger-full-access`。一次性审批不授权持久 Shell；选择 Git Bash 模式不会自动提升权限。 |
| 没有两个新模式 | 确认实际运行的 Web/桌面配置加载了新包并已重启；无界面的 CLI 没有模式菜单。 |
| 受限 WSL 中 Windows `.exe`/`cmd.exe` 失败 | 这是预期行为：受限模式隐藏 `/run` interop broker，并清除 `WSL_INTEROP`/`WSLENV`。请使用原生宿主工具；只有在接受宿主 interop 风险时，才使用经过明确审批的 `danger-full-access`。这不是通用 IPC 或网络边界。 |
| 持久状态消失 | 使用 `bash` 而不是 `wsl_bash`，并确认会话属于当前 Agent。持久会话是干净 Shell，不继承无关宿主 Shell 状态。 |
| 命令可以联网 | 这是已披露限制。插件不隔离网络；需要隔离时请使用宿主/网络策略。 |

发布候选版本在源码目录运行 `node scripts/release-check.mjs`，并保留独立的 CLI 和桌面测试报告。类型检查、单元测试和包检查不能代替实际桌面运行时验证；跳过不等于通过。新增验证代码及可复用夹具放在 `dev/测试`，临时运行数据仍放在 `测试/运行产物`；上游快照和运行产物不能进入 Git 或安装包。测试不发布、推送或修改真实用户配置。

## 许可证与归属

本包采用 MIT 许可证。复制或改编代码时必须保留原始版权与许可证声明，并在 `SECURITY.md` 或对应源文件注明借鉴内容。设计借鉴官方 DSH `rc.6` contract；适配的 terminal state-machine material 已在 `SECURITY.md` 与 `NOTICE` 标明，不暗示存在其他审计项目。

参见 [SECURITY.md](SECURITY.md)、[CONTRIBUTING.md](CONTRIBUTING.md) 与 [CHANGELOG.md](CHANGELOG.md)。
