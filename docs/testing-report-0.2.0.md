# 0.2.0 双宿主测试报告（历史冻结快照）

> 目录整理说明：公开测试源码现位于 `dev/测试/`，原始运行产物仍位于已忽略的 `测试/运行产物/`。下文的旧源码路径、哈希及结论按当时记录保留，不自动覆盖迁移后的源码；本次目录整理没有重新执行测试、构建、打包或门禁。

日期：2026-10-16。本文记录本地交付资格，不代表已推送、公开发布或安装到真实配置。测试代码和执行由 GPT-5.6 Luna / Max 子智能体负责，维护者负责核心实现、原始证据审核和本地 Git 记录。

> 范围说明（2026-10-17）：下述 `43 PASS / 0 SKIP / 0 FAIL` 仅属于本文记录的历史候选 TGZ（125232 字节，SHA-256 `99aa538370cea3af867ec0de5878a1206966ef60e44b9c3d19843a39dbbc3d33`），不是对所有名为 `0.2.0` 的包或当前分支的总体验收。之后的提示词及公开文档修订不在该冻结候选内，本次文档整理没有重跑门禁。GitHub 源码推送、后续本机安装及 npm 发布是各自独立的动作；本报告保留当时事实、哈希和失败记录，不追溯改写。

## 范围与当时结论

- 目标是 Windows CLI `0.2.1-alpha.1` 和实际安装的 Desktop `0.2.0-rc.2`，共用一个安装包；不是把 DSH 安装到 WSL。
- 新增 `bash-wsl`、`bash-git-bash` 两个 Standard 扩展模式。前者使用持久 WSL，后者使用持久原生 Git Bash；均保留一次性 WSL、Git Bash、官方 PowerShell 和其他 Standard 能力。模式选择不提升权限。
- 持久 Git Bash 按已确认的备用方案要求会话明确具有完全权限；当前 Windows/MSYS 受限启动失败，不能声称它具有与 WSL 相同的文件沙盒。
- CLI、Desktop 后台运行时、安全、离线合同和安装包已有实际验证。最终完整门禁为 `43 PASS / 0 SKIP / 0 FAIL`，实际进程退出码 `0`；包含独立双模式 GUI roster 和 D16。历史门禁失败、能力 SKIP 和两次未可靠捕获退出码的运行全部保留，不追溯改绿。
- 菜单证据显示原有四个模式及新增的 WSL、Git Bash 两个独立模式；两种模式均已有真实工具结果、人工界面观察、正常托盘退出和独立清理证据。Git 原始脚本的取证时序 FAIL 保留，通过限定缺陷、重新读取五份原始证据的严格资格补证，不把模型自述或原始 FAIL 本身当作 PASS。交付仅在本地维护 Git，不推送、不发布、不安装到真实配置。

## 冻结身份

| 对象 | SHA-256 / 版本 |
| --- | --- |
| 候选 TGZ（125232 字节） | `99aa538370cea3af867ec0de5878a1206966ef60e44b9c3d19843a39dbbc3d33` |
| CLI 安装清单 | `dbb4a7c1d88c412278fc8baccac7553f6d2310e85f5ffea1470a30106e99c688` |
| Desktop ASAR | `983ca71114e6dfd353fc79af5a1f9481a250ee64c2a3c757673029b811b23bc2` |
| Desktop EXE | `df4e91fd91f6f1bee19a1990b0e167bfe06abf8353279d82bbb8e60edb6ba0d3` |
| 持久终端核心 `src/terminal/session.ts` | `9a1bd3b5791e9c8d93002471adaf5ae0146485dafbb1a9f2ddccd2d2accbd088` |
| Git 后端 `src/git/backend.ts` | `31308eb0bf1427b05f4fbbbc1262f2432dad99c73d2017f0db19c1d9f7bb41e9` |
| 公共 CLI/Desktop probe | `24e8ac65a9902694aeda4bd83555dd3706665bc6be810c4177f9c0185df21b5b` |
| Windows 进程观察器 | `14045a64869a18d3fdba4e9bac2d7229a8a938aff6160a298872bd7f804bb67e` |
| 新模式独立 Desktop probe | `e472449487f00b02fe4538f75bbd40d5ddf0d0ddc1bf431d44a654983e03d6bb` |
| 最终发布门禁 | `e268d7b96e7d44ee045f2f1a49e4429dfd4142e0e99baee67c36edb655975da6` |

外部执行器是 Windows Node `24.13.1`；实际 Desktop bundled Node 是 `24.21.0`，其运行时描述另标 `24.18.1`，两者分别记录，不伪造为一致。所有版本均满足插件的 Node `>=22` 要求。

## 当时完整门禁

状态：**完整本地发布资格 PASS**。最终 R03 使用实际 Windows Node 执行未改动的正式门禁，`automated` 为 `42 PASS / 0 SKIP / 0 FAIL`，加 D16 后总计 `43 PASS / 0 SKIP / 0 FAIL`。直接取得子进程 `status=0`、`signal=null`、`error=null`，不是从日志或进程消失推断退出码。

最终记录写入时间为 `2026-10-15T18:21:33.179Z`（北京时间 10 月 16 日 02:21:33）：

| 文件 | SHA-256 / 结果 |
| --- | --- |
| `release-check-full-gui-r03-20261016-021229.json` | `2f0ecb53a9eddd7808f7bed76d22a0a43c906197427b3e8681e69f3548807281`；实际退出码 0 |
| `release-check-full-gui-r03-20261016-021229.stdout.log` | `9d61cd2aca737ec7e480919a29a143c3ed1a33689b31dacad12ba771ba53b45c`；7292 字节 |
| `release-check-full-gui-r03-20261016-021229.stderr.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`；0 字节 |
| `release-check-recorder-selftest-20261016-021229.json` | `7bedf942e27be1719294ca9f776b2604697ffd386ee6ec798450968a105a39cf`；预设非零退出码 7 被准确保存 |

记录器使用 `spawnSync` 返回的实际状态，stdin 关闭，stdout/stderr 分别写入唯一文件并在 finally 关闭句柄；其源 SHA 为 `0ce94537cbe10bf3266419b180b03ed2e99976f764ea4af050df3e415d5b30c7`。固定 15 项指纹在执行前后完全相同：web/desktop 各自的 package、pnpm-lock、cordis patch，以及门禁、候选、CLI/GUI 证据、pack CLI、ASAR、EXE、Windows Node。原本不存在的 desktop 锁文件仍不存在。这只证明上述明确文件的存在状态及内容未变，不宣称所有应用缓存或日志均无变化。门禁的临时配置 TGZ 安装是隔离、离线流程，不是向真实 profile 安装。

### 历史运行与门禁修正

恢复 GUI 之前的非 GUI 门禁为 `40 PASS / 2 GUI SKIP / 0 FAIL`，退出码 `1`。其中 automated 为 `40 PASS / 1 GUI roster SKIP / 0 FAIL`；另一个 SKIP 是 D16。当时的 BLOCKED 和 SKIP 原样保留，后续真实 GUI 验收才补齐资格。

门禁从 `2026-10-14 18:03:18 UTC` 运行至 `18:10:59 UTC`。stdout `release-check-nongui-20261015-1792000990296.stdout.log` 的 SHA 是 `d1b9d162a0f2a9c7c326a036f697b3cd6a686f22c65ccbdc3222c79bdf852638`；stderr 为 0 字节。隔离安装、配置导出、CLI 入口、实际 Desktop、D-14、安全/集成/限额、构建、制品和来源绑定均通过。最终重打包与候选逐字节一致，仍为上表的 `99aa…`。

当时未提供 GUI roster 和 D16 输入是明确延期，不是缺少登录就可以自动通过。该次门禁的非零退出和 `BLOCKED` 状态保留，不用最终 PASS 覆盖它。

首次门禁的实际结果为 `39 PASS / 2 FAIL / 2 SKIP`、退出码 `1`：

- CLI malformed UTF-8 原始四路工具结果通过，但门禁错误地从 suite 对象直接提取 cap 数据。现改为唯一精确 dedicated case、内层 `PASS` 和原有严格字节断言；重复、错 ID、缺失、SKIP/FAIL 和坏字节结果仍拒绝。
- 实际 CLI 配置导出含 `name: dsh-plugin-bash-wsl/persistent`，门禁却要求单引号。现只接受同一完整名称的普通、单引号或双引号 YAML 拼写；缺失、近似名称、坏引号、注释和跨字段文本仍拒绝。原 PowerShell 和 Windows Bash 守卫检查不变。
- 两个 SKIP 是独立真实 GUI roster 与完整 GUI D16。它们仍不计为通过。

首次原始 stdout：`release-check-nongui-20261015-1791999811532.stdout.log`，SHA `a20225b311382e097cf1ac16d793d04a29122f644a1b45043da79c647c64f92e`。真实隔离配置导出复现：`dump-diagnosis-20261015-1792000612194.dump.stdout.log`，SHA `7ec5230072044fc3aa1902b6962f9c7672af5676bee1aa463305e72dc2b7d0ac`。这些失败和诊断均保留；不会追溯改为 PASS。

首次完整 GUI 门禁 stdout 已为 43/0/0，但执行器没有保存实际退出码；其收据 `release-check-full-gui-receipt-20261016.json` / `91cb5aff3746337aa003ba41b4467752e70bfb62152fc42072bb6b13761afe15` 明确记录 `exitCode=null`。R02 同样输出 43/0/0，固定 15 项指纹一致，但排在终端后的退出码记录语句被继承的 stdin 吞掉；收据 `release-check-full-gui-r02-20261016-015703-15580.json` / `b0296fce2d5fb6c692730afb69c4f8f8cea432971169eb83c949a04f95a4b30d` 保留 `EXIT_CODE_UNAVAILABLE_AFTER_SINGLE_RUN`。两轮均不单独授权最终标签。R03 改为上述直接进程记录方式，未增加测试项、修改插件或重做 GUI/模型请求。

## 已完成的独立运行证据

下表的原始文件保存在本地 `测试/运行产物`，不提交、不进入 TGZ。旧工具版、旧 probe 或旧候选的报告不能替换这些身份绑定。

| 项目 | 实际结果 | 原始文件 / SHA-256 |
| --- | --- | --- |
| 全量 Windows 单元测试 | 35 文件、291 PASS、0 FAIL、无 SKIP；原始完整日志另行捕获 | `vitest-full-20261015-1792001489622.stdout.log` / `78d86104a0537944728db374496e0f96721f83d47b39c3e831fa60cd29d05dcb` |
| 类型检查与最终完整门禁 | typecheck 退出 0；43 PASS、0 SKIP、0 FAIL，实际退出 0 | `release-check-full-gui-r03-20261016-021229.json` / `2f0ecb53a9eddd7808f7bed76d22a0a43c906197427b3e8681e69f3548807281` |
| CLI 双后端持久终端 | WSL 9 项、Git 12 项 PASS，无必需项跳过 | `cli-native-modes-1791996406632.json` / `b51a7f7997c2c990dbf6a34914a2e39739165ee25e8e8673145492ea1f783df1` |
| CLI 集成 | 实际 mounted Host 的 15 个规定 case 全部 PASS，包括工具执行和 helper seams | `smoke-integration-1792001139724.json` / `cd112a27eccde34d59ea8181af213e3bc34067dad77a6b774124c2902a8a980a` |
| CLI 安全矩阵 | read-only、workspace-write、full 三权限下所有要求的 SEC-01..16 PASS | `smoke-security-1792001094535.json` / `ecd38160e370c0697bf6ab725019510cb0969ec18e4d5df14ed737665914169f` |
| CLI 一次性输出限额 | WSL stdout、合并程序 stderr、Git stdout、Git stderr 四路 PASS | `cli-output-cap-1792001146024.json` / `1481d1aee82f29974d4d3582010dc0dac30ccac3339b47f7b9d13be5eb1310f7` |
| Desktop 独立新模式后台 | 10 顶层检查 PASS；disabled-before / enabled-retained / disabled-after 全周期 | `new-modes-desktop-evidence-20261014181054.json` / `f441d3ec3f60aa9a3f13189f33ef78b446e3057de0c2dd215ac83f40c61d7bd0` |
| Desktop 基础、安全和集成 | 157 PASS、0 FAIL、0 SKIP，包含实际权限与 Standard mount | `desktop-evidence-20261014180838.json` / `19511295ecfa91571b4f2cbae045b5b0d7623b7ffee446a4c4058f2f6992365b` |
| Desktop 一次性输出限额 | 20 PASS、0 FAIL、2 不适用 SKIP；专门四路限额检查 PASS | `desktop-evidence-20261014180847.json` / `30197c99a8884ca766cc4cf834a4c7370f9813e163b9ed3a00a0a0be6451e25a` |
| D-14 旧版拒绝 | 实际 rc.2 loader 和独立 Host 均 PASS；旧工具、提示词和 schema 不存在 | `d14-runtime-negative-loader-20261014180552-7504.json` / `02c6ec8e4892246d4baffa553469ca4a6f5e1365edb3e4d349d24661b2a40894` |
| Windows FS 程序发现补证 | 14 PASS、0 FAIL、1 能力 SKIP；整体 SKIP，不冒充 DSH E2E | `git-discovery-windows-fs-1792002755598-21772.json` / `8fe450079545d48e24683b84c7a840246c75d303298ce27274cc13caf27d8176` |

离线资格验证器使用明确标为 synthetic 的自包含 fixture，只验证门禁合同，不作为真实宿主验收。native validator 61、最终 GUI validator 57、Git 正常退出补证 helper 38、聚合器 2 均通过；driver 观察期修正的两文件定向回归为 28 PASS。输出限额原有 13 个断言及本轮新增 12 个 CLI DTO 正反例通过。协议、PTY 故障、observer、query、identity、pack CLI、cancel 等现有离线合同也在正式门禁内执行。

此前独立 Desktop cap 的 `22 PASS / 2 SKIP` 报告仍保留。本轮门禁 cap 是 `20 PASS / 2 SKIP`，区别是未单独增加两条 approval-variant 诊断标签；不是删除输出限额断言，实际审批能力在 157 项基础矩阵另行覆盖。cap 子进程因两个不适用项返回 `1` 如实记录，未伪写为 `0`；专门 cap 资格只在来源/字节和正常 close/reap 清理均满足时通过。

补充 FS 脚本最后增加了错误宿主提前拒绝：WSL Node 运行时退出 `1`，在 Windows 路径计算和测试文件操作前停止，根目录/报告列表前后相同；Windows Node 随后实际复验为上表的 14 PASS/1 SKIP。脚本 SHA 为 `030b6211332ced9e8a6e824ccf0847566fa2541dbb052fd0413379afb0404a85`，旧 `eae920…` 报告保留。此修订仅影响独立测试脚本，不改变门禁、插件核心或已验证的 TGZ。

2026-10-16 经用户单独授权一次 UAC 后，使用同一未改动脚本补测为 `15 PASS / 0 FAIL / 0 SKIP`：`git-discovery-windows-fs-1792082731173-9224.json` / `3a51521d72678f944cbee89fac1d017c131b40ca0bba850feb47c7cfb9fe5896`，JSONL / `57a89223cccba806ebe853692c35e779077d8dd7b27b77e30ab75f43059673e7`。真实文件 symlink 和 junction canonicalization 均通过；输入 SHA 在普通权限和提升进程内复核，临时 fixture 和测试进程清理后又由普通权限独立核对。只使用一次提升、不改 ACL/开发者模式/系统设置，不启动 DSH/WSL/Git 或复制的可执行文件。此 PASS 只证明该测试权限下的路径解析，不表示普通 DSH 或真实 profile 自动获得文件 symlink 创建权限；此前普通权限 EPERM/SKIP 原样保留。

## 安全与回归覆盖

| 控制 | 证据边界 |
| --- | --- |
| 真正宿主与版本 | 从宿主 install anchor 验证，CLI/Desktop 分别实测；附近依赖不能掩盖不支持版本。 |
| 规范路径、不可变工作区 | 真实 Windows/WSL 验证中文、空格和 canonical cwd；越界、UNC、device、错误盘符等在命令启动前拒绝。 |
| 符号链接与 Windows interop | 受限工作区的实际 escape/Windows 越界写入 marker 未产生；full 的允许行为不代替受限断言。 |
| 注入边界 | Bash 语法属于命令本身；特殊参数/description 保持结构化槽位，不构造外层 PowerShell 命令。 |
| 审批与零进程拒绝 | 拒绝或不可用审批、受限 Git 均验证零命令进程；持久 Git 只接受会话 standing full，不接受一次性审批代替。 |
| 缺依赖故障关闭 | 缺沙盒依赖/服务拒绝，不运行模型命令，不退回未沙盒 WSL 或无管理的 Git。 |
| 代理隔离、状态与串行 | cwd、变量、函数保持，其他 owner 无法操作该会话；同 owner 调用串行。 |
| 超时、取消与生命周期 | 实际工具级 reset、干净下一调用、自然退出、后台 writer、owner dispose、卸载和保留 revision 释放分别检查。 |
| 原生协议 | 实际宿主 emulator 的 DSR/DA 依赖检查和完整 prompt/noisy-exit 检查通过；最终正常报告未独立导出规范化 reply 字节，不宣称已逐字节人工复核。 |
| 输出边界 | 4 字节临时 cap 的 malformed UTF-8 输出实际为 3 字节、1 个替换字符并标截断；WSL `script` 合并程序 stderr 到 stdout，按实际捕获流测试。生产默认限额未改。 |
| Standard、pwsh 与提示词 | 实际 Desktop root/两模式 schema 和组合保持，CLI/后台实际执行 pwsh；提示词 scoped 注册、卸载及旧 revision 清理有运行证据，不用菜单图冒充 pwsh 执行。 |
| 制品与清理 | 139 个 TGZ 条目、128 个 dist、6 个公开文档；不包含源码测试、依赖、私有路径和凭据。来源/已安装 dist、probe/observer 哈希一致，owned roots/进程清理。 |

## 清理复核的证据范围

非 GUI 阶段的最终只读 CIM 查询成功，正式门禁和单元测试进程均已不存在；该轮 Desktop 报告提供的 7 个 Git/Bash PID+Creation 身份也全部不存在，没有把查询失败或 PID 重用计为清理成功。该轮临时 owned fixture 已移除；恢复 GUI 使用的受保护认证 fixture 继续保留。校正收据 `release-check-nongui-cleanup-audit-correction-20261015-1792000990296.md` 的 SHA 是 `74af057c06c626b1d1299d249727f798885a7884dc6f240b19a0dc694361202d`。

该轮非 GUI 后台报告没有独立 helper/ConHost PID+Creation，两个后台 PID 也缺初始 Creation 字段；因此不宣称已逐一通过独立 CIM 核验其原始身份。它们的清理证据来自实际 managed handle/Job settlement、owner dispose 后的空快照/空观察结果和无 observation error。WSL 的内部 ledger 和延迟 marker 检查通过，但没有单独保存 root nonce 到 marker 的外部映射；不把它说成事后再次做了全系统 marker 普查。正常子进程 close/reap 与这些内部清理合同均在该轮原始报告中，不能被摘要中的笼统“0 残留”替代。后续 GUI Git 轮另有完整 11 个 PID/Creation 的独立退出前后证明，见下文，不能与旧轮次混用。

最终 R03 另由测试子智能体只读核对已观测的 recorder/gate、Desktop probe、native probe 共 6 个 Windows PID，post-query 均已不存在；精确查询的三个本轮临时根也均不存在，自有 WSL PTY 正常退出。此项只有子任务工具输出和回报，没有独立 cleanup 文件或 SHA，因此不把它表述为额外的持久化全系统清理证明。正式门禁内各原始运行报告的 managed lifecycle/cleanup 检查仍分别保留；受保护认证 fixture、旧包和历史 FAIL 不删除。

## 恢复 GUI 验收记录

下列三轮都绑定候选 TGZ `99aa5383…` 和实际 Desktop `0.2.0-rc.2`。每轮均只有两次串行 `bash` 调用，实际输出分别为 `DSH_GUI_TURN1:DSH_GUI_TURN1`、`DSH_GUI_TURN2:DSH_GUI_TURN1`，退出码均为 0。三轮原始状态均为 `FAIL`：R01/R02 的人工观察窗口为 120 秒，R03 为 600 秒，均到期且 `observationChildClosed=false`；随后清理成功不等于正常托盘退出成功。

| 轮次 | 原始结果 / SHA-256 | 清理边界 |
| --- | --- | --- |
| WSL R01 | `gui-deepseek-real-session-20261011-bash-wsl-20261015-r01.json` / `1964b6e3d5517002b4861142746b7003df2f438cf2f627ac49a5151d490ffdac` | Windows owned lineage 最终为空，WSL ledger 4→0；强制回收，不计正常退出。 |
| WSL R02 | `gui-deepseek-real-session-20261011-bash-wsl-20261015-r02.json` / `4aeec7248398e136d85f0712b96939cb7529227cc839b03923916172a5b7f766` | Windows owned lineage 最终为空，WSL ledger 4→0；强制回收，不计正常退出。 |
| WSL R03 | `gui-deepseek-real-session-20261011-bash-wsl-20261015-r03.json` / `3bd0ea8a460bf9167f1bdec293a0c0b1ac74e23fa05d4009cdbf6e7c7c162410` | 十分钟观察截止时 root 仍存在；清理后独立 Windows 身份集为空，WSL ledger 4→0；不计正常退出。 |

R01 的子任务进度通知未及时送达主代理，R02 也未给人工截图和退出留下足够时间；这不是用户操作失败。后续仅延长人工观察阶段，真实命令、取消、清理时限和正常退出断言保持不变。旧 FAIL 不覆盖、不改绿，后续必须使用新的 helper 来源绑定重新验收。

R02 的 Sky 观测只保留摘要，原始 accessibility tree 未持久化，因此该摘要不作为 D16 PASS。人工观察窗口现已改为十分钟；真实 turn 超时仍为两分钟，其他时限、清理及 PASS 条件未改。Windows Node 定向离线回归 `28 PASS / 0 FAIL / 0 SKIP`，两文件语法检查通过；提前关闭与观察截止均验证监听器释放。最终收据 `gui-observation-window-fix-offline-20261015-stable.json` 的 SHA 是 `35c99dcca63db5985613b7a418bab1aec996c7a487c9c4c1ef8ae1c0ef939aca`，新 driver SHA 为 `3afd079a242a0de07e53f9c98672a2119e4d402f8689006dac13fd93c90674ce`。这次只修改验收脚本和文档，候选 TGZ 与插件核心未变；离线通过不等于真实 GUI 已通过。

R03 已保存本轮原始 Sky accessibility：`gui-r03-sky-accessibility-raw-20261015.json` / `58663083ed218ac3fce473eea17da35d9ba89f1b4e941a207d3c47a90837c475`。目标会话、WSL 模式和两条真实工具输出均独立可见；退出前 owned PID/Creation/fixture marker 已验证，退出后独立 CIM 为空。用户随后补充，准备点击托盘退出时窗口已经自行消失，与脚本先到期回收一致；这些失败不能作为宿主或插件正常退出有故障的证据。owned stderr/logs 为空。driver 的观察期保留连接是来源审计发现的待证风险，不将其写成已经实测的根因；后续先进行零模型的菜单退出预检，再由测试子智能体及时完成正常退出动作。

零模型退出预检复用受保护的隔离 fixture 和同一候选包，未发模型请求、未启动测试终端。Sky 能读取实际窗口的应用菜单文字，但鼠标点击返回 `coordinate input geometry is unavailable`，两次窗口截图均超时；后续 `F10`、`Alt_L` 及逐步 AX 刷新也未展开菜单，焦点仍为 `RootWebArea`。未执行普通 Exit、X、Alt+F4、强制结束、更新或重启。预检停在 `BLOCKED_HUMAN_MENU_REQUIRED`，窗口留给人工菜单退出；没有把可读 AX、失效输入或窗口后续消失计为正常退出成功。该路径只使用独立 GUI launcher，没有真实 turn driver 的观察倒计时。此限制不改变 R01/R02/R03 原始 FAIL 或正式门禁状态。键盘预检原始记录：`gui-quit-automation-preflight-20261016.json` / `96d573acb680dd1845e660cf387c26750f12757fc273b37eba9007a4caf26d8f`；旧鼠标预检记录另行保留。

只读来源审计中发生过一次误启普通 Desktop：直接从 WSL 执行安装目录的 `resources/runtime/bin/node` shell shim，没有进入预期 Node 模式。该审计已停止，未主动向普通窗口发送测试消息、安装或更改配置；随后确认该进程及后代均已不存在，安装 ASAR/EXE 哈希未变。应用自行启动所产生的缓存、日志或联网副作用未核实，不能宣称完全无影响；这次误启不计入隔离验收，后续禁用该跨 WSL 调用方式。

### 2026-10-16 人工协助收尾

- 零模型预检由用户报告普通托盘退出，随后独立 CIM 确认原 PID/Creation 身份均已不存在、fixture marker 为 0；其中一个 PID 已被无关进程以不同 Creation 重用，没有误计为残留。收据 `gui-quit-automation-post-quit-20261016.json` / `69fe8d844b514251af9afe430a4ce5a73346eb7ad89914de10eec3023f1d6e5c`。此项不是 D16。
- WSL R04 原始 `PASS`：`gui-deepseek-real-session-20261011-bash-wsl-20261016-r04.json` / `0ba12bcdeb5c76705fc518531164ab180ec6c0ac5acbf7187a5e2d70127381ab`。两条串行 Bash 调用输出正确、退出码均 0，权限为 `workspace-write`；用户普通托盘退出在观察期内被记录，未强制终止。独立 postempty `gui-r04-postempty-20261016.json` / `d519029baee238d603715d25712abbd3a16ac63f8f4deead944ac0dc2f41277b`：本轮精确 Windows PID/Creation 身份为 0，fixture marker 为 0，WSL ledger 为 0。完整 raw AX `gui-r04-sky-accessibility-raw-20261016.json` / `8820db36216d952c7b05a8c568e6b3abbf4d6385f5899d6dce50d437bbad8e2e` 包含 WSL 模式和两条真实工具结果。
- Git R01 仅发送一次真实请求，使用已获用户明确授权的隔离会话 `danger-full-access`，未改变全局权限。两次 `bash` 实际输出正确、退出码均 0；用户截图显示两条输入/输出和工具名称。用户普通托盘退出，观察期内正常 close，`terminationAttempted=false`。独立 prepositive `gui-git-r01-cim-prepositive-20261016.json` / `626aabd6991edffd7131e0c0705179e11eea9b269bd3a1ad2cda9af8850f8a60` 保存 driver、GUI、Host、native helper、ConHost 和两层 Bash 共 11 个 PID/完整 Creation 身份及归属；独立 postempty `gui-git-r01-postempty-20261016.json` / `438f476f3b5b3d59c35b45ffda2b20e2a8c15eef9536fe4f20aa904fb4696385` 确认同一集合均无精确匹配，fixture marker 为 0，查询成功。
- Git 原始结果仍是 `FAIL`：`gui-deepseek-real-session-20261011-bash-git-bash-20261016-r01.json` / `48b30dfca176567a3b8fac3e897e73f4a9bb5382458e9a27e5e764b565970af7`。已通过实际源码和本轮原始字段复核：driver 在正常 close 后才采 `lineageBeforeTerminate`，Git 资格却把它当作退出前正证据，故唯一错误为 `owned Windows CIM prepositive lineage unavailable`。独立退出前/后证据与脚本内部正常 close、无强制终止事实分别保留，不能静默修改原始 FAIL。限定缺陷的派生资格现已通过，未因此重跑模型，也未修改插件核心、driver 或候选包。
- Git 旧 AX binding 把标题的 8 位前缀写入 `sessionIdSha256`，不是有效完整 SHA；原记录保留，补充收据从官方 READY 取得完整 64 位 session SHA，不能用短前缀通过来源检查。用户物理 Escape 停止 Computer Use 后没有继续调用界面控制；之后的截图只标为用户提供，不假冒 Sky 采集。

### 最终双模式 GUI 资格

补证 ID 为 `GIT_NORMAL_CLOSE_BACKEND_PREPOSITIVE_AFTER_CLOSE`，只适用于固定 SHA 的 driver、Git 模式和上述唯一错误。资格器重新读取并核验 raw driver、READY、独立 CIM prepositive、独立 CIM postempty、driver launch 五份实际文件，不信任一个写成 PASS 的摘要。它校验候选/宿主/来源、完整 session SHA、模式/权限、两条工具实际结果、普通 close/无超时/无强制终止、退出前完整 backend/helper/ConHost/Bash 所有权链与 Creation 身份，以及退出后成功查询、无精确身份残留。正常 close 边界为 `2026-10-15T16:41:54.070Z`；前后独立查询分列该边界两侧。任一缺证、其他错误或替换身份均拒绝。

| 最终输入 | SHA-256 / 状态 |
| --- | --- |
| `gui-git-r01-known-gap-derived-20261016.json` | `fc391ff506657296d6b0e467796c15ca8c5efa4206227eb01f7189be5c68168a`；`QUALIFIED_KNOWN_GAP`，raw Git 仍为 FAIL |
| `gui-native-modes-aggregate-20261016.json` | `20a2c367b71c3e7904cfb6b2fb29da9eb0c1039cb4a190036afefd3718f25888`；严格聚合资格 |
| `gui-native-modes-roster-20261016.json` | `a00067d453beae66265195c29d072563ecd857ee0475534aea3da7ebab44d1d3`；双模式 roster PASS |
| `gui-observation-20261016.json` | `ba7b7116ba76bc45ccdac398daa9f8b657c155c472387215473ded4630c831f9` |
| `gui-evidence-20261016.json` | `7588fa9ff1b34973df1e765a44d0854cf1d7bf31c5ea629ba4621fd1bf08a280`；最终 D16 PASS |

roster 与 D16 均独立重新计算补证，不直接信任派生结论。菜单图来自先前同一候选的 Windows MCP 观察，当前两轮工具结果来自保留的原始 AX 和用户提供的截图；来源和时间分别标记，不把历史菜单图假冒新截图。原始 WSL 失败、Git FAIL 和旧 AX 短前缀绑定全部保留。

另修正 D16 的实际 PTY DTO 读取：probe 提供直接字段，旧门禁却读取镜像测试桩中的嵌套字段。现要求直接 `nativePid` 为正安全整数、`truePty=true`、`helperSpawnObserved=true`；不接受嵌套回退。原有 52 个 GUI 合同不删，新增 5 个拒绝反例，最终 57 PASS。补证与 DTO 修正仅影响测试资格，不改变任何生产安全边界。

## 保留的限制与非通过记录

1. 系统提示词的界面可见性明确记为 `not-visually-verified`；scoped 注册、实际组装与卸载已通过 CLI/Desktop 运行验证，不宣称人工在界面逐字查看。正常点击 X 只隐藏至托盘，不是正常退出证据；本次正常退出使用托盘菜单及精确进程身份取证。历史 WSL 超时 FAIL 和 Git 原始 FAIL 均未改为 PASS。
2. Windows file symlink 创建：普通权限的 `EPERM`/能力 SKIP 保留；用户授权的一次 UAC 补测已使对应路径解析用例实际 PASS，见上文独立 15/0/0 收据。不得把这次提升测试的创建权限外推到普通 DSH/受限模式。
3. Desktop 极低 cap 下的两条普通一次性输出 marker 检查不适用，保留原始 SKIP；专门 cap 检查通过不代表这两条普通检查也通过。
4. 普通旧版 pnpm 缓存诊断仅是 SKIP，不证明旧版兼容。D-14 使用真实 loader/Host 拒绝的独立 PASS。首次 dump 诊断的空缓存 `ENOTCACHED` 也完整保留，不作为成功验收。

本插件不宣称网络或一般 IPC 隔离；Windows Job 提供生命周期所有权，不提供 Git 文件沙盒。上述边界不能通过兼容性开关绕过。

## 复验与交付约束

在 Windows Node 下使用实际 Windows DSH，提供 Windows 绝对路径：

```text
<Windows node.exe> scripts/release-check.mjs
  --pack-cli <manifest-matching pnpm.mjs>
  --candidate-tgz <candidate.tgz>
  --native-modes-cli-evidence <fresh-cli-native.json>
  --native-modes-gui-roster <bound-gui-roster.json>
  --gui-evidence <bound-gui-evidence.json>
```

此前非 GUI 阶段未提供 `--native-modes-gui-roster`、`--gui-evidence`，其门禁因 GUI SKIP 返回非零；最终 R03 提供了上表明确绑定的真实证据。复验不得复用不匹配候选或来源的旧报告，也不得把 SKIP 或失败轮次直接计为 PASS。

仅本地 Git 记录；保留 `v0.1.0` 回退和旧包。当前源码/候选不改变用户 AGENTS、真实 web/desktop、其他插件、Codex 或 v2rayN。最终报告不包含认证 fixture、聊天内容、个人路径或凭据；原始运行产物留本地供核查。
