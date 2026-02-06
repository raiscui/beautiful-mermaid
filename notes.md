# 笔记：Unicode 字符画路由问题定位（beautiful-mermaid）

## 来源（本地代码阅读）

### 来源1：`src/parser.ts`
- 要点：
  - `parseMermaid()` 支持 `graph TD / flowchart LR`。
  - 裸节点解析使用 `BARE_NODE_REGEX`（贪婪），会把 `A-->B` 中的 `A-->` 误吞为 node id。

### 来源2：`src/ascii/index.ts`
- 要点：
  - `renderMermaidAscii()` 走 `parseMermaid()` → `convertToAsciiGraph()` → `createMapping()` → `drawGraph()`。
  - 方向归一化：LR/RL → `graphDirection='LR'`；其它 → `TD`；BT 通过最终 canvas 翻转实现。
  - Unicode 会执行 `deambiguateUnicodeCrossings()` 把 `┼` 变“桥”。

### 来源3：`src/ascii/grid.ts` / `src/ascii/edge-routing.ts` / `src/ascii/pathfinder.ts`
- 要点：
  - 节点在逻辑网格上占用 3x3 block；端口来自 8 个方向常量（Up/Down/Left/Right/四角）。
  - strict 路由约束：
    - 禁止形成四向交叉（`┼`）—— usedPoints bitmask
    - 禁止非法共线复用（segmentUsage）
  - 这些“硬禁止”在图密集时会迫使 A* 扩大 bounds 或绕大圈。

## 综合发现（问题根因）
1. 输入兼容性 bug：`A-->B` 会被 parser 当作 node id，导致后续布局/路由无从谈起。
2. 可读性问题：strict 约束是“可逆/规整优先”的取舍，在图密集+回边时会显著放大绕路与重叠。

## 实施结论（2026-02-06）
- parser：
  - 修复 bare node 贪婪吞箭头：支持 `A-->B` / `A---B` / `my-node-->other-node` 等无空格写法。
  - 已补回归测试覆盖上述输入。
- ASCII/Unicode 路由：
  - 增加 `routing: 'strict' | 'relaxed'` 选项（flowchart/state 生效）。
  - Unicode 默认 `relaxed`：允许交叉/共线复用，但在 A* 中加惩罚，让路径更自然；同时通过后处理“桥化”消除 `┼` 歧义。
  - strict 用于 golden/roundtrip：避免引入行为漂移，保持可逆语义。
- 样例与验证：
  - 新增 Hat workflow relaxed 回归测试（检查布局面积减少 + LR 阅读形态）。
  - `samples-data.ts` 增加 Hat Spec Workflow 视觉样例，便于在 dev/samples 页面直接观察效果。

## 追加笔记（2026-02-06）：梳子口端口 + 禁终点复用 + 不共线重叠

### 梳子口端口（Comb Ports）
- 目标：
  - 出入口沿边框多点分布（不再局限 8 个端口）
  - box 可按端口数量自适应扩容
  - 拐角不出线（只允许四边端口）
- 做法（只对 Unicode + relaxed 生效）：
  - 在 `AsciiEdge` 上记录 start/end 的 lane offset（X/Y）
  - 在 `createMappingOnce()` 中统计每个 node 每侧端口需求，扩大 content row/col 尺寸
  - 绘制阶段用 per-edge 的 grid→drawing 坐标映射，把端口从“cell center”偏移到不同 lane

### relaxed A* 规则调整
- 用户硬性诉求：
  - 允许 crossing（交错），但不同边不允许共线重叠
  - 允许“同源起点段”共线（只允许第一段）
  - 禁止终点复用（最后一段绝不能共线）
- 实现：
  - `getPathRelaxed()` 中把 segment reuse 从“惩罚”升级为 hard rule：
    - 已占用 segment 默认禁用
    - 仅同 source 的第一段允许复用

### 性能优化（prefix-sum cache）
- 背景：
  - comb ports 引入 per-edge 坐标换算后，`gridToDrawingCoordForEdge()` 被调用次数显著增加
  - 若每次都从 0 累加 columnWidth/rowHeight，会形成明显的 O(N^2) 热点
- 做法：
  - 在 layout 完成后预计算 `graph.columnStartX / graph.rowStartY`（前缀和）
  - 渲染阶段 O(1) 查表拿 origin

### 追加修正（2026-02-06）：同侧多入边与“终点段复用”的关系
- 现象：
  - 一开始把 relaxed 写成“完全禁止终点段复用”，会让“多入边同靶（同侧）”在 3x3 node block 下几何不可达：
    - 同一 side port 的边界格子只有一个 free neighbor
    - 多条边必然共享最后一段 unit segment
  - 当所有 layoutMargin 重试都失败时，`createMapping()` 结束后仍会调用 `drawGraph()`，从而触发崩溃（canvas 仍是 1x1）。
- 结论：
  - “终点不复用”的真实诉求是：**终点点位（箭头格子）不重叠**，而不是“grid 层最后一段绝对不共享”。
  - 在 Unicode relaxed 下，comb ports 的 lane offset 会让同侧端点分布到不同 y/x，从而：
    - 即使 grid segment 复用，最终也不会画到同一个箭头格子（视觉上不重叠）
    - 同时仍禁止中段 segment 复用，避免“合并后再分开”的不可读问题

## 追加笔记（2026-02-06）：Rust CLI（QuickJS）性能与 native A* 覆盖范围

### 现象
- 在 `beautiful-mermaid-rs`（Rust CLI，QuickJS 无 JIT）里渲染 Unicode（默认 relaxed）耗时明显偏长。

### 根因
- TS 侧 `getPath()` / `getPathStrict()` 会尝试调用 Rust 注入的 native 函数：
  - `globalThis.__bm_getPath`
  - `globalThis.__bm_getPathStrict`
- 但 relaxed 路由走 `getPathRelaxed()`：
  - 目前没有对应的 `__bm_getPathRelaxed` fast path
  - 因此 CLI 下 relaxed 仍在 QuickJS 里跑纯 JS A* 热循环 → 很慢

### 解决方向
- 补齐 native relaxed（Rust 实现 + 注入 + TS 调用），让 Unicode relaxed 也能吃到 Rust A* 的性能红利。
