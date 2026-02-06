// ============================================================================
// beautiful-mermaid — ASCII renderer public API
//
// Renders Mermaid diagrams to ASCII or Unicode box-drawing art.
// No external dependencies — pure TypeScript.
//
// Supported diagram types:
//   - Flowcharts (graph TD / flowchart LR) — grid-based layout with A* pathfinding
//   - State diagrams (stateDiagram-v2) — same pipeline as flowcharts
//   - Sequence diagrams (sequenceDiagram) — column-based timeline layout
//   - Class diagrams (classDiagram) — level-based UML layout
//   - ER diagrams (erDiagram) — grid layout with crow's foot notation
//
// Usage:
//   import { renderMermaidAscii } from 'beautiful-mermaid'
//   const ascii = renderMermaidAscii('graph LR\n  A --> B')
// ============================================================================

import { parseMermaid } from '../parser.ts'
import { convertToAsciiGraph } from './converter.ts'
import { createMapping } from './grid.ts'
import { computeEdgeStrokeCoords, drawGraph } from './draw.ts'
import { canvasToString, flipCanvasVertically, deambiguateUnicodeCrossings, getCanvasSize } from './canvas.ts'
import { renderSequenceAscii } from './sequence.ts'
import { renderClassAscii } from './class-diagram.ts'
import { renderErAscii } from './er-diagram.ts'
import type { AsciiConfig, AsciiGraph, AsciiRenderMeta, AsciiRenderWithMeta } from './types.ts'
export { reverseFlowchartAsciiToMermaid } from './reverse-flowchart.ts'
export { reverseSequenceAsciiToMermaid } from './reverse-sequence.ts'
export { reverseClassAsciiToMermaid } from './reverse-class-diagram.ts'
export { reverseErAsciiToMermaid } from './reverse-er.ts'
export type { AsciiRenderMeta, AsciiRenderMetaNode, AsciiRenderMetaEdge, AsciiRenderWithMeta } from './types.ts'

export interface AsciiRenderOptions {
  /** true = ASCII chars (+,-,|,>), false = Unicode box-drawing (┌,─,│,►). Default: false */
  useAscii?: boolean
  /** Horizontal spacing between nodes. Default: 5 */
  paddingX?: number
  /** Vertical spacing between nodes. Default: 5 */
  paddingY?: number
  /** Padding inside node boxes. Default: 1 */
  boxBorderPadding?: number

  /**
   * 路由模式（仅 flowchart/state 生效）：
   * - strict：规整/可逆优先（更少交叉/共线，但可能绕远）
   * - relaxed：可读性优先（允许交叉/复用，配合“桥化”减少 `┼` 歧义）
   *
   * 默认值：
   * - Unicode（useAscii=false）：relaxed
   * - ASCII（useAscii=true）：strict
   */
  routing?: 'strict' | 'relaxed'
}

/**
 * Detect the diagram type from the mermaid source text.
 * Mirrors the detection logic in src/index.ts for the SVG renderer.
 */
function detectDiagramType(text: string): 'flowchart' | 'sequence' | 'class' | 'er' {
  const firstLine = text.trim().split(/[\n;]/)[0]?.trim().toLowerCase() ?? ''

  if (/^sequencediagram\s*$/.test(firstLine)) return 'sequence'
  if (/^classdiagram\s*$/.test(firstLine)) return 'class'
  if (/^erdiagram\s*$/.test(firstLine)) return 'er'

  // Default: flowchart/state (handled by parseMermaid internally)
  return 'flowchart'
}

function buildAsciiConfig(options: AsciiRenderOptions): AsciiConfig {
  const useAscii = options.useAscii ?? false
  const routing = options.routing ?? (useAscii ? 'strict' : 'relaxed')
  return {
    useAscii,
    paddingX: options.paddingX ?? 5,
    paddingY: options.paddingY ?? 5,
    boxBorderPadding: options.boxBorderPadding ?? 1,
    graphDirection: 'TD', // 默认值；flowchart/state 会在下方覆盖
    routing,
  }
}

function renderFlowchartAsciiGraph(text: string, config: AsciiConfig): { graph: AsciiGraph; flippedVertically: boolean } {
  // Flowchart + state diagram 渲染管线（复用既有实现）
  const parsed = parseMermaid(text)

  // 归一化方向，方便 grid 布局：
  // - BT：先按 TD 布局，然后在绘制完成后做一次垂直翻转
  // - RL：当前按 LR 处理（完整 RL 支持尚未实现）
  if (parsed.direction === 'LR' || parsed.direction === 'RL') {
    config.graphDirection = 'LR'
  } else {
    config.graphDirection = 'TD'
  }

  const graph = convertToAsciiGraph(parsed, config)
  createMapping(graph)
  drawGraph(graph)

  // BT：把最终 canvas 垂直翻转，让流程从下往上阅读。
  // grid 布局是 TD；翻转 + 字符映射后就是 BT 视觉效果。
  const flippedVertically = parsed.direction === 'BT'
  if (flippedVertically) {
    flipCanvasVertically(graph.canvas)
  }

  // Unicode：去掉“┼”交叉点的歧义（改成“桥”）
  if (!graph.config.useAscii) {
    deambiguateUnicodeCrossings(graph.canvas)
  }

  return { graph, flippedVertically }
}

function extractFlowchartMeta(graph: AsciiGraph): AsciiRenderMeta {
  const nodes = graph.nodes
    .filter(n => n.drawingCoord && n.drawing)
    .map(n => {
      const [maxX, maxY] = getCanvasSize(n.drawing!)
      return {
        id: n.name,
        label: n.displayLabel,
        box: {
          x: n.drawingCoord!.x,
          y: n.drawingCoord!.y,
          width: maxX + 1,
          height: maxY + 1,
        },
      }
    })

  const edges = graph.edges.map(e => ({
    from: e.from.name,
    to: e.to.name,
    label: e.text,
    path: computeEdgeStrokeCoords(graph, e),
  }))

  return { nodes, edges }
}

function flipMetaVertically(meta: AsciiRenderMeta, maxY: number): AsciiRenderMeta {
  return {
    nodes: meta.nodes.map(n => ({
      ...n,
      box: {
        ...n.box,
        // 矩形垂直翻转：newTop = maxY - oldBottom
        y: maxY - (n.box.y + n.box.height - 1),
      },
    })),
    edges: meta.edges.map(e => ({
      ...e,
      path: e.path.map(p => ({ x: p.x, y: maxY - p.y })),
    })),
  }
}

/**
 * Render Mermaid diagram text to an ASCII/Unicode string.
 *
 * Synchronous — no async layout engine needed (unlike the SVG renderer).
 * Auto-detects diagram type from the header line and dispatches to
 * the appropriate renderer.
 *
 * @param text - Mermaid source text (any supported diagram type)
 * @param options - Rendering options
 * @returns Multi-line ASCII/Unicode string
 *
 * @example
 * ```ts
 * const result = renderMermaidAscii(`
 *   graph LR
 *     A --> B --> C
 * `, { useAscii: true })
 *
 * // Output:
 * // +---+     +---+     +---+
 * // |   |     |   |     |   |
 * // | A |---->| B |---->| C |
 * // |   |     |   |     |   |
 * // +---+     +---+     +---+
 * ```
 */
export function renderMermaidAscii(
  text: string,
  options: AsciiRenderOptions = {},
): string {
  const config: AsciiConfig = buildAsciiConfig(options)

  const diagramType = detectDiagramType(text)

  switch (diagramType) {
    case 'sequence':
      return renderSequenceAscii(text, config)

    case 'class':
      return renderClassAscii(text, config)

    case 'er':
      return renderErAscii(text, config)

    case 'flowchart':
    default: {
      const { graph } = renderFlowchartAsciiGraph(text, config)
      return canvasToString(graph.canvas)
    }
  }
}

/**
 * 渲染 Mermaid 到 ASCII/Unicode 字符画，并返回 renderer meta。
 *
 * 这个 API 的目标用户是 UI（尤其是 TUI）：
 * - 需要稳定的 cell-level 信息来做上色/动画
 * - 不希望靠“再解析字符画”这种脆弱方式来取坐标
 *
 * 说明：
 * - 目前只有 flowchart/state 会返回有效 meta
 * - 其它图类型会返回空的 meta（nodes/edges 为空）
 */
export function renderMermaidAsciiWithMeta(
  text: string,
  options: AsciiRenderOptions = {},
): AsciiRenderWithMeta {
  const config: AsciiConfig = buildAsciiConfig(options)
  const diagramType = detectDiagramType(text)

  switch (diagramType) {
    case 'sequence':
    case 'class':
    case 'er': {
      // TODO：后续如有需求，再为这些图类型补齐 meta。
      return { text: renderMermaidAscii(text, options), meta: { nodes: [], edges: [] } }
    }
    case 'flowchart':
    default: {
      const { graph, flippedVertically } = renderFlowchartAsciiGraph(text, config)
      const textOut = canvasToString(graph.canvas)

      const meta = extractFlowchartMeta(graph)
      if (!flippedVertically) {
        return { text: textOut, meta }
      }

      const [, maxY] = getCanvasSize(graph.canvas)
      return { text: textOut, meta: flipMetaVertically(meta, maxY) }
    }
  }
}
