// ============================================================================
// ASCII/Unicode 反向解析 — 网格工具
//
// 背景：
// - 我们的 renderer 在 Unicode 输出时，会把“宽字符”（中文/emoji）视为占 2 列；
// - 但最终输出字符串里只包含 1 个字符本身，第二列会被 canvasToString() “跳过”；
// - 反向解析（字符画 → Mermaid）必须把这“缺失的一列”补回来，否则坐标会整体漂移，
//   box / arrow / line 都会对不上。
//
// 结论：
// - 反解阶段要用“终端显示宽度”来构造二维网格；
// - 宽字符的第二列用占位符补齐，后续提取文本时再去掉占位符。
// ============================================================================

import { charDisplayWidth } from './canvas.ts'

/** 宽字符占位符：用于补齐被输出阶段跳过的“第二列”。 */
export const WIDE_PLACEHOLDER = '\u0000'

/** 去掉宽字符占位符，得到用户可读的文本。 */
export function stripWidePlaceholders(text: string): string {
  return text.replaceAll(WIDE_PLACEHOLDER, '')
}

/** 计算一行文本的“终端显示宽度”（按列）。 */
function lineDisplayWidth(line: string): number {
  let width = 0
  for (const ch of line) width += charDisplayWidth(ch)
  return width
}

/**
 * 把输出的 Unicode 字符画转换为二维网格（grid[y][x]）。
 * - 网格宽度以“终端显示宽度”为准；
 * - 遇到宽字符时，在其后补 1 个占位符列，确保后续坐标计算稳定。
 */
export function toUnicodeGrid(text: string): { grid: string[][]; width: number; height: number } {
  const lines = text.split('\n')
  const width = lines.reduce((m, l) => Math.max(m, lineDisplayWidth(l)), 0)

  const grid = lines.map((line) => {
    const cells: string[] = []
    for (const ch of line) {
      const w = charDisplayWidth(ch)
      cells.push(ch)
      if (w === 2) cells.push(WIDE_PLACEHOLDER)
    }
    while (cells.length < width) cells.push(' ')
    return cells
  })

  return { grid, width, height: grid.length }
}

