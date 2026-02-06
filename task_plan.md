# 任务计划：改进 Unicode 字符画（LR 布局 + 路由可读性）& 兼容 `A-->B`

## 目标
让 `renderMermaidAscii()` 的 Unicode 输出更“可读”：

- `flowchart LR` 必须稳定按 LR 方向展开（宽明显大于高）
- 布线尽量减少绕大圈/重叠
- 支持 Mermaid 常见无空格写法：`A-->B-->C`
- 保留 `strict` 模式给“可逆/规整”用户使用

## 阶段
- [x] 阶段1：计划与基线复现
- [x] 阶段2：实现：parser 兼容 `A-->B`
- [x] 阶段3：实现：routing 模式（strict/relaxed）
- [x] 阶段4：测试 + 样例 + 文档同步

## 关键问题
1. `A-->B` 为什么会解析失败？
   - 结论：裸节点（bare node）正则会把 `A-->` 误吞成 node id，导致 edges 为 0。
2. “放开约束”具体放哪里？
   - 结论：在 relaxed 模式下，把“交叉/共线复用”从硬禁止改成软惩罚，并增加端口候选与端口拥挤惩罚。

## 可选方向（两条路）
1. 不惜代价（上限最高）：把路由提升到“字符级 canvas”，实现边框多进出点（梳子口）。
2. 先能用（本次落地）：保留 3x3 grid 路由体系，引入 relaxed 模式（软惩罚 + 端口分散）。

## 做出的决定
- 选择方向2（先能用）：原因是 ROI 最高、改动可控、能最快改善绕路与拥挤。
- 优先目标：可读性优先（允许交叉，但用“桥”消除 `┼` 歧义）。
- 输入兼容：支持 `A-->B` 无空格写法。
- 核心验收样例：加入 Hat 工作流示例（含回边/汇入/label/emoji）。

## 遇到错误
- 暂无（开始执行后再记录）

## 状态
**状态：已完成**
- 2026-02-06 15:19:53：创建四文件上下文；确认当前 `A-->B` 会误解析；确认 ASCII/Unicode 渲染管线与 strict 约束位置。
- 2026-02-06 15:21:07：开始修复 parser（裸节点消费不要吞掉箭头），并为该行为添加回归测试。
- 2026-02-06 15:26:50：完成 parser 兼容（覆盖 `A-->B` / `A---B` 等无空格写法），parser.test.ts 已通过；开始实现 relaxed 路由模式与回归样例（Hat 工作流）。
- 2026-02-06 15:45:12：完成 strict/relaxed 路由：Unicode 默认 relaxed；golden/roundtrip 显式锁定 strict；新增 Hat workflow 的 relaxed 回归测试；全量 bun test 通过。接下来补齐 samples-data 与 README 文档同步。
- 2026-02-06 15:48:04：已加入 Hat Spec Workflow 到 `samples-data.ts`；README 已补充 routing 选项说明；所有测试仍通过。

---

# 任务计划（追加）：梳子口端口（Comb Ports）+ 终点不复用 + 可交错但不重叠

## 目标
把 Unicode（`useAscii=false`）的 flowchart/state 输出，进一步改成“像梳子口那样”的出入口分布：

- 端口不再限制为 8 个离散点：沿 box 边框提供更多出/入口点（不走拐角）
- box 大小可自适应扩容：需要多少端口就按需拉宽/拉高（不影响 node label）
- 路由规则（主要针对 relaxed 可读性模式）：
  - 允许交错（必要时允许 crossing，并继续用 bridge 化避免 `┼` 歧义）
  - **禁止线段重叠**（共线复用会让人分不清哪条线是哪条）
  - 允许“起点附近”更紧凑（同源可并行/可近似共线），但 **终点必须分开**（不同边不要复用同一个终点/箭头格）

## 阶段
- [x] 阶段1：复现问题 + 明确验收指标
- [x] 阶段2：设计：端口分配（按边框位置扩展）+ box 自适应扩容
- [x] 阶段3：实现：edge 记录端口 offset + lane-aware 绘制（让线真正从不同点出入）
- [x] 阶段4：实现：relaxed A* 惩罚调整（起点放开，终点强约束/强惩罚）
- [x] 阶段5：测试/样例/文档同步

## 可选方向（两条路）
1. 不惜代价（上限最高）：把路由提升到“字符级 canvas”，A* 直接在 char grid 上跑，端口天然无限。
2. 先能用（本次落地）：保留现有 grid A*，但在“绘制层”引入 lane（同一格内多条平行线），并让端口沿边框多点分布 + box 自适应扩容。

## 做出的决定
- 选择方向2（先能用）：原因是改动更集中（主要在 draw/grid），不需要改 Rust native pathfinder，且能满足“梳子口端口 + 不重叠 + 终点分开”的核心诉求。

## 状态
**状态：已完成**
- 2026-02-06 16:43:05：开始实现梳子口端口：先做端口分配与 box 扩容，再做 lane-aware 绘制，最后调 A* 惩罚与补测试。
- 2026-02-06 17:38:10：梳子口端口 + box 自适应扩容 + lane-aware 绘制已落地；当前全量 `bun test src/__tests__/` 可通过，但总耗时接近 5s（余量很小）。下一步先做坐标换算性能优化（前缀和缓存），再实现 relaxed A*：允许起点共线但禁止终点复用，并补回归测试锁死“不重叠”规则。
- 2026-02-06 17:38:31：完成 relaxed A*：禁止共线重叠（仅同源起点第一段允许复用）+ 禁终点复用；加入 grid→drawing 前缀和缓存；补回归测试与 README 同步；`bun test src/__tests__/` 全量通过。
- 2026-02-06 17:52:44：发现“多入边同靶（同侧）”在严格禁止终点段复用时会几何不可达，导致 `createMapping()` 全部重试失败并在 `drawGraph()` 崩溃；修正 relaxed 规则为：仅允许“同源起点第一段 / 同靶终点最后一段”受控复用（端点点位由 comb ports 分 lane 保证不重叠），并新增 star 回归测试；`bun test src/__tests__/` 全量通过。
- 2026-02-06 18:13:50：补充人工验收：用 Hat workflow 例子实际渲染确认 LR 方向与桥化效果；并运行 `bun run build` 确认产物可正常构建。

---

# 任务计划（追加）：Rust CLI（QuickJS）下 relaxed 路由过慢 —— 启用 native A* 加速

## 现象
- 在 `beautiful-mermaid-rs`（Rust CLI，QuickJS 无 JIT）里渲染 Unicode（默认 `routing=relaxed`）耗时很长。

## 根因（当前实现状态）
- TS 侧只有 `getPath` / `getPathStrict` 支持调用 Rust 注入的 native 函数：
  - `globalThis.__bm_getPath`
  - `globalThis.__bm_getPathStrict`
- 但 relaxed 路由走的是 `getPathRelaxed()`（带 crossing penalty + segment reuse hard rule），**目前没有 native 版本**，
  所以即使在 Rust CLI 里也会回退到纯 JS A*，从而很慢。

## 可选方向（两条路）
1. 不惜代价（体验最佳）：补齐 native relaxed：
   - Rust 注入 `globalThis.__bm_getPathRelaxed(...)`
   - TS 的 `getPathRelaxed()` 优先调用该函数
   - 目标：CLI 下 Unicode relaxed 也能享受 Rust A* 性能
2. 先能用（最小改动）：CLI 默认改回 strict 或新增 CLI flag 让用户手动切 strict。

## 做出的决定
- 选择方向 1：原因是用户明确想要 relaxed 的可读性策略，但又要 CLI 性能；native 化能同时满足两者。

## 阶段
- [x] 阶段1：确认 TS 侧 relaxed 未走 native 的调用链
- [x] 阶段2：TS：为 `getPathRelaxed()` 增加 `__bm_getPathRelaxed` fast path
- [x] 阶段3：Rust：实现 native relaxed A* + 注入 `__bm_getPathRelaxed`
- [x] 阶段4：同步 vendor bundle + 端到端验证（`cargo test` + CLI 示例）

## 状态
**状态：已完成**
- 2026-02-06 18:13:50：收到反馈“运行非常久”；开始把 relaxed 路由也接入 Rust native A*。
- 2026-02-06 19:33:24：已完成：TS `getPathRelaxed()` 优先调用 `__bm_getPathRelaxed`；Rust CLI 注入并实现 native relaxed A*；同步 vendor bundle；Rust 端到端测试时间从 ~88s 降到 ~3.6s；TS `bun test src/__tests__/` 全量通过。

---

# 任务计划（追加）：Git 提交（TS + Rust 双仓库）

## 目标
- 把本次“Unicode 梳子口端口 + relaxed 路由规则 + native relaxed A* 加速”的改动正式提交到 git。
- 这样后续在 `beautiful-mermaid-rs` 里同步 vendor bundle 时，不会出现“代码已改但没提交”的断层。

## 阶段
- [x] 阶段1：TS 仓库（本仓库）检查 + 测试 + commit
- [x] 阶段2：Rust 仓库（beautiful-mermaid-rs）检查 + fmt/test + commit

## 状态
**状态：已完成**
- 2026-02-06 20:07:10：开始进入“提交交付”阶段：先在 TS 仓库确认测试/构建无误，再提交；随后切到 Rust 仓库做 `cargo fmt/test` 并提交。
- 2026-02-06 20:10:51：提交完成：
  - TS（本仓库）：`570926a`（feat(ascii): comb ports + relaxed routing）
  - Rust（beautiful-mermaid-rs）：`5833bc1`（feat: validate Mermaid + native relaxed pathfinder）

---

# 任务计划（追加）：relaxed 布局鲁棒性边缘 case 修复 + Git 提交

## 目标
修复 relaxed flowchart 在一些边缘输入下的可读性/稳定性问题, 并把修复提交到 git。

## 可选方向（两条路）
1. 不惜代价（统一口径）：strict/relaxed 都改用“无入边节点”为 root, 并统一放置策略。
2. 先能用（本次落地）：仅 relaxed 改 root 识别与放置兜底; strict 保持旧行为, 避免 golden 大范围变化。

## 做出的决定
- 选择方向 2（先能用）：原因是影响面更可控, 回归风险更低, 但能解决 relaxed 的真实问题。

## 阶段
- [x] 阶段1：定位 root 误判与放置假设
- [x] 阶段2：修复 root/放置兜底 + label 扩宽安全
- [x] 阶段3：补回归测试
- [x] 阶段4：测试 + git commit

## 状态
**状态：已完成**
- 2026-02-07 00:20:02：已提交 `3ffda78`（fix(ascii): harden relaxed layout and label spacing），并运行 `pnpm test` 全量通过。
