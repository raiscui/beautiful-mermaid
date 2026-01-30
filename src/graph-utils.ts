/**
 * Graph utilities for connected component detection and layout stitching.
 *
 * These utilities enable the "layout independently → stitch together" pattern
 * that fixes disconnected subgraph overlap issues. The pattern:
 *
 * 1. findConnectedComponents() partitions the graph into disjoint subsets
 * 2. Each component is laid out independently via dagre
 * 3. stitchComponentLayouts() combines the results with proper offsets
 *
 * This approach leverages dagre's strengths (excellent at connected graphs)
 * while avoiding its weakness (poor handling of disconnected components).
 */
import type { MermaidGraph, MermaidSubgraph, PositionedGraph, PositionedNode, PositionedEdge, PositionedGroup, Direction } from './types.ts'

// ============================================================================
// Connected component detection
// ============================================================================

/**
 * A connected component is a maximal set of nodes that are transitively
 * connected by edges. Each component can be laid out independently.
 */
export interface ConnectedComponent {
  /** All node IDs in this component */
  nodeIds: Set<string>
  /** IDs of subgraphs that belong to this component (all their nodes are in this component) */
  subgraphIds: Set<string>
  /** Indices into the original edges array for edges within this component */
  edgeIndices: Set<number>
}

/**
 * Partition a graph into connected components using Union-Find.
 *
 * Treats edges as undirected for connectivity purposes — if there's any
 * path between two nodes (regardless of edge direction), they're in the
 * same component.
 *
 * @returns Array of connected components in deterministic order (sorted by
 *          the minimum node ID in each component).
 */
export function findConnectedComponents(graph: MermaidGraph): ConnectedComponent[] {
  const nodeIds = Array.from(graph.nodes.keys())

  if (nodeIds.length === 0) {
    return []
  }

  // Union-Find data structure
  const parent = new Map<string, string>()
  const rank = new Map<string, number>()

  // Initialize: each node is its own parent
  for (const id of nodeIds) {
    parent.set(id, id)
    rank.set(id, 0)
  }

  // Find with path compression
  function find(x: string): string {
    if (parent.get(x) !== x) {
      parent.set(x, find(parent.get(x)!))
    }
    return parent.get(x)!
  }

  // Union by rank
  function union(x: string, y: string): void {
    const rootX = find(x)
    const rootY = find(y)

    if (rootX === rootY) return

    const rankX = rank.get(rootX)!
    const rankY = rank.get(rootY)!

    if (rankX < rankY) {
      parent.set(rootX, rootY)
    } else if (rankX > rankY) {
      parent.set(rootY, rootX)
    } else {
      parent.set(rootY, rootX)
      rank.set(rootX, rankX + 1)
    }
  }

  // Union all edges (treating them as undirected)
  for (const edge of graph.edges) {
    // Only union if both nodes exist in the graph
    if (parent.has(edge.source) && parent.has(edge.target)) {
      union(edge.source, edge.target)
    }
  }

  // Union nodes within subgraphs to each other AND to the subgraph ID.
  // This ensures that if an edge targets a subgraph (e.g., `A --> SubgraphID`),
  // all internal nodes of that subgraph are in the same component as A.
  // Critical for state diagrams where composite states contain internal nodes.
  function unionSubgraphNodes(sg: MermaidSubgraph): void {
    // Collect all node IDs in this subgraph (direct children + nested)
    const allNodesInSubgraph: string[] = [...sg.nodeIds]
    for (const child of sg.children) {
      collectAllNodeIdsFromSubgraph(child, allNodesInSubgraph)
    }

    // If the subgraph ID exists as a node, union all internal nodes with it
    if (parent.has(sg.id) && allNodesInSubgraph.length > 0) {
      for (const nodeId of allNodesInSubgraph) {
        if (parent.has(nodeId)) {
          union(sg.id, nodeId)
        }
      }
    }

    // Also union all internal nodes together (in case subgraph ID isn't a node)
    if (allNodesInSubgraph.length > 1) {
      const first = allNodesInSubgraph[0]!
      for (let i = 1; i < allNodesInSubgraph.length; i++) {
        if (parent.has(first) && parent.has(allNodesInSubgraph[i]!)) {
          union(first, allNodesInSubgraph[i]!)
        }
      }
    }

    // Recurse into nested subgraphs
    for (const child of sg.children) {
      unionSubgraphNodes(child)
    }
  }

  function collectAllNodeIdsFromSubgraph(sg: MermaidSubgraph, out: string[]): void {
    out.push(...sg.nodeIds)
    for (const child of sg.children) {
      collectAllNodeIdsFromSubgraph(child, out)
    }
  }

  for (const sg of graph.subgraphs) {
    unionSubgraphNodes(sg)
  }

  // Group nodes by their root (component)
  const componentMap = new Map<string, Set<string>>()
  for (const id of nodeIds) {
    const root = find(id)
    if (!componentMap.has(root)) {
      componentMap.set(root, new Set())
    }
    componentMap.get(root)!.add(id)
  }

  // Build the connected components
  const components: ConnectedComponent[] = []

  for (const [_, nodeIdSet] of componentMap) {
    const component: ConnectedComponent = {
      nodeIds: nodeIdSet,
      subgraphIds: new Set(),
      edgeIndices: new Set(),
    }

    // Assign edges to this component
    for (let i = 0; i < graph.edges.length; i++) {
      const edge = graph.edges[i]!
      if (nodeIdSet.has(edge.source) && nodeIdSet.has(edge.target)) {
        component.edgeIndices.add(i)
      }
    }

    components.push(component)
  }

  // Assign subgraphs to components based on their nodes
  assignSubgraphsToComponents(graph.subgraphs, components)

  // Sort components deterministically by minimum node ID
  components.sort((a, b) => {
    const minA = Math.min(...Array.from(a.nodeIds).map(id => id.charCodeAt(0)))
    const minB = Math.min(...Array.from(b.nodeIds).map(id => id.charCodeAt(0)))
    return minA - minB
  })

  return components
}

/**
 * Recursively assign subgraphs to components based on which component
 * contains their nodes.
 */
function assignSubgraphsToComponents(
  subgraphs: MermaidSubgraph[],
  components: ConnectedComponent[]
): void {
  for (const sg of subgraphs) {
    // Find which component contains this subgraph's nodes
    const allNodeIds = collectAllNodeIds(sg)

    if (allNodeIds.size > 0) {
      // Find the component that contains the first node
      const firstNodeId = allNodeIds.values().next().value
      for (const component of components) {
        if (component.nodeIds.has(firstNodeId)) {
          component.subgraphIds.add(sg.id)
          // Also add nested subgraph IDs
          addNestedSubgraphIds(sg, component.subgraphIds)
          break
        }
      }
    }

    // Recurse into children
    assignSubgraphsToComponents(sg.children, components)
  }
}

/** Collect all node IDs from a subgraph and its nested children */
function collectAllNodeIds(sg: MermaidSubgraph): Set<string> {
  const ids = new Set<string>(sg.nodeIds)
  for (const child of sg.children) {
    for (const id of collectAllNodeIds(child)) {
      ids.add(id)
    }
  }
  return ids
}

/** Add all nested subgraph IDs to a set */
function addNestedSubgraphIds(sg: MermaidSubgraph, out: Set<string>): void {
  for (const child of sg.children) {
    out.add(child.id)
    addNestedSubgraphIds(child, out)
  }
}

// ============================================================================
// Layout stitching
// ============================================================================

/**
 * Combine independently-laid-out graph components into a single PositionedGraph.
 *
 * Stacks components perpendicular to the flow direction for space efficiency:
 * - For horizontal flow (LR, RL): stack components top-to-bottom
 * - For vertical flow (TD, TB, BT): stack components left-to-right
 *
 * @param layouts - Array of positioned graphs (one per component)
 * @param direction - Graph direction (determines stacking axis)
 * @param gap - Spacing between components in pixels
 * @returns Combined positioned graph
 */
export function stitchComponentLayouts(
  layouts: PositionedGraph[],
  direction: Direction,
  gap: number
): PositionedGraph {
  if (layouts.length === 0) {
    return { width: 0, height: 0, nodes: [], edges: [], groups: [] }
  }

  if (layouts.length === 1) {
    return layouts[0]!
  }

  // Stack perpendicular to flow direction for better space efficiency:
  // - LR/RL flows horizontally → stack vertically (below each other)
  // - TD/TB/BT flows vertically → stack horizontally (side-by-side)
  const isHorizontal = direction === 'TD' || direction === 'TB' || direction === 'BT'

  const result: PositionedGraph = {
    width: 0,
    height: 0,
    nodes: [],
    edges: [],
    groups: [],
  }

  let offset = 0

  for (let i = 0; i < layouts.length; i++) {
    const layout = layouts[i]!

    if (isHorizontal) {
      // Stack horizontally: offset X coordinates
      for (const node of layout.nodes) {
        result.nodes.push({
          ...node,
          x: node.x + offset,
        })
      }

      for (const edge of layout.edges) {
        result.edges.push({
          ...edge,
          points: edge.points.map(p => ({ x: p.x + offset, y: p.y })),
          labelPosition: edge.labelPosition
            ? { x: edge.labelPosition.x + offset, y: edge.labelPosition.y }
            : undefined,
        })
      }

      for (const group of layout.groups) {
        result.groups.push(offsetGroupHorizontal(group, offset))
      }

      // Update total dimensions
      result.width = offset + layout.width
      result.height = Math.max(result.height, layout.height)

      // Move offset for next component
      offset += layout.width + gap
    } else {
      // Stack vertically: offset Y coordinates
      for (const node of layout.nodes) {
        result.nodes.push({
          ...node,
          y: node.y + offset,
        })
      }

      for (const edge of layout.edges) {
        result.edges.push({
          ...edge,
          points: edge.points.map(p => ({ x: p.x, y: p.y + offset })),
          labelPosition: edge.labelPosition
            ? { x: edge.labelPosition.x, y: edge.labelPosition.y + offset }
            : undefined,
        })
      }

      for (const group of layout.groups) {
        result.groups.push(offsetGroupVertical(group, offset))
      }

      // Update total dimensions
      result.width = Math.max(result.width, layout.width)
      result.height = offset + layout.height

      // Move offset for next component
      offset += layout.height + gap
    }
  }

  return result
}

/** Recursively offset a group and its children horizontally */
function offsetGroupHorizontal(group: PositionedGroup, dx: number): PositionedGroup {
  return {
    ...group,
    x: group.x + dx,
    children: group.children.map(child => offsetGroupHorizontal(child, dx)),
  }
}

/** Recursively offset a group and its children vertically */
function offsetGroupVertical(group: PositionedGroup, dy: number): PositionedGroup {
  return {
    ...group,
    y: group.y + dy,
    children: group.children.map(child => offsetGroupVertical(child, dy)),
  }
}
