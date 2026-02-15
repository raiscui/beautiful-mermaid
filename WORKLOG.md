# WORKLOG（工作日志）

> 说明：只在文件尾部追加记录（按项目规范）。

## 2026-02-06 15:48:49：Unicode 字符画路由改良 + `A-->B` 兼容

### 做了什么（结果）
- 修复 Mermaid parser：支持无空格连线写法（`A-->B` / `A---B` / `A-.->B` 等），避免把箭头误吞成 node id。
- ASCII/Unicode 渲染新增路由模式：
  - `routing: 'strict' | 'relaxed'`（仅 flowchart/state 生效）
  - Unicode 默认 `relaxed`，优先“可读性”（允许交叉/复用，但带惩罚项，减少绕大圈）
  - `strict` 保留给可逆/规整场景（roundtrip / golden）
- 加入 Hat workflow（含回边/分叉汇入/label/emoji）作为：
  - `samples-data.ts` 的可视化样例
  - `ascii-relaxed-routing.test.ts` 的回归测试

### 如何使用（关键 API）
```ts
import { renderMermaidAscii } from "beautiful-mermaid"

// Unicode：默认 relaxed（更适合密集图）
renderMermaidAscii(diagram, { useAscii: false })

// 需要可逆/规整：显式 strict
renderMermaidAscii(diagram, { useAscii: false, routing: "strict" })
```

### 验证
- 已运行：`bun test src/__tests__/`（全量通过）

## 2026-02-06 17:52:44：修正 relaxed“终点段复用”语义 + 补崩溃回归

### 发生了什么
- 在“多入边同靶（同侧）”的图里，如果 relaxed **严格禁止终点段复用**：
  - 由于 node 仍是 3x3 block，同一 side port 的边界格子只有一个 free neighbor
  - 多条入边必然共享最后一段 unit segment → 变成几何不可达
  - `createMapping()` 多轮重试失败后继续 `drawGraph()`，会导致渲染崩溃

### 修正
- relaxed 的 segment reuse 规则改为“受控复用”：
  - 允许同源起点第一段复用
  - 允许同靶终点最后一段复用
  - 其它 segment（尤其是中段）禁止复用，避免“合并后再分开”的不可读重叠
- 新增回归测试：`src/__tests__/unicode-relaxed-comb-ports-star.test.ts`（多入边同靶不崩溃）

### 验证
- 已运行：`bun test src/__tests__/`（全量通过）

## 2026-02-06 17:38:31：Unicode “梳子口端口” + relaxed 禁终点复用 + 不共线重叠

### 做了什么（结果）
- Unicode + relaxed：
  - 端口改为“梳子口”分布：同一侧多条边沿边框分散出入口（不再只有 8 个端口点）
  - box 可按端口数量自适应扩容（保证有足够 lane 容量）
  - 禁止 corner port（拐角不出线），符合可读性规则
- relaxed A* 规则：
  - 允许 crossing（交错）但禁止共线重叠
  - 仅允许“同源起点第一段”共线
  - 禁止终点复用（最后一段不允许共线）
- 性能：
  - 为 grid→drawing 坐标换算加入 prefix-sum cache（`columnStartX/rowStartY`），降低渲染层重复累加成本

### 回归测试
- 更新：`src/__tests__/ascii-relaxed-routing.test.ts`（不再强制 relaxed 面积必须小于 strict，优先可读性规则）
- 新增：`src/__tests__/unicode-relaxed-no-collinear-overlap.test.ts`（锁死“不共线重叠 + 禁终点复用”）

### 验证
- 已运行：`bun test src/__tests__/`（全量通过）

## 2026-02-06 18:13:50：补充人工验收（终端可视化）+ 构建验证

### 做了什么
- 用你的 Hat workflow Mermaid 示例做了 Unicode+relaxed 的实际渲染，肉眼确认：
  - `flowchart LR` 输出宽明显大于高（读图方向更像 LR）
  - 没有出现 `┼`（交叉被桥化，不再误读成“连通路口”）
  - 端口/线路在 node 边框附近更分散（lane offset 生效）
- 跑了一次构建，确认 `tsup` 正常产物可生成。

### 验证
- 已运行：`bun run build`（成功）

## 2026-02-06 19:33:24：Rust CLI（QuickJS）relaxed 路由 native A* 加速（`__bm_getPathRelaxed`）

### 做了什么
- TS：`getPathRelaxed()` 增加 native fast path：
  - 若存在 `globalThis.__bm_getPathRelaxed`，则优先走 Rust native A*。
- Rust（`beautiful-mermaid-rs`）：
  - 注入 `globalThis.__bm_getPathRelaxed(...)`
  - 实现 native relaxed A*（步长 + crossing penalty + segment reuse hard rule）
- 同步 Rust vendor bundle，让 CLI 实际调用到 `__bm_getPathRelaxed`。

### 验证
- Rust：已运行 `scripts/sync-vendor-bundle.sh`（端到端测试通过；Unicode golden 从 ~88s 降到 ~3.6s）
- TS：已运行 `bun test src/__tests__/`（全量通过）

## 2026-02-06 20:10:51：Git 提交（双仓库）

- TS（本仓库）：`570926a`（feat(ascii): comb ports + relaxed routing）
- Rust（beautiful-mermaid-rs）：`5833bc1`（feat: validate Mermaid + native relaxed pathfinder）
- 验证：
  - TS：`bun test src/__tests__/` + `bun run build`（全量通过）
  - Rust：`cargo fmt --all` + `cargo test` + `make validate-docs`（全量通过）

## 2026-02-11 01:20:04：修复 label 放置误判 + reverse roundtrip 误判 + 单测 timeout，并完成提交

### 发生了什么
- 当前仓库存在未提交改动，且处于 detached HEAD，直接 commit 有“提交丢失”的风险。
- `bun test src/__tests__/` 仅 1 个失败：
  - `src/__tests__/unicode-relaxed-label-widen-avoids-node-block.test.ts` 在 bun 默认 5000ms 下超时（本机实测约 5.3s）。

### 本次改动（摘要）
- label 放置相关：
  - `src/ascii/edge-routing.ts`：让 `determineLabelLine()` 使用“有效可写宽度”，避免把端点列宽误算进来，进而导致 label 丢失或覆盖箭头/分叉符号。
- reverse roundtrip 相关：
  - `src/ascii/reverse-flowchart.ts`：反解时同时参考 arrow 侧 label 信息，用于在多候选边里消歧，避免误连出多余边。
- 测试/数据：
  - `src/__tests__/unicode-relaxed-label-widen-avoids-node-block.test.ts`：为该用例增加显式 timeout（20_000ms），避免慢环境下误报失败。
  - 同步更新相关 golden/测试配置（见 commit diff）。

### 提交
- 从 detached HEAD 创建分支：`fix/label-line-width`
- 已提交：`ef9aa14`（fix(ascii): stabilize label placement and reverse roundtrip）

### 验证
- 已运行：`bun test src/__tests__/`（561/561 通过）
