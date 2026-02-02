import { describe, it, expect } from 'bun:test'
import { parseMermaid } from '../parser.ts'
import { convertToAsciiGraph } from '../ascii/converter.ts'
import { createMapping } from '../ascii/grid.ts'
import { drawArrow, drawGraph } from '../ascii/draw.ts'
import { mergeCanvases, getCanvasSize } from '../ascii/canvas.ts'
import type { AsciiConfig, Canvas, DrawingCoord } from '../ascii/types.ts'

// ============================================================================
// 回归测试：edge label 不应覆盖“交错/分叉”关键符号
//
// 用户反馈：
// - “线交错的位置,不要出现线上文字,比如 spec.ready 不要写在十字交叉处”
//
// 根因：
// - label 是最后一层，如果不避让，会把 `┼/┬/┴/...` 覆盖成文字，读图会迷路。
//
// 验收：
// - 在“线路层已合成但尚未写入 label”的 baseCanvas 里，记录所有 junction/corner/arrow 位置；
// - 生成带 label 的 fullCanvas 后，这些位置的字符必须保持不变（没有被 label 覆盖）。
// ============================================================================

function buildConfig(parsedDirection: string, useAscii: boolean): AsciiConfig {
  return {
    useAscii,
    paddingX: 5,
    paddingY: 5,
    boxBorderPadding: 1,
    graphDirection: (parsedDirection === 'LR' || parsedDirection === 'RL') ? 'LR' : 'TD',
  }
}

function buildBaseCanvas(mermaid: string, useAscii: boolean): Canvas {
  const parsed = parseMermaid(mermaid)
  const config = buildConfig(parsed.direction, useAscii)
  const graph = convertToAsciiGraph(parsed, config)
  createMapping(graph)

  // 先画 node box（与 drawGraph 一致）
  for (const node of graph.nodes) {
    if (node.drawingCoord && node.drawing) {
      graph.canvas = mergeCanvases(graph.canvas, node.drawingCoord, useAscii, node.drawing)
      node.drawn = true
    }
  }

  // 再合成线路层（lines/corners/arrowheads/boxStart），但不合成 label
  const lineCanvases: Canvas[] = []
  const cornerCanvases: Canvas[] = []
  const arrowHeadCanvases: Canvas[] = []
  const boxStartCanvases: Canvas[] = []

  for (const edge of graph.edges) {
    const [pathC, boxStartC, arrowHeadC, cornersC] = drawArrow(graph, edge)
    lineCanvases.push(pathC)
    cornerCanvases.push(cornersC)
    arrowHeadCanvases.push(arrowHeadC)
    boxStartCanvases.push(boxStartC)
  }

  const zero: DrawingCoord = { x: 0, y: 0 }
  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...lineCanvases)
  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...cornerCanvases)
  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...arrowHeadCanvases)
  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...boxStartCanvases)

  return graph.canvas
}

function buildFullCanvas(mermaid: string, useAscii: boolean): Canvas {
  const parsed = parseMermaid(mermaid)
  const config = buildConfig(parsed.direction, useAscii)
  const graph = convertToAsciiGraph(parsed, config)
  createMapping(graph)
  return drawGraph(graph)
}

function isProtectedChar(c: string, useAscii: boolean): boolean {
  if (useAscii) {
    // `+` 是 ASCII 的 corner/junction；`<>^v*` 是箭头符号
    return c === '+' || c === '<' || c === '>' || c === '^' || c === 'v' || c === '*'
  }

  // Unicode：junction/corner + arrowheads
  return c === '┼' || c === '┬' || c === '┴' || c === '├' || c === '┤' ||
    c === '┌' || c === '┐' || c === '└' || c === '┘' ||
    c === '▲' || c === '▼' || c === '◄' || c === '►' ||
    c === '◥' || c === '◤' || c === '◢' || c === '◣' || c === '●'
}

function collectProtectedCells(canvas: Canvas, useAscii: boolean): Array<{ x: number; y: number; c: string }> {
  const cells: Array<{ x: number; y: number; c: string }> = []
  const [maxX, maxY] = getCanvasSize(canvas)
  for (let x = 0; x <= maxX; x++) {
    for (let y = 0; y <= maxY; y++) {
      const c = canvas[x]![y]!
      if (isProtectedChar(c, useAscii)) cells.push({ x, y, c })
    }
  }
  return cells
}

describe('ASCII/Unicode 渲染：edge label 不覆盖交错/分叉符号', () => {
  const mermaid = `flowchart LR
Hat_spec_logger[<0001f9fe> 规格记录员]
Hat_spec_reviewer[🔎 规格审阅者]
Hat_spec_writer[📋 规格撰写者]
Start[task.start]
Start -->|spec.start| Hat_spec_writer
Hat_spec_reviewer -->|spec.rejected| Hat_spec_logger
Hat_spec_reviewer -->|spec.rejected| Hat_spec_writer
Hat_spec_writer -->|spec.ready| Hat_spec_logger
Hat_spec_writer -->|spec.ready| Hat_spec_reviewer
`

  it('Unicode：label 不应覆盖 ┼/┬/┴/... 或箭头', () => {
    const base = buildBaseCanvas(mermaid, false)
    const full = buildFullCanvas(mermaid, false)

    const protectedCells = collectProtectedCells(base, false)
    expect(protectedCells.length).toBeGreaterThan(0)

    for (const p of protectedCells) {
      expect(full[p.x]![p.y]!).toBe(p.c)
    }
  })

  it('ASCII：label 不应覆盖 + 或箭头', () => {
    const base = buildBaseCanvas(mermaid, true)
    const full = buildFullCanvas(mermaid, true)

    const protectedCells = collectProtectedCells(base, true)
    expect(protectedCells.length).toBeGreaterThan(0)

    for (const p of protectedCells) {
      expect(full[p.x]![p.y]!).toBe(p.c)
    }
  })
})

