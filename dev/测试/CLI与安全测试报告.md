# CLI 与安全测试报告

> 历史记录：本文保留当时的源码路径、产物位置、哈希及结论。公开测试源码现迁至 `dev/测试/`，本机产物仍在根目录 `测试/运行产物/`；本次目录整理未重新运行测试或门禁，旧 PASS 不覆盖迁移后的源码。

## 当前阶段

本报告是插件 `dsh-plugin-bash-wsl@0.2.0` 在 Windows CLI
`@deepseek-ai/dsh@0.2.1-alpha.1` 上的最终本机证据。测试只使用
`测试/运行产物/<run>` 下的自有临时 profile、workspace、相邻 fixture、marker、日志和
JSON；不调用收费模型、公网业务、真实用户 profile 或硬件。Desktop `0.2.0-rc.2` 复用
同一 probe 契约，但其桌面运行时结论由桌面报告单独负责。

最终验证 TGZ：`测试/运行产物/windows-canonical-pack-20261010/dsh-plugin-bash-wsl-0.2.0.tgz`
（90,089 bytes），SHA-256
`9cb01907dd7a9558255b6b8d5fe5ef03349927711fef0aadf9456656fe2b6f63`。
所有本轮 wrapper 均通过 `wslpath -w` 生成 Windows 绝对路径并经 `WSLENV=DSH_PLUGIN_TGZ/w`
显式指向该 TGZ；checkout 根目录已同步 canonical `9cb01907...`，旧 `ab303cd4...` 仅保留
在 `old-root-candidate` 历史副本中，不参与本节结果。
最终 CLI package SHA-256 为
`dbb4a7c1d88c412278fc8baccac7553f6d2310e85f5ffea1470a30106e99c688`；source 与
isolated profile installed `dist` SHA-256 均为
`155acd477fdbdc1370d8735356afd5b28585bef22d9f7a1f1b7b2bfc7422929b`，
`distHashesMatch=true`。
本轮 shared probe source/installed `index.mjs` SHA-256 均为
`ddfc1cc42b7861bc3cf64398968007afd0a63b73da1fd927a13ebf0051ace1e3`，
`probeIndexHashesMatch=true`。
本轮 harness source SHA-256 为
`b24b7f9c2cf83c54bea5a71283955956b29b5b383a7b9a0ad4e9b0decc746468`。

## 最终证据（UTC 2026-10-10；Asia/Shanghai）

- `cli-integration-1791645362383.json`：7 个 top-level checks 全部 PASS；真实 Windows CLI
  profile setup/dump、integration probe、probe 卸载/重装/新进程 reload 均 exit 0、
  close/reaped，process cwd 与 agent workspace 刻意分离。
- `cli-security-1791645455114.json`：read-only、workspace-write、danger-full-access
  三 mode 均 PASS；每 mode 18/18 probe checks PASS，无 SKIP/FAIL，child 均 exit 0、
  未超时、close/reaped、error=null。
- `smoke-integration-1791645503455.json`：1 wrapper check PASS，nested probe 15/15
  PASS；process cwd 分离、hash/cleanup 均通过。
- `smoke-security-1791645599289.json`：三 mode 均 PASS；每 mode 18/18 probe checks
  PASS，child exit 0、未超时、close/reaped、error=null。
- `cli-git-workdir-1791645284770.json`：CLI-13 窄回归 PASS；真实 actual process.cwd()
  与 agent workspace 不同，omitted/relative/explicit absolute Git Bash cwd 均落在
  agent workspace；forwarding spy positive control exit 0 且 spawn delta=1，UNC/device
  各拒绝且 spawn delta=0。
- `cli-output-cap-1791645613501.json`：CLI-OUTPUT-CAP-01 PASS；registered `wsl_bash`、
  `git_bash` stdout 以及独立 `git_bash` stderr malformed UTF-8 fixture 均 raw 4 bytes、
  cap=4、`truncated=true`、visibleBytes=3、replacementCount=1、exit 0；WSL stderr
  因 PTY/script 可能合流而明确未独立断言。

以上 fresh JSON 均无 SKIP 或 FAIL；每个 wrapper 的 `temporaryRootRemoved=true`，实际
Windows CLI 为 `@deepseek-ai/dsh@0.2.1-alpha.1`，WSL 版本输出按 UTF-16LE 正确解码。

## 旧候选包窄诊断：Git Bash workdir（非最终 gate）

为定位 registered git_bash 的 cwd 归属，使用实际 Windows CLI
0.2.1-alpha.1、自有隔离 profile 和旧候选 TGZ
ab303cd4f86bf5118b0ddb2d626976e75cebd0e8442c98a8d8099246010ceeef，
运行 测试/CLI/cli-git-workdir.mjs。该诊断不代表新包或发布证据。

证据文件：测试/运行产物/cli-git-workdir-1791640399794.json。

本次诊断写入阶段的测试文件 SHA-256 为：probe-package/index.mjs
db00b729226d9bb71b88cae4343e666030813c17ffda0ad93535a9d196a8600f，
test-harness.mjs 97e6a0fa30f411af39cb764b5ec545f358c5cab265f6a6636f5f0b98650b20ed，
cli-git-workdir.mjs fb683b5c0f6b204029e4273c422eb217b0a530d30cc67d4de403adb2ce47cdf5。
这组 hash 只对应本窄诊断，不是 Desktop 最终 freeze hash。

- CLI-01 通过：真实 bash、wsl_bash、git_bash 均在官方 tools registry
  可见；CLI 版本为 0.2.1-alpha.1。
- agent.session.header.cwd 为 workspace：
  ...\cli-git-workdir-6inijd\workspace 中文 space；CLI 子进程 cwd 刻意设置为不同的
  ...\cli-git-workdir-6inijd\host process cwd 中文 space，
  processCwdDistinctFromWorkspace=true。
- 省略 workdir：期望 Git Bash cwd 为 workspace；实际
  pwd/pwd -W 均为 host process cwd。
- 相对 workdir=git-relative-child 中文 space：期望解析为
  workspace 中文 space\git-relative-child 中文 space；实际解析为
  host process cwd 中文 space\git-relative-child 中文 space。
- 因两项断言均失败，probe status 为 FAIL；这不是测试误报：
  exitCode=0、实际输出明确包含 host cwd，且 sourceDistSha256 与
  installedDistSha256 相同，probeSourceIndexSha256 与
  probeInstalledIndexSha256 相同。
- 外部副作用检查：CLI child closeObserved=true、reaped=true、
  timedOut=false、error=null；temporaryRootRemoved=true。未写入真实 profile，
  未调用模型/网络，未留下测试目录或进程。

该结果只说明旧候选包的 registered git_bash 在此真实 alpha1 宿主上按 host
process cwd 解析省略/相对路径；新 core、新 probe 和新 TGZ 冻结后必须重新执行，
不能把本节当作新版最终 gate。

## 上一代 04ad cohort（历史，不是 canonical final）

此前使用 90,090B TGZ `04ad399d67e34842d96f466007437dab8b24d88bf2c16d4317730815ba97b0e1`
和 c624 probe 的 JSON、cwd/cap 结果保留在 `测试/运行产物`，仅用于比较测试代际；本报告
当前最终结论只引用下方 90,089B Windows canonical TGZ `9cb01907...` 与 ddfc/b24
shared test bundle，不将 04ad raw SHA 混入 canonical matrix。

## 本轮测试代码与最终运行状态

父方修复生产核心后，本测试代理新增并维护两类真实 CLI 门禁，并已使用本节明确的新 TGZ 与 ddfc probe
完成真实 Windows CLI 窄回归和完整矩阵：

- CLI-13：常规 integration 将 CLI 子进程 cwd 与 agent workspace 分离；probe
  通过真实 sandboxPolicy.resolve({session}) 记录并核对 workspaceRoot，验证
  registered git_bash 的省略、相对、显式绝对 workdir，以及 UNC/device namespace
  在 spawn 前拒绝。smoke integration 使用同一正向 cwd 分离控制。
- CLI-OUTPUT-CAP-01：独立 owned profile overlay 将
  oneShotMaxOutputBytes=4、oneShotMaxSpillBytes=8，仅用于测试；通过真实注册的
  wsl_bash 与 git_bash 输出 4 个 0xff 字节，要求 stdout.truncated=true 且可见
  UTF-8 字节不超过 4；另以 registered git_bash 独立断言 stderr 同样 cap/truncated。
  WSL stderr 因 PTY/script 合流风险未独立断言。生产默认值未改动。

当前测试代码 SHA-256：test-harness.mjs
b24b7f9c2cf83c54bea5a71283955956b29b5b383a7b9a0ad4e9b0decc746468；
probe-package/index.mjs
ddfc1cc42b7861bc3cf64398968007afd0a63b73da1fd927a13ebf0051ace1e3；
cli-integration.mjs
919a98921b080d32df0378a321af4976cb1cdeb53d1ff5ca740949bb4adf908f；
cli-output-cap.mjs
4028bc4078ecbb326233c15df7d2cb7739b2ab74f53940a87ec467ce42c080b1；
cli-git-workdir.mjs
1938275b19661eecc1294adc1aac496b79d3bdc3bc1d81c005b75f8e3d16dab5；
smoke/integration.mjs
395ec3cebe72234df370b3bdb6f9ab4630a6ec16e1d0304f3b7a911f68cb9e42；
cli-security.mjs
a83b3f2132b1acb371a368e6fcb9f61fbda8552418a9a11f8b8bec479eea50ce；
smoke/security-probe.mjs
f1d992d6a1f53e558168b46003c1c07f79d5b182e1be59dc5dccc639fe7e8756。

最终冻结给 Desktop owner 的 shared probe 文件 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `测试/CLI/probe-package/index.mjs` | `ddfc1cc42b7861bc3cf64398968007afd0a63b73da1fd927a13ebf0051ace1e3` |
| `测试/CLI/test-harness.mjs` | `b24b7f9c2cf83c54bea5a71283955956b29b5b383a7b9a0ad4e9b0decc746468` |
| `测试/CLI/cli-integration.mjs` | `919a98921b080d32df0378a321af4976cb1cdeb53d1ff5ca740949bb4adf908f` |
| `测试/CLI/cli-security.mjs` | `a83b3f2132b1acb371a368e6fcb9f61fbda8552418a9a11f8b8bec479eea50ce` |
| `smoke/integration.mjs` | `395ec3cebe72234df370b3bdb6f9ab4630a6ec16e1d0304f3b7a911f68cb9e42` |
| `smoke/security-probe.mjs` | `f1d992d6a1f53e558168b46003c1c07f79d5b182e1be59dc5dccc639fe7e8756` |

Required final check IDs for the same frozen bundle: `CLI-01`–`CLI-13` (including
CLI-02/CLI-10/CLI-11/CLI-12 and the registered Git cwd regression), `CLI-OUTPUT-CAP-01`,
`SEC-01`–`SEC-16` (including official SEC-06 and SEC-15/16),
`CLI-INT-01`–`CLI-INT-04`, `SMOKE-CLI-01`, and `SMOKE-SEC-read-only` /
`SMOKE-SEC-workspace-write` / `SMOKE-SEC-danger-full-access`.

## 可复现命令

从 WSL 执行 Windows Node，并显式指定本轮 Windows TGZ（不要使用 checkout 根目录的旧 baseline）：

```sh
PLUGIN_CHECKOUT="<plugin-checkout>"
cd "$PLUGIN_CHECKOUT"
WINNODE="/mnt/c/Program Files/nodejs/node.exe"
TGZ_RELATIVE='测试/运行产物/windows-canonical-pack-20261010/dsh-plugin-bash-wsl-0.2.0.tgz'
export WSLENV="${WSLENV:+$WSLENV:}DSH_PLUGIN_TGZ/w"
export DSH_PLUGIN_TGZ="$(wslpath -w "$PLUGIN_CHECKOUT/$TGZ_RELATIVE")"
"$WINNODE" "测试/CLI/cli-integration.mjs"
"$WINNODE" "测试/CLI/cli-security.mjs"
"$WINNODE" "smoke/integration.mjs"
"$WINNODE" "smoke/security-probe.mjs"
```

脚本通过实际 Windows CLI manifest、profile bundle 和 `ctx.tools.execute` 读取官方
入口；smoke 只委托真实 CLI 隔离 profile 与 probe bundle，不复制 persistent 协议、
registry 或 backend 假实现。所有 `.mjs` 均已通过 Windows Node `--check`。

## 集成矩阵

| ID | 实际断言 | 最终结果 |
| --- | --- | --- |
| CLI-SETUP-01/02/03 | 隔离 profile 安装本地 0.2.0 TGZ 与 probe；`--dump-config` 显示插件、terminal、persistent bash、approval、subprocess、sandbox-policy、pwsh | PASS |
| CLI-01 | 官方 services、alpha1 install anchor、`bash`/`wsl_bash`/`git_bash` 与 WSL backend 注册 | PASS |
| CLI-02 | 同一官方 Agent 的中文/空格 child cwd、变量、函数、40x160 PTY 跨调用保留；第一调用创建自有 `$!` sleep，第二调用 `kill -0`/`jobs -p` 验证仍活，随后显式 `kill`/`wait` | PASS |
| CLI-03/04 | 官方 WSL 与 Git Bash one-shot 在中文/空格 cwd 输出 UTF-8/cwd；SEAM 入口也实际执行 | PASS |
| CLI-05/06 | 官方 persistent 取消后无 leak 且下一 bash clean；并发调用按官方队列串行 | PASS |
| CLI-07/08/09 | 保留 pwsh；doctor 前后 profile manifest hash 不变；初始化取消发送零命令 | PASS |
| CLI-10 | isolated profile-level `cordis.patch.yml` 仅把 persistent timeout 调为 10000ms；ready 后真实 timeout、后台 marker 不存在，`hasOwnerActivity=false`/owner list 空，下一 bash clean cwd/env；自然 `exit` 同样 close/await 后 list 空并恢复干净 shell | PASS |
| CLI-12 | 官方 persistent `yes X | head -c 20000` 明确 clipped；payload 16000 bytes、X 计数 8000、visible 16442，下一调用仍可用 | PASS |
| CLI-13 | process cwd 与 agent workspace 分离；registered Git Bash omitted/relative/explicit absolute cwd 归属 agent workspace；positive spy delta=1，UNC/device 拒绝且 delta=0 | PASS |
| CLI-OUTPUT-CAP-01 | owned cap=4/8 下 registered wsl_bash/git_bash stdout 与 Git Bash stderr malformed UTF-8 均 truncated=true、visibleBytes=3、exit 0 | PASS |
| CLI-INT-01/02/03/04 | 真实 CLI probe、隔离 profile 探针卸载/重装、新 CLI 进程重载 | PASS |

timeout override 只写每次测试自有 profile 的 profile-level patch，并补全
`backendType: wsl`；没有写 TGZ、source patch、global pnpm store、ASAR 或真实 profile。

## 安全矩阵（每个 mode 均实际执行）

| ID | 实际断言 | 最终结果 |
| --- | --- | --- |
| SEC-01 | WSL/Ubuntu/bwrap/script readiness 真实通过 | PASS |
| SEC-02/03 | read-only 拒绝 workspace 与相邻 external 写；workspace-write 仅允许 workspace；full-access 允许明确外部正向 fixture | PASS |
| SEC-04 | full-access CMD 正向 marker 先成功；受限 mode `cmd.exe` 拒绝且 marker 不存在，不把 `cannot execute/not found` 误记 capability SKIP | PASS |
| SEC-05 | Windows junction/WSL symlink 越界写在受限 mode 拒绝；full-access 结果单独记录 | PASS |
| SEC-06 | 低层 execute seam 对 outside/UNC/device/drive/`..` 记录 command spawn 0；官方 `ctx.tools.execute({name:"wsl_bash"})` 证明同一中文/空格 cwd 的 Windows path 与 `/mnt/c` path 等价，invalid outside/different-drive/UNC/device 每项 command spawn 0 | PASS |
| SEC-07/08 | restricted Git Bash、inexact retry、官方 approval `never → rejected` 与 `ask → unavailable` 均 zero-spawn，并有审计事件对 | PASS |
| SEC-09 | 缺 bwrap/script preflight fail-closed，不进入 bwrap command | PASS |
| SEC-10/11 | one-shot timeout/cancel 均先 bounded stdout readiness，再 `waitForExit()===true`、managed quiescent/tree reaped；read-only cancellation 不以 marker 不可写为 SKIP | PASS |
| SEC-12 | 低 cap 真实输出 `truncated=true`，total cursor 保留，visible UTF-8 bytes 明确 `<=1024` | PASS |
| SEC-13 | A 对 B 的 startSend/read/signal/close 全部 `FOREIGN_SESSION`；A list 隐藏 B；A dispose 后 B 存活；B natural exit 后显式 close/await，`hasOwnerActivity=false` 且 list 空 | PASS |
| SEC-14 | live persistent terminal 时 sandbox mode mutation 被拒绝且 session log 不变；close 后允许 | PASS |
| SEC-15 | Bash 命令/description 特殊字符按单一 encoded argv 传递，literal 输出保持 | PASS |
| SEC-16 | Git Bash timeout/cancel 真实 ready barrier、受管 spawn 与 wait/reaping | PASS |

## 证据与清理边界

- 每个 final JSON 的 `temporaryRootRemoved=true`；CLI wrapper 同时记录 `exitCode`、
  `timedOut`、`closeObserved/reaped` 与 error 字段，只有全组正常才 PASS。Windows
  child 的 `closeObserved/reaped` 仅证明宿主 child 已关闭，不单独冒充整棵树回收；WSL/
  Git Bash 的 managed handles 另行实际 `waitForExit()`，并记录 managed quiescent/tree
  reaped；persistent owner/session 均 dispose/close。最终 CLI 自有进程扫描为 0。
- 本轮 `cli-integration-1791645362383`、`cli-security-1791645455114`、cwd/cap 窄回归和
  smoke 根均由 harness 在 `realpath` containment 后精确清理；fresh JSON 的
  `cleanup.temporaryRootRemoved=true`。没有递归删除整个 `测试/运行产物`，JSON/log/
  dependency 证据和非本任务文件保留。最终 CLI 自有子进程无残留；其他 Desktop owner
  的进程/目录未被终止或删除。
- harness timeout cleanup 只对本次 spawn 返回的 owned `ChildProcess` 调用 `kill()`；不再
  对可能已退出或 PID 已复用的进程盲目执行 `taskkill /PID /T /F`。若 close 未在 bounded
  fallback 内到达，证据明确为 `reaped=false`/FAIL，并由人工核对 owned 测试根进程。
- `DSH_HOME`、`TEMP`、`TMP`、profile、marker 和日志均在测试运行产物根内；harness 为
  Windows runtime/cache discovery 保留 `HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA`
  的只读主机值，并以 isolated `NPM_CONFIG_USERCONFIG` 禁止读取 provider/凭据配置，
  不声称这些四个 discovery 变量被重定向。未输出 token、密码、API key、真实用户
  profile 内容或完整环境。
- `danger-full-access` 成功只证明显式全权限语义，不替代受限安全断言；Desktop 视觉/rc2
  运行时结论必须引用桌面报告，不能由本 CLI 报告越界概括。
