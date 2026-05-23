export function getPartsMap(parts) {
  return new Map(parts.map((part) => [part.id, part]));
}

export function getResolvedPart(partId, parts) {
  const partsMap = getPartsMap(parts);
  const visited = new Set();

  function walk(currentId) {
    const part = partsMap.get(currentId);
    if (!part) {
      return null;
    }

    if (visited.has(currentId)) {
      return { ...part };
    }

    visited.add(currentId);
    const source = part.sourceId ? walk(part.sourceId) : null;
    const resolved = source
      ? {
          ...source,
          ...part,
          owner: part.owner || source.owner,
          residesIn: part.residesIn || source.residesIn,
          presentedIn: part.presentedIn || source.presentedIn,
          description: part.description || source.description,
        }
      : { ...part };
    visited.delete(currentId);
    return resolved;
  }

  return walk(partId);
}

export function getDepth(part, partsMap, cache = new Map(), stack = new Set()) {
  if (cache.has(part.id)) {
    return cache.get(part.id);
  }

  if (!part.sourceId || !partsMap.has(part.sourceId) || stack.has(part.id)) {
    cache.set(part.id, 0);
    return 0;
  }

  stack.add(part.id);
  const depth = 1 + getDepth(partsMap.get(part.sourceId), partsMap, cache, stack);
  stack.delete(part.id);
  cache.set(part.id, depth);
  return depth;
}

export function getSourceChainNames(part, partsMap) {
  const names = [];
  const seen = new Set();
  let current = part;

  while (current?.sourceId && partsMap.has(current.sourceId) && !seen.has(current.sourceId)) {
    seen.add(current.id);
    current = partsMap.get(current.sourceId);
    names.unshift(current.name);
  }

  return names;
}

export function canUseAsSource(candidateId, targetId, parts) {
  if (!candidateId || candidateId === targetId) {
    return candidateId !== targetId;
  }

  const partsMap = getPartsMap(parts);
  let currentId = candidateId;
  const seen = new Set([targetId]);

  while (currentId && partsMap.has(currentId)) {
    if (seen.has(currentId)) {
      return false;
    }
    seen.add(currentId);
    currentId = partsMap.get(currentId).sourceId;
  }

  return true;
}

export function getGraphLayout(parts) {
  const partsMap = getPartsMap(parts);
  const cache = new Map();
  const nodes = parts
    .map((part) => ({ part, depth: getDepth(part, partsMap, cache) }))
    .sort((left, right) => left.depth - right.depth || left.part.name.localeCompare(right.part.name));

  const columns = new Map();
  nodes.forEach(({ part, depth }) => {
    if (!columns.has(depth)) {
      columns.set(depth, []);
    }
    columns.get(depth).push(part);
  });

  const positions = new Map();
  const columnWidth = 280;
  const rowHeight = 170;
  const padding = 90;

  for (const [depth, items] of columns.entries()) {
    items.forEach((part, index) => {
      const hasManualPosition = Number.isFinite(part.position?.x) && Number.isFinite(part.position?.y);
      positions.set(part.id, {
        x: hasManualPosition ? part.position.x : padding + depth * columnWidth,
        y: hasManualPosition ? part.position.y : padding + index * rowHeight,
      });
    });
  }

  // Derive canvas size from actual node extents so new nodes placed below existing
  // ones expand the canvas downward instead of being clipped.
  let maxX = 0;
  let maxY = 0;
  for (const pos of positions.values()) {
    if (pos.x + 220 > maxX) maxX = pos.x + 220;
    if (pos.y + 158 > maxY) maxY = pos.y + 158;
  }

  return {
    nodes,
    positions,
    partsMap,
    width: Math.max(1200, maxX + padding),
    height: Math.max(760, maxY + padding),
  };
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 158;

export const ANCHOR_SIDES = ['left', 'right', 'top', 'bottom'];

export function getAnchorPoint(node, side) {
  if (side === 'left') {
    return { x: node.x, y: node.y + NODE_HEIGHT / 2 };
  }
  if (side === 'right') {
    return { x: node.x + NODE_WIDTH, y: node.y + NODE_HEIGHT / 2 };
  }
  if (side === 'top') {
    return { x: node.x + NODE_WIDTH / 2, y: node.y };
  }
  return { x: node.x + NODE_WIDTH / 2, y: node.y + NODE_HEIGHT };
}

function getNormal(side) {
  if (side === 'left') {
    return { x: -1, y: 0 };
  }
  if (side === 'right') {
    return { x: 1, y: 0 };
  }
  if (side === 'top') {
    return { x: 0, y: -1 };
  }
  return { x: 0, y: 1 };
}

export function getSuggestedAnchorSides(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' };
  }

  return dy >= 0 ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' };
}

function computeStructuredCurve(start, end, kind = 'source', lane = 0, anchors = null) {
  const defaults = getSuggestedAnchorSides(start, end);
  const startSide = ANCHOR_SIDES.includes(anchors?.from) ? anchors.from : defaults.from;
  const endSide = ANCHOR_SIDES.includes(anchors?.to) ? anchors.to : defaults.to;
  const startPoint = getAnchorPoint(start, startSide);
  const endPoint = getAnchorPoint(end, endSide);
  const startNormal = getNormal(startSide);
  const endNormal = getNormal(endSide);
  const startPerpendicular = { x: -startNormal.y, y: startNormal.x };
  const endPerpendicular = { x: -endNormal.y, y: endNormal.x };
  const laneOffset = kind === 'source' ? -20 - lane * 8 : 20 + lane * 8;
  const baseDistance = Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y);
  const pull = Math.max(72, baseDistance * 0.34);

  const control1X = startPoint.x + startNormal.x * pull + startPerpendicular.x * laneOffset;
  const control1Y = startPoint.y + startNormal.y * pull + startPerpendicular.y * laneOffset;
  const control2X = endPoint.x + endNormal.x * pull + endPerpendicular.x * laneOffset;
  const control2Y = endPoint.y + endNormal.y * pull + endPerpendicular.y * laneOffset;

  return {
    startPoint,
    endPoint,
    control1: { x: control1X, y: control1Y },
    control2: { x: control2X, y: control2Y },
  };
}

export function buildStructuredEdgePath(start, end, kind = 'source', lane = 0, anchors = null) {
  const curve = computeStructuredCurve(start, end, kind, lane, anchors);

  return [
    `M ${curve.startPoint.x} ${curve.startPoint.y}`,
    `C ${curve.control1.x} ${curve.control1.y}, ${curve.control2.x} ${curve.control2.y}, ${curve.endPoint.x} ${curve.endPoint.y}`,
  ].join(' ');
}

export function getEdgeGeometry(start, end, kind = 'source', lane = 0, anchors = null) {
  const curve = computeStructuredCurve(start, end, kind, lane, anchors);

  const midX = 0.125 * curve.startPoint.x + 0.375 * curve.control1.x + 0.375 * curve.control2.x + 0.125 * curve.endPoint.x;
  const midY = 0.125 * curve.startPoint.y + 0.375 * curve.control1.y + 0.375 * curve.control2.y + 0.125 * curve.endPoint.y;

  return {
    ...curve,
    label: { x: midX, y: midY },
    path: [
      `M ${curve.startPoint.x} ${curve.startPoint.y}`,
      `C ${curve.control1.x} ${curve.control1.y}, ${curve.control2.x} ${curve.control2.y}, ${curve.endPoint.x} ${curve.endPoint.y}`,
    ].join(' '),
  };
}