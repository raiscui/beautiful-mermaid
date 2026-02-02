/**
 * Unicode testdata 全量“可逆自证”回归测试
 *
 * 用户硬性验收标准（扩展版）：
 * - `src/__tests__/testdata/unicode/*.txt` 中的所有 Mermaid 用例：
 *   - 都能由“自身渲染出的 Unicode 字符画”反向解析回 Mermaid；
 *   - 反解 Mermaid 与原 Mermaid 逻辑一致（允许 id 不同）。
 *
 * 重要说明：
 * - 这里的“逻辑一致”是语义一致，不要求文本字面一致。
 * - Flowchart 需要支持“重复 label”的图同构（不能只用 label 当身份）。
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  renderMermaidAscii,
  reverseFlowchartAsciiToMermaid,
  reverseSequenceAsciiToMermaid,
  reverseClassAsciiToMermaid,
  reverseErAsciiToMermaid,
} from '../ascii/index.ts'

import { parseMermaid } from '../parser.ts'
import type { MermaidGraph, MermaidEdge } from '../types.ts'
import { parseSequenceDiagram } from '../sequence/parser.ts'
import type { SequenceDiagram } from '../sequence/types.ts'
import { parseClassDiagram } from '../class/parser.ts'
import type { ClassDiagram, ClassRelationship } from '../class/types.ts'
import { parseErDiagram } from '../er/parser.ts'
import type { ErDiagram, ErRelationship } from '../er/types.ts'

// ============================================================================
// Testdata loader
// ============================================================================

function extractMermaidFromGolden(content: string): string {
  const lines = content.split('\n')
  const mermaidLines: string[] = []

  for (const line of lines) {
    if (line === '---') break
    mermaidLines.push(line)
  }

  // 与 ascii.test.ts 的行为一致：保留结尾换行
  return mermaidLines.join('\n') + '\n'
}

function detectDiagramType(text: string): 'flowchart' | 'sequence' | 'class' | 'er' {
  const firstLine = text.trim().split(/[\n;]/)[0]?.trim().toLowerCase() ?? ''
  if (/^sequencediagram\s*$/.test(firstLine)) return 'sequence'
  if (/^classdiagram\s*$/.test(firstLine)) return 'class'
  if (/^erdiagram\s*$/.test(firstLine)) return 'er'
  return 'flowchart'
}

function extractFlowDirection(text: string): MermaidGraph['direction'] {
  const firstLine = text.trim().split('\n')[0]?.trim() ?? ''
  const m = firstLine.match(/^(?:graph|flowchart)\s+([A-Za-z]{2})\b/)
  const dir = (m?.[1]?.toUpperCase() ?? 'LR') as MermaidGraph['direction']
  return dir
}

// ============================================================================
// Flowchart 图同构（允许 id 不同；允许 label 重复）
// ============================================================================

function nodeLabel(graph: MermaidGraph, id: string): string {
  return (graph.nodes.get(id)?.label ?? id).trim()
}

function edgeKey(graph: MermaidGraph, e: MermaidEdge, mapping?: Map<string, string>): string {
  const src = mapping ? (mapping.get(e.source) ?? e.source) : e.source
  const tgt = mapping ? (mapping.get(e.target) ?? e.target) : e.target
  const label = (e.label ?? '').trim()
  // 这里把边的“有无箭头/线型”也纳入，避免把无箭头边误当作同一条
  return `${src}->${tgt}|${label}|${e.style}|${e.hasArrowStart ? 1 : 0}${e.hasArrowEnd ? 1 : 0}`
}

function multiset<T>(items: T[]): Map<T, number> {
  const m = new Map<T, number>()
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1)
  return m
}

function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr.slice()]
  const out: T[][] = []
  for (let i = 0; i < arr.length; i++) {
    const head = arr[i]!
    const rest = arr.slice(0, i).concat(arr.slice(i + 1))
    for (const p of permutations(rest)) out.push([head, ...p])
  }
  return out
}

function isomorphicByLabelAndEdges(g1: MermaidGraph, g2: MermaidGraph): boolean {
  // 1) label 分组必须一致
  const groups1 = new Map<string, string[]>()
  const groups2 = new Map<string, string[]>()

  for (const n of g1.nodes.values()) {
    const l = n.label.trim()
    groups1.set(l, [...(groups1.get(l) ?? []), n.id])
  }
  for (const n of g2.nodes.values()) {
    const l = n.label.trim()
    groups2.set(l, [...(groups2.get(l) ?? []), n.id])
  }

  if (groups1.size !== groups2.size) return false
  for (const [label, ids1] of groups1.entries()) {
    const ids2 = groups2.get(label)
    if (!ids2 || ids2.length !== ids1.length) return false
  }

  const labels = [...groups1.keys()].sort()

  // 2) 预构建 g2 的 edge multiset（key 用 g2 id）
  const g2EdgeKeys = g2.edges.map(e => edgeKey(g2, e))
  const g2Counts = multiset(g2EdgeKeys)

  // 3) 枚举 label 分组内部的置换（通常极小；重复 label 才会爆炸）
  const mapping = new Map<string, string>()

  function backtrack(i: number): boolean {
    if (i >= labels.length) {
      // 检查边 multiset 是否一致
      const remaining = new Map(g2Counts)
      for (const e of g1.edges) {
        const k = edgeKey(g1, e, mapping)
        const c = remaining.get(k) ?? 0
        if (c <= 0) return false
        if (c === 1) remaining.delete(k)
        else remaining.set(k, c - 1)
      }
      return remaining.size === 0
    }

    const label = labels[i]!
    const ids1 = groups1.get(label)!
    const ids2 = groups2.get(label)!

    for (const perm of permutations(ids2)) {
      // assign
      for (let k = 0; k < ids1.length; k++) mapping.set(ids1[k]!, perm[k]!)
      if (backtrack(i + 1)) return true
      for (const id of ids1) mapping.delete(id)
    }
    return false
  }

  return backtrack(0)
}

// ============================================================================
// Sequence / Class / ER 语义对比（id 允许不同）
// ============================================================================

function parseSequenceText(text: string): SequenceDiagram {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('%%'))
  return parseSequenceDiagram(lines)
}

function sequenceMessageKeys(diagram: SequenceDiagram): string[] {
  const labelById = new Map(diagram.actors.map(a => [a.id, a.label.trim()] as const))
  return diagram.messages.map(m => {
    const from = labelById.get(m.from) ?? m.from
    const to = labelById.get(m.to) ?? m.to
    return `${from}->${to}|${m.label.trim()}|${m.lineStyle}|${m.arrowHead}`
  })
}

function parseClassText(text: string): ClassDiagram {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('%%'))
  return parseClassDiagram(lines)
}

function classRelKey(r: ClassRelationship): string {
  const label = (r.label ?? '').trim()

  // 归一化：
  // - hierarchical（inheritance/realization）：用 parent/child，不受 markerAt/from-to 语法影响
  // - composition/aggregation：用 whole/part（markerAt 决定 diamond 在哪一端）
  if (r.type === 'inheritance' || r.type === 'realization') {
    const parent = r.markerAt === 'to' ? r.to : r.from
    const child = r.markerAt === 'to' ? r.from : r.to
    return `H:${r.type}:${parent}->${child}:${label}`
  }

  if (r.type === 'composition' || r.type === 'aggregation') {
    const whole = r.markerAt === 'to' ? r.to : r.from
    const part = r.markerAt === 'to' ? r.from : r.to
    return `W:${r.type}:${whole}->${part}:${label}`
  }

  // association/dependency：方向就是 from -> to
  return `D:${r.type}:${r.from}->${r.to}:${label}`
}

function parseErText(text: string): ErDiagram {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('%%'))
  return parseErDiagram(lines)
}

function erRelKey(r: ErRelationship): string {
  const label = r.label.trim()
  const style = r.identifying ? '--' : '..'

  // 无向归一：按实体名排序，同时交换对应 cardinality
  if (r.entity1 <= r.entity2) {
    return `${r.entity1}|${r.cardinality1}|${style}|${r.entity2}|${r.cardinality2}|${label}`
  }
  return `${r.entity2}|${r.cardinality2}|${style}|${r.entity1}|${r.cardinality1}|${label}`
}

// ============================================================================
// Test runner
// ============================================================================

describe('Unicode testdata roundtrip (render -> reverse -> parse)', () => {
  const unicodeDir = join(import.meta.dir, 'testdata', 'unicode')
  const files = readdirSync(unicodeDir).filter(f => f.endsWith('.txt')).sort()

  for (const file of files) {
    it(file.replace('.txt', ''), () => {
      const content = readFileSync(join(unicodeDir, file), 'utf-8')
      const mermaid = extractMermaidFromGolden(content)
      const type = detectDiagramType(mermaid)

      const unicode = renderMermaidAscii(mermaid, { useAscii: false })

      // 额外硬约束（Flowchart/State）：不允许出现“┼”
      if (type === 'flowchart') {
        expect(unicode).not.toContain('┼')
      }

      if (type === 'flowchart') {
        const direction = extractFlowDirection(mermaid)
        const reversed = reverseFlowchartAsciiToMermaid(unicode, { direction })

        const g1 = parseMermaid(mermaid)
        const g2 = parseMermaid(reversed)

        expect(isomorphicByLabelAndEdges(g1, g2)).toBe(true)
        return
      }

      if (type === 'sequence') {
        const reversed = reverseSequenceAsciiToMermaid(unicode)
        const d1 = parseSequenceText(mermaid)
        const d2 = parseSequenceText(reversed)
        expect(sequenceMessageKeys(d2)).toEqual(sequenceMessageKeys(d1))
        return
      }

      if (type === 'class') {
        const reversed = reverseClassAsciiToMermaid(unicode)
        const c1 = parseClassText(mermaid)
        const c2 = parseClassText(reversed)

        // classes：按 label 对齐（unicode testdata 里 class 名唯一）
        const byLabel1 = new Map(c1.classes.map(c => [c.label, c] as const))
        const byLabel2 = new Map(c2.classes.map(c => [c.label, c] as const))
        expect([...byLabel2.keys()].sort()).toEqual([...byLabel1.keys()].sort())

        for (const [label, cls1] of byLabel1.entries()) {
          const cls2 = byLabel2.get(label)!
          expect(cls2.annotation ?? '').toBe(cls1.annotation ?? '')
          expect(cls2.attributes).toEqual(cls1.attributes)
          expect(cls2.methods).toEqual(cls1.methods)
        }

        // relationships：做语义归一后比较（解决 realization/inheritance 的语法差异）
        const rels1 = c1.relationships.map(classRelKey).sort()
        const rels2 = c2.relationships.map(classRelKey).sort()
        expect(rels2).toEqual(rels1)
        return
      }

      if (type === 'er') {
        const reversed = reverseErAsciiToMermaid(unicode)
        const e1 = parseErText(mermaid)
        const e2 = parseErText(reversed)

        const byLabel1 = new Map(e1.entities.map(e => [e.label, e] as const))
        const byLabel2 = new Map(e2.entities.map(e => [e.label, e] as const))
        expect([...byLabel2.keys()].sort()).toEqual([...byLabel1.keys()].sort())

        for (const [label, ent1] of byLabel1.entries()) {
          const ent2 = byLabel2.get(label)!
          expect(ent2.attributes).toEqual(ent1.attributes)
        }

        const rels1 = e1.relationships.map(erRelKey).sort()
        const rels2 = e2.relationships.map(erRelKey).sort()
        expect(rels2).toEqual(rels1)
        return
      }
    })
  }
})

