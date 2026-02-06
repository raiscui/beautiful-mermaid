import type { MermaidGraph, MermaidNode, MermaidEdge, MermaidSubgraph, Direction, NodeShape, EdgeStyle } from './types.ts'

// ============================================================================
// Mermaid parser — flowcharts and state diagrams
//
// Supports:
//   Flowcharts: graph TD / flowchart LR
//   State diagrams: stateDiagram-v2
//
// Line-by-line regex approach — the grammar is regular enough
// that we don't need a grammar generator or full parser combinator.
// ============================================================================

/**
 * Parse Mermaid text into a logical graph structure.
 * Auto-detects diagram type (flowchart or state diagram).
 * Throws on invalid/unsupported input.
 */
export function parseMermaid(text: string): MermaidGraph {
  const lines = text.split(/[\n;]/).map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('%%'))

  if (lines.length === 0) {
    throw new Error('Empty mermaid diagram')
  }

  // Detect diagram type from header
  const header = lines[0]!

  // State diagram: "stateDiagram-v2" or "stateDiagram"
  if (/^stateDiagram(-v2)?\s*$/i.test(header)) {
    return parseStateDiagram(lines)
  }

  // Flowchart: "graph TD" or "flowchart LR"
  return parseFlowchart(lines)
}

// ============================================================================
// Flowchart parser
// ============================================================================

function parseFlowchart(lines: string[]): MermaidGraph {
  const headerMatch = lines[0]!.match(/^(?:graph|flowchart)\s+(TD|TB|LR|BT|RL)\s*$/i)
  if (!headerMatch) {
    throw new Error(`Invalid mermaid header: "${lines[0]}". Expected "graph TD", "flowchart LR", "stateDiagram-v2", etc.`)
  }

  const direction = headerMatch[1]!.toUpperCase() as Direction

  const graph: MermaidGraph = {
    direction,
    nodes: new Map(),
    edges: [],
    subgraphs: [],
    classDefs: new Map(),
    classAssignments: new Map(),
    nodeStyles: new Map(),
  }

  // Subgraph stack for nested subgraphs.
  const subgraphStack: MermaidSubgraph[] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!

    // --- classDef: `classDef name prop:val,prop:val` ---
    const classDefMatch = line.match(/^classDef\s+(\w+)\s+(.+)$/)
    if (classDefMatch) {
      const name = classDefMatch[1]!
      const propsStr = classDefMatch[2]!
      const props = parseStyleProps(propsStr)
      graph.classDefs.set(name, props)
      continue
    }

    // --- class assignment: `class A,B className` ---
    const classAssignMatch = line.match(/^class\s+([^\s]+)\s+(\w+)$/)
    if (classAssignMatch) {
      const nodeIds = classAssignMatch[1]!.split(',').map(s => s.trim())
      const className = classAssignMatch[2]!
      for (const id of nodeIds) {
        graph.classAssignments.set(id, className)
      }
      continue
    }

    // --- style statement: `style A,B fill:#f00,stroke:#333` ---
    const styleMatch = line.match(/^style\s+([^\s]+)\s+(.+)$/)
    if (styleMatch) {
      const nodeIds = styleMatch[1]!.split(',').map(s => s.trim())
      const props = parseStyleProps(styleMatch[2]!)
      for (const id of nodeIds) {
        graph.nodeStyles.set(id, { ...graph.nodeStyles.get(id), ...props })
      }
      continue
    }

    // --- direction override inside subgraph: `direction LR` ---
    const dirMatch = line.match(/^direction\s+(TD|TB|LR|BT|RL)\s*$/i)
    if (dirMatch && subgraphStack.length > 0) {
      subgraphStack[subgraphStack.length - 1]!.direction = dirMatch[1]!.toUpperCase() as Direction
      continue
    }

    // --- subgraph start: `subgraph Label` or `subgraph id [Label]` ---
    const subgraphMatch = line.match(/^subgraph\s+(.+)$/)
    if (subgraphMatch) {
      const rest = subgraphMatch[1]!.trim()
      // Check for "subgraph id [Label]" form
      // ID can contain hyphens (e.g. "us-east"), so use [\w-]+ not \w+
      const bracketMatch = rest.match(/^([\p{L}\p{N}_-]+)\s*\[(.+)\]$/u)
      let id: string
      let label: string
      if (bracketMatch) {
        id = bracketMatch[1]!
        label = bracketMatch[2]!
      } else {
        // Use the label text as id (slugified)
        label = rest
        // 这里的目标是“从 label 生成一个稳定的 ID”。
        // 旧实现使用 \w，会把中文等 Unicode 字母全部过滤掉，导致 id 变成空字符串。
        id = rest.replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_]/gu, '')
      }
      const sg: MermaidSubgraph = { id, label, nodeIds: [], children: [] }
      subgraphStack.push(sg)
      continue
    }

    // --- subgraph end ---
    if (line === 'end') {
      const completed = subgraphStack.pop()
      if (completed) {
        if (subgraphStack.length > 0) {
          subgraphStack[subgraphStack.length - 1]!.children.push(completed)
        } else {
          graph.subgraphs.push(completed)
        }
      }
      continue
    }

    // --- Edge/node definitions ---
    parseEdgeLine(line, graph, subgraphStack)
  }

  return graph
}

// ============================================================================
// State diagram parser
//
// Supported syntax:
//   stateDiagram-v2
//   s1 : Description
//   state "Description" as s1
//   s1 --> s2 : label
//   [*] --> s1            (start pseudostate)
//   s1 --> [*]            (end pseudostate)
//   state CompositeState {
//     inner1 --> inner2
//   }
// ============================================================================

function parseStateDiagram(lines: string[]): MermaidGraph {
  const graph: MermaidGraph = {
    direction: 'TD',
    nodes: new Map(),
    edges: [],
    subgraphs: [],
    classDefs: new Map(),
    classAssignments: new Map(),
    nodeStyles: new Map(),
  }

  // Track composite state nesting (like subgraphs)
  const compositeStack: MermaidSubgraph[] = []
  // Counter for unique [*] pseudostate IDs
  let startCount = 0
  let endCount = 0

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!

    // --- direction override ---
    const dirMatch = line.match(/^direction\s+(TD|TB|LR|BT|RL)\s*$/i)
    if (dirMatch) {
      if (compositeStack.length > 0) {
        compositeStack[compositeStack.length - 1]!.direction = dirMatch[1]!.toUpperCase() as Direction
      } else {
        graph.direction = dirMatch[1]!.toUpperCase() as Direction
      }
      continue
    }

    // --- composite state start: `state CompositeState {` ---
    const compositeMatch = line.match(/^state\s+(?:"([^"]+)"\s+as\s+)?([\p{L}\p{N}_-]+)\s*\{$/u)
    if (compositeMatch) {
      const label = compositeMatch[1] ?? compositeMatch[2]!
      const id = compositeMatch[2]!
      const sg: MermaidSubgraph = { id, label, nodeIds: [], children: [] }
      compositeStack.push(sg)
      continue
    }

    // --- composite state end ---
    if (line === '}') {
      const completed = compositeStack.pop()
      if (completed) {
        if (compositeStack.length > 0) {
          compositeStack[compositeStack.length - 1]!.children.push(completed)
        } else {
          graph.subgraphs.push(completed)
        }
      }
      continue
    }

    // --- state alias: `state "Description" as s1` (without brace) ---
    const stateAliasMatch = line.match(/^state\s+"([^"]+)"\s+as\s+([\p{L}\p{N}_-]+)\s*$/u)
    if (stateAliasMatch) {
      const label = stateAliasMatch[1]!
      const id = stateAliasMatch[2]!
      registerStateNode(graph, compositeStack, { id, label, shape: 'rounded' })
      continue
    }

    // --- transition: `s1 --> s2` or `s1 --> s2 : label` or `[*] --> s1` ---
    const transitionMatch = line.match(/^(\[\*\]|[\p{L}\p{N}_-]+)\s*(-->)\s*(\[\*\]|[\p{L}\p{N}_-]+)(?:\s*:\s*(.+))?$/u)
    if (transitionMatch) {
      let sourceId = transitionMatch[1]!
      let targetId = transitionMatch[3]!
      const edgeLabel = transitionMatch[4]?.trim() || undefined

      // Handle [*] pseudostates — each occurrence gets a unique ID
      if (sourceId === '[*]') {
        startCount++
        sourceId = `_start${startCount > 1 ? startCount : ''}`
        registerStateNode(graph, compositeStack, { id: sourceId, label: '', shape: 'state-start' })
      } else {
        ensureStateNode(graph, compositeStack, sourceId)
      }

      if (targetId === '[*]') {
        endCount++
        targetId = `_end${endCount > 1 ? endCount : ''}`
        registerStateNode(graph, compositeStack, { id: targetId, label: '', shape: 'state-end' })
      } else {
        ensureStateNode(graph, compositeStack, targetId)
      }

      graph.edges.push({
        source: sourceId,
        target: targetId,
        label: edgeLabel,
        style: 'solid',
        hasArrowStart: false,
        hasArrowEnd: true,
      })
      continue
    }

    // --- state description: `s1 : Description` ---
    const stateDescMatch = line.match(/^([\p{L}\p{N}_-]+)\s*:\s*(.+)$/u)
    if (stateDescMatch) {
      const id = stateDescMatch[1]!
      const label = stateDescMatch[2]!.trim()
      registerStateNode(graph, compositeStack, { id, label, shape: 'rounded' })
      continue
    }
  }

  return graph
}

/** Register a state node and track in composite state if applicable */
function registerStateNode(
  graph: MermaidGraph,
  compositeStack: MermaidSubgraph[],
  node: MermaidNode
): void {
  const isNew = !graph.nodes.has(node.id)
  if (isNew) {
    graph.nodes.set(node.id, node)
  }
  if (compositeStack.length > 0) {
    const current = compositeStack[compositeStack.length - 1]!
    if (!current.nodeIds.includes(node.id)) {
      current.nodeIds.push(node.id)
    }
  }
}

/** Ensure a state node exists with default rounded shape */
function ensureStateNode(
  graph: MermaidGraph,
  compositeStack: MermaidSubgraph[],
  id: string
): void {
  if (!graph.nodes.has(id)) {
    registerStateNode(graph, compositeStack, { id, label: id, shape: 'rounded' })
  } else {
    // Track in composite if applicable
    if (compositeStack.length > 0) {
      const current = compositeStack[compositeStack.length - 1]!
      if (!current.nodeIds.includes(id)) {
        current.nodeIds.push(id)
      }
    }
  }
}

// ============================================================================
// Shared utilities
// ============================================================================

/** Parse "fill:#f00,stroke:#333" style property strings into a Record */
function parseStyleProps(propsStr: string): Record<string, string> {
  const props: Record<string, string> = {}
  for (const pair of propsStr.split(',')) {
    const colonIdx = pair.indexOf(':')
    if (colonIdx > 0) {
      const key = pair.slice(0, colonIdx).trim()
      const val = pair.slice(colonIdx + 1).trim()
      if (key && val) {
        props[key] = val
      }
    }
  }
  return props
}

// ============================================================================
// Flowchart edge line parser
//
// Handles chained edges like: A[Label] --> B(Label) -.-> C{Label}
// Also handles & parallel links: A & B --> C & D
// ============================================================================

/**
 * Arrow regex — matches all arrow operators with optional labels.
 *
 * Supported operators:
 *   -->  ---       solid arrow / solid line
 *   -.-> -.-       dotted arrow / dotted line
 *   ==>  ===       thick arrow / thick line
 *   <--> <-.-> <==>  bidirectional variants
 *
 * Optional label: -->|label text|
 */
const ARROW_REGEX = /^(<)?(-->|-.->|==>|---|-\.-|===)(?:\|([^|]*)\|)?/

/**
 * Node shape patterns — ordered from most specific delimiters to least.
 * Multi-char delimiters must be tried before single-char to avoid false matches.
 */
const NODE_PATTERNS: Array<{ regex: RegExp; shape: NodeShape }> = [
  // Triple delimiters (must be first)
  { regex: /^([\p{L}\p{N}_-]+)\(\(\((.+?)\)\)\)/u, shape: 'doublecircle' },  // A(((text)))

  // Double delimiters with mixed brackets
  { regex: /^([\p{L}\p{N}_-]+)\(\[(.+?)\]\)/u,     shape: 'stadium' },       // A([text])
  { regex: /^([\p{L}\p{N}_-]+)\(\((.+?)\)\)/u,     shape: 'circle' },        // A((text))
  { regex: /^([\p{L}\p{N}_-]+)\[\[(.+?)\]\]/u,     shape: 'subroutine' },    // A[[text]]
  { regex: /^([\p{L}\p{N}_-]+)\[\((.+?)\)\]/u,     shape: 'cylinder' },      // A[(text)]

  // Trapezoid variants — must come before plain [text]
  { regex: /^([\p{L}\p{N}_-]+)\[\/(.+?)\\\]/u,     shape: 'trapezoid' },     // A[/text\]
  { regex: /^([\p{L}\p{N}_-]+)\[\\(.+?)\/\]/u,     shape: 'trapezoid-alt' }, // A[\text/]

  // Asymmetric flag shape
  { regex: /^([\p{L}\p{N}_-]+)>(.+?)\]/u,          shape: 'asymmetric' },    // A>text]

  // Double curly braces (hexagon) — must come before single {text}
  { regex: /^([\p{L}\p{N}_-]+)\{\{(.+?)\}\}/u,     shape: 'hexagon' },       // A{{text}}

  // Single-char delimiters (last — most common, least specific)
  { regex: /^([\p{L}\p{N}_-]+)\[(.+?)\]/u,         shape: 'rectangle' },     // A[text]
  { regex: /^([\p{L}\p{N}_-]+)\((.+?)\)/u,         shape: 'rounded' },       // A(text)
  { regex: /^([\p{L}\p{N}_-]+)\{(.+?)\}/u,         shape: 'diamond' },       // A{text}
]

/** Regex for a bare node reference (just an ID, no shape brackets) */
const BARE_NODE_REGEX = /^([\p{L}\p{N}_-]+)/u

/** Regex for ::: class shorthand suffix — matches :::className immediately after a node */
const CLASS_SHORTHAND_REGEX = /^:::([\w][\w-]*)/

// ============================================================================
// Label helpers
// ============================================================================

/**
 * Mermaid 节点 label 可能会写成 `"..."` 的形式（尤其是由程序生成 Mermaid 时）。
 *
 * 对我们这个 parser 来说，外层引号不是 label 的一部分：
 * - `A["task.start"]` 的 label 应当是 `task.start`
 * - `A[📋 规格撰写者]` 保持原样
 *
 * 说明：
 * - 这里只做“最小可用”的反转义：把 `\"` 还原为 `"`。
 * - 其它复杂 Mermaid 转义规则不在本项目 parser 的目标范围内（我们更偏向轻量可用）。
 */
function normalizeMermaidLabel(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed.slice(1, -1)
    return inner.replaceAll('\\"', '"')
  }
  return raw
}

/**
 * Parse a line that contains node definitions and edges.
 * Handles chaining: A --> B --> C produces edges A→B and B→C.
 * Handles parallel links: A & B --> C & D produces 4 edges.
 */
function parseEdgeLine(
  line: string,
  graph: MermaidGraph,
  subgraphStack: MermaidSubgraph[]
): void {
  let remaining = line.trim()

  // Parse the first node group (possibly with & separators)
  const firstGroup = consumeNodeGroup(remaining, graph, subgraphStack)
  if (!firstGroup || firstGroup.ids.length === 0) return

  remaining = firstGroup.remaining.trim()
  let prevGroupIds = firstGroup.ids

  // Parse arrow + node-group pairs until the line is exhausted
  while (remaining.length > 0) {
    const arrowMatch = remaining.match(ARROW_REGEX)
    if (!arrowMatch) break

    const hasArrowStart = Boolean(arrowMatch[1])
    const arrowOp = arrowMatch[2]!
    const edgeLabel = arrowMatch[3]?.trim() || undefined
    remaining = remaining.slice(arrowMatch[0].length).trim()

    const style = arrowStyleFromOp(arrowOp)
    const hasArrowEnd = arrowOp.endsWith('>')

    // Parse the next node group
    const nextGroup = consumeNodeGroup(remaining, graph, subgraphStack)
    if (!nextGroup || nextGroup.ids.length === 0) break

    remaining = nextGroup.remaining.trim()

    // Emit Cartesian product of edges: every source × every target
    for (const sourceId of prevGroupIds) {
      for (const targetId of nextGroup.ids) {
        graph.edges.push({
          source: sourceId,
          target: targetId,
          label: edgeLabel,
          style,
          hasArrowStart,
          hasArrowEnd,
        })
      }
    }

    prevGroupIds = nextGroup.ids
  }
}

interface ConsumedNodeGroup {
  ids: string[]
  remaining: string
}

/**
 * Consume one or more nodes separated by `&`.
 * E.g. "A & B & C --> ..." returns ids: ['A', 'B', 'C']
 */
function consumeNodeGroup(
  text: string,
  graph: MermaidGraph,
  subgraphStack: MermaidSubgraph[]
): ConsumedNodeGroup | null {
  const first = consumeNode(text, graph, subgraphStack)
  if (!first) return null

  const ids = [first.id]
  let remaining = first.remaining.trim()

  // Check for & separators
  while (remaining.startsWith('&')) {
    remaining = remaining.slice(1).trim()
    const next = consumeNode(remaining, graph, subgraphStack)
    if (!next) break
    ids.push(next.id)
    remaining = next.remaining.trim()
  }

  return { ids, remaining }
}

interface ConsumedNode {
  id: string
  remaining: string
}

/**
 * Try to consume a node definition from the start of `text`.
 * If the node has a shape+label (e.g. A[Text]), it's registered in the graph.
 * If it's a bare reference (e.g. A), we look it up or create a default.
 * Also handles ::: class shorthand suffix.
 */
function consumeNode(
  text: string,
  graph: MermaidGraph,
  subgraphStack: MermaidSubgraph[]
): ConsumedNode | null {
  let id: string | null = null
  let remaining: string = text

  // Try each node pattern (shape-qualified)
  for (const { regex, shape } of NODE_PATTERNS) {
    const match = text.match(regex)
    if (match) {
      id = match[1]!
      const label = normalizeMermaidLabel(match[2]!)
      registerNode(graph, subgraphStack, { id, label, shape })
      remaining = text.slice(match[0].length)
      break
    }
  }

  // Bare node reference
  if (id === null) {
    const bareMatch = text.match(BARE_NODE_REGEX)
    if (bareMatch) {
      // -------------------------------------------------------------------
      // Mermaid 常见写法兼容：`A-->B`（无空格）
      //
      // 问题：
      // - BARE_NODE_REGEX 允许 `-`，因此遇到 `A-->B` 时会把 `A--` 误吞成 node id，
      //   导致剩余串以 `>B` 开头，后续 ARROW_REGEX 无法匹配，整行边会丢失。
      //
      // 解决：
      // - 先按旧逻辑贪婪拿到候选 id（尽量保持兼容性）；
      // - 再在候选里做“回退截断”，找到一个切分点，让剩余串能被识别为：
      //   1) 箭头/连线操作符（ARROW_REGEX）
      //   2) `&`（node group 分隔）
      //   3) 空白（后续会 trim）
      //   4) `:::`（class shorthand）
      //   5) 行尾
      //
      // 这样既保留 `my-node` 这种带 `-` 的合法 id，又支持 `A-->B` 这种无空格连线。
      // -------------------------------------------------------------------
      const greedyId = bareMatch[1]!
      const cut = findBareNodeCut(text, greedyId.length)
      id = text.slice(0, cut)

      if (!graph.nodes.has(id)) {
        registerNode(graph, subgraphStack, { id, label: id, shape: 'rectangle' })
      } else {
        trackInSubgraph(subgraphStack, id)
      }
      remaining = text.slice(cut)
    }
  }

  if (id === null) return null

  // Check for ::: class shorthand suffix immediately after the node
  const classMatch = remaining.match(CLASS_SHORTHAND_REGEX)
  if (classMatch) {
    graph.classAssignments.set(id, classMatch[1]!)
    remaining = remaining.slice(classMatch[0].length)
  }

  return { id, remaining }
}

/**
 * 为 bare node 的贪婪匹配结果选择一个“合理切分点”。
 *
 * 目标：
 * - 修复 `A-->B` / `A---B` / `A-.-B` 等无空格连线被误吞的问题；
 * - 尽量保持旧行为：如果本来就有空格/分隔符，直接返回最大 cut（不改变 id）。
 */
function findBareNodeCut(text: string, greedyLen: number): number {
  // -----------------------------------------------------------------------
  // 优先尝试“切出一个箭头”：
  // - 这是为了解决 `A---B` 这种特殊情况：
  //   `---` 全是 `-`，在旧逻辑里会被当作 id 的一部分，
  //   甚至连 target（B）都会被吞进 greedy id，导致整条边消失。
  //
  // 这里我们先找一个 cut，使得：
  // 1) rest 以 ARROW_REGEX 开头；
  // 2) arrow 之后确实还有一个可作为 node 起始的 token（避免把 `A---` 误判成边）。
  //
  // 一旦找到，就立即返回“最大的”可行 cut（从长到短回退，先命中的就是最大）。
  // -----------------------------------------------------------------------
  for (let cut = greedyLen; cut >= 1; cut--) {
    const rest = text.slice(cut)
    const arrowMatch = rest.match(ARROW_REGEX)
    if (!arrowMatch) continue

    const afterArrow = rest.slice(arrowMatch[0].length).trimStart()
    if (afterArrow.length === 0) continue
    if (!BARE_NODE_REGEX.test(afterArrow)) continue

    return cut
  }

  // -----------------------------------------------------------------------
  // 回退：常规分隔符（保持旧行为为主）
  // -----------------------------------------------------------------------
  for (let cut = greedyLen; cut >= 1; cut--) {
    const rest = text.slice(cut)

    // 1) 行尾：单独声明节点，如 `A`
    if (rest.length === 0) return cut

    // 2) 空白：如 `A --> B`（后续 parseEdgeLine 会 trim）
    const first = rest[0]!
    if (/\s/.test(first)) return cut

    // 3) node group：如 `A&B --> C`
    if (first === '&') return cut

    // 4) class shorthand：如 `A:::highlight --> B`
    if (rest.startsWith(':::')) return cut
  }

  // 防御性 fallback：理论上不会到这里（greedyLen>=1），但为了健壮性保留。
  return Math.max(1, greedyLen)
}

/** Register a node in the graph and track it in the current subgraph */
function registerNode(
  graph: MermaidGraph,
  subgraphStack: MermaidSubgraph[],
  node: MermaidNode
): void {
  const isNew = !graph.nodes.has(node.id)
  if (isNew) {
    graph.nodes.set(node.id, node)
  }
  trackInSubgraph(subgraphStack, node.id)
}

/** Add node ID to the innermost subgraph if we're inside one */
function trackInSubgraph(subgraphStack: MermaidSubgraph[], nodeId: string): void {
  if (subgraphStack.length > 0) {
    const current = subgraphStack[subgraphStack.length - 1]!
    if (!current.nodeIds.includes(nodeId)) {
      current.nodeIds.push(nodeId)
    }
  }
}

/** Map arrow operator string to edge style (ignoring direction) */
function arrowStyleFromOp(op: string): EdgeStyle {
  if (op === '-.->') return 'dotted'
  if (op === '-.-') return 'dotted'
  if (op === '==>') return 'thick'
  if (op === '===') return 'thick'
  // '-->'' and '---' are both solid
  return 'solid'
}
