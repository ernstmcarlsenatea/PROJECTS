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
      positions.set(part.id, {
        x: part.position?.x ?? padding + depth * columnWidth,
        y: part.position?.y ?? padding + index * rowHeight,
      });
    });
  }

  return { nodes, positions, partsMap, width: Math.max(1200, columns.size * columnWidth + padding * 2), height: Math.max(760, parts.length * 170) };
}

export function buildStructuredEdgePath(start, end, kind = 'source', lane = 0) {
  const nodeWidth = 220;
  const nodeHeight = 158;
  const startX = start.x + nodeWidth;
  const startY = start.y + nodeHeight / 2;
  const endX = end.x;
  const endY = end.y + nodeHeight / 2;
  const direction = endX >= startX ? 1 : -1;
  const laneOffset = kind === 'source' ? -24 - lane * 10 : 24 + lane * 10;
  const pull = Math.max(60, Math.abs(endX - startX) * 0.35);
  const control1X = startX + direction * pull;
  const control2X = endX - direction * pull;
  const control1Y = startY + laneOffset;
  const control2Y = endY + laneOffset;

  return [
    `M ${startX} ${startY}`,
    `C ${control1X} ${control1Y}, ${control2X} ${control2Y}, ${endX} ${endY}`,
  ].join(' ');
}