# ERRORFIX（错误修复记录）

> 说明：本次任务属于“渲染/解析 bug + 行为改良”，修复完成后会把：现象、原因、修复、验证追加到文件尾部。

## 2026-02-06 15:48:49：Unicode 字符画（flowchart LR）布局/布线可读性问题

### 现象
- Unicode 字符画在密集图中出现：
  - `flowchart LR` 视觉上不够“LR”（整体挤、线绕大圈）
  - 布线重叠/覆盖 box 边框，读图困难
- Mermaid 常见写法 `A-->B-->C` 会解析失败：
  - 被误解析为单个节点（如 `A--`），edges 为空

### 原因
- `src/parser.ts`：裸节点（bare node）解析允许 `-`，导致贪婪吞掉箭头里的 `--/---`。
- ASCII/Unicode 路由的 strict 约束偏“可逆/规整”：
  - 禁止四向交叉与非法共线复用，会迫使某些边扩大搜索 bounds 或绕远。
  - 多出边节点端口选择空间小（默认倾向四边中心），容易挤在同一路径/同一端口附近。

### 修复
- parser：
  - 对 bare node 贪婪匹配结果做“回退截断”，优先切出箭头操作符（且保证箭头后存在可解析的 target）。
  - 添加回归测试覆盖 `A-->B` / `A---B` / `my-node-->other-node`。
- Unicode 路由：
  - 新增 `routing: 'strict' | 'relaxed'` 选项（flowchart/state）。
  - Unicode 默认 `relaxed`：
    - A* 允许交叉/复用，但通过惩罚项引导更自然的路径（减少绕大圈）
    - 引入端口占用惩罚 + 允许角落端口（分流）以减少重叠
  - golden / roundtrip 显式锁定 `strict`，避免可逆性测试被默认策略影响。

### 验证
- `bun test src/__tests__/`：全量通过（包含新增 Hat workflow relaxed 回归用例）。

## 2026-02-06 17:38:31：Unicode 出入口分布（梳子口）+ 禁终点复用 + 不共线重叠

### 现象
- Unicode relaxed 在密集图里，边的入/出点太集中（只有 8 个端口），容易出现：
  - 多条线在同一路径上“合并后再分开”（共线重叠），肉眼无法追踪
  - 多条线在目标点附近复用最后一段（终点复用），读图更像“汇入同一条线”

### 根因
- 端口候选离散且数量少：同侧多条边只能挤同一个端口格子，导致后续路由更倾向复用 segment。
- relaxed 的 segment reuse 以前是“惩罚”而非“硬规则”，在某些几何条件下 A* 仍会选择复用。
- comb ports 引入 per-edge 坐标换算后，渲染阶段 grid→drawing 累加次数暴增，测试容易逼近默认 5s 超时阈值。

### 修复
- 梳子口端口（仅 Unicode + relaxed）：
  - 统计每个 node 四边端口需求，自动扩大 content row/col
  - 为每条边分配 start/end 的 lane offset，让线沿边框多点分布（拐角不出线）
- relaxed A*：
  - segment reuse 改为 hard rule：
    - 默认禁止复用已占用 segment（消除共线重叠）
    - 仅允许同 source 的“第一段”复用
    - 禁止终点复用（最后一段不允许复用）
- 性能：
  - 增加 `columnStartX/rowStartY` 前缀和缓存，坐标换算 O(1) 查表

### 验证
- `bun test src/__tests__/`：全量通过

## 2026-02-06 19:33:24：Rust CLI（QuickJS）下 Unicode relaxed 渲染过慢（未走 Rust native A*）

### 现象
- 在 `beautiful-mermaid-rs`（Rust CLI，QuickJS 无 JIT）里渲染 Unicode（默认 `routing=relaxed`）耗时很长。

### 原因
- Rust CLI 只注入了：
  - `globalThis.__bm_getPath`
  - `globalThis.__bm_getPathStrict`
- 但 Unicode 默认走 relaxed，使用的是 `getPathRelaxed()`：
  - 之前没有对应的 `__bm_getPathRelaxed` fast path
  - 因此 CLI 下 relaxed 仍在 QuickJS 里跑纯 JS A* 热循环 → 极慢

### 修复
- TS：`getPathRelaxed()` 增加 native fast path：
  - 若存在 `globalThis.__bm_getPathRelaxed`，则优先走 Rust native A*
- Rust（`beautiful-mermaid-rs`）：
  - 实现 native relaxed A*（步长 + crossing penalty + segment reuse hard rule）
  - 注入 `globalThis.__bm_getPathRelaxed(...)`
- 同步 Rust vendor bundle，确保 CLI 实际用到新 fast path。

### 验证
- Rust：运行 `scripts/sync-vendor-bundle.sh` 通过；Unicode golden 耗时从 ~88s 降到 ~3.6s
- TS：`bun test src/__tests__/`：全量通过

## 2026-02-06 17:52:44：修复 relaxed 多入边同靶不可达导致渲染崩溃

### 现象
- 在 “多入边同靶（同侧）” 的图里，渲染会崩溃（TypeError：`canvas[from.x]` 为 undefined）。

### 原因
- relaxed 若严格禁止“终点段 unit segment 复用”，在 3x3 node block 下会出现几何不可达：
  - 同一 side port 的边界格子只有一个 free neighbor
  - 多条入边必然共享最后一段 unit segment
- 当 `createMapping()` 的所有 layoutMargin 重试都失败时：
  - `graph.canvas` 仍停留在 `mkCanvas(0,0)`（1x1）
  - 后续 `drawGraph()` 用更大的 drawingCoord 写入，触发越界崩溃

### 修复
- relaxed segment reuse 改为“受控复用”：
  - 允许同源起点第一段复用
  - 允许同靶终点最后一段复用（避免多入边同侧不可达）
  - 中段 segment 仍严格禁止复用，避免“合并后再分开”的不可读重叠
- 新增回归测试：`src/__tests__/unicode-relaxed-comb-ports-star.test.ts`

### 验证
- `bun test src/__tests__/`：全量通过

## 2026-02-07 00:20:02：relaxed 布局边缘 case（root 误判 + label 扩宽误伤 node 列）

### 现象
- relaxed（flowchart LR）在“节点先声明, 后连边”的写法下:
  - target 节点可能被误判成 root, 导致真正的 root 没被放到最左侧, 布局出现明显阅读歧义。
- Unicode + relaxed 下, 某些边的 label 为了腾空间扩宽 column 后:
  - 端口视觉上“落入 box 内部”, 例如回边/反向边看起来穿进节点框里。
- ASCII + relaxed 下, 少数图在禁 corner port 时会出现“几何不可达”:
  - 边会直接消失, 或被迫多轮重试仍无法得到路径。

### 原因
- root nodes 识别的旧逻辑依赖 insertion order 的“首次出现推断”:
  - 当节点声明顺序与边出现顺序不一致时, 会把本应有入边的节点误当作 root。
- `determineLabelLine()` 用“扩宽某一整列”的方式给 label 腾空间:
  - `columnWidth` 是全局列宽, 一旦扩宽命中 node 的 3x3 block 列, 会把节点坐标系整体挤歪,
    从而让 edge 端口看起来进入 box interior。
- relaxed 路由默认禁 corner port:
  - 在极端拥挤或某些声明顺序下, 可能只有 corner port 才可达。

### 修复
- root nodes（`src/ascii/grid.ts`）:
  - strict: 保持旧行为, 避免大面积 golden 变化。
  - relaxed: 改用“无入边节点”作为 root; 若全图成环导致 root 为空, 回退到第一个节点作为 root。
  - child 放置改为迭代推进: 不再假设父节点先于子节点出现; 并为纯环/不连通组件添加“额外 root”兜底。
  - 若仍存在未放置节点, 返回 false 交给外层 layoutMargin 重试, 避免后续路由崩溃。
- label 扩宽列（`src/ascii/edge-routing.ts`）:
  - 仅在 Unicode + relaxed 启用“安全扩宽”:
    - 如果 middleX 命中任意 node 3x3 block 列, 则在 [minX..maxX] 内寻找最近的非 node block 列扩宽。
- corner port 兜底（`src/ascii/edge-routing.ts`）:
  - 仅在 ASCII + relaxed 且“四边端口完全不可达”时启用 corner port, 并用惩罚项让其只在必要时被选中。
- label 避让兜底（`src/ascii/draw.ts`）:
  - 追加“最近可行 startX”搜索, 确保多 avoid 点叠加时仍不覆盖。

### 验证
- `pnpm test`（bun test）：全量通过
- 新增回归测试:
  - `src/__tests__/flowchart-root-nodes.test.ts`
  - `src/__tests__/unicode-relaxed-label-widen-avoids-node-block.test.ts`
