import { useEffect, useMemo, useRef, useState, Suspense, lazy } from 'react';
import { toCanvas as htmlToCanvas } from 'html-to-image';
import { jsPDF } from 'jspdf';
import { STORAGE_KEY, VERSIONS_KEY, VERSION_COUNT_KEY, createEmptyDraft, createId, demoParts } from './data.js';
import { ANCHOR_SIDES, buildStructuredEdgePath, canUseAsSource, getAnchorPoint, getEdgeGeometry, getGraphLayout, getPartsMap, getResolvedPart, getSourceChainNames, getSuggestedAnchorSides } from './graph.js';
import { createCloudStore, createAdminStore, createUserStore, createRunbookStore, createTemplateStore, computeIsAdmin, getUserRole, isSuperAdmin, ROLES, SUPER_ADMIN_EMAIL } from './firebaseStore.js';
import { FEATURE_FLAGS, SCHEMA_VERSION } from './featureFlags.js';

// Phase 1: lazy-load secondary pages so they don't bloat the initial bundle.
// Rollback path: `git revert` the Phase 1 commit.
const RunbookPage = lazy(() => import('./RunbookPage.jsx').then((m) => ({ default: m.RunbookPage })));
const TemplatesPage = lazy(() => import('./TemplatesPage.jsx').then((m) => ({ default: m.TemplatesPage })));

function PageLoadingFallback({ label }) {
  return (
    <section className="page-loading" role="status" aria-live="polite">
      <span className="page-loading-spinner" aria-hidden="true" />
      <span>Loading {label}…</span>
    </section>
  );
}

const colorPalette = ['#ffd84f', '#ffafdc', '#a8f0de', '#b7d6ff', '#ffc79c', '#c9f59d'];
const NODE_WIDTH = 220;
const NODE_HEIGHT = 158;
const EXPORT_QUALITY_SCALE = {
  normal: 1,
  high: 2,
};
const ANCHOR_LABELS = {
  left: 'Left',
  right: 'Right',
  top: 'Top',
  bottom: 'Bottom',
};
const CLOUD_MIGRATION_KEY_PREFIX = 'kundeplan-cloud-migrated-v1';

function getCloudMigrationKey(userKey) {
  return `${CLOUD_MIGRATION_KEY_PREFIX}:${userKey ?? 'public'}`;
}

function createLocalSnapshot(state, versionCount) {
  return {
    state,
    versions: loadVersions(),
    versionCount,
  };
}

function applyCloudSnapshot(cloudSnapshot, setState, setVersionCount) {
  if (!cloudSnapshot?.state) {
    return false;
  }

  const normalizedCloudState = normalizePersistedState(cloudSnapshot.state);
  setState(normalizedCloudState);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizedCloudState));

  if (Array.isArray(cloudSnapshot.versions)) {
    localStorage.setItem(VERSIONS_KEY, JSON.stringify(cloudSnapshot.versions));
  }

  const cloudVersionCount = parseInt(cloudSnapshot.versionCount, 10);
  if (Number.isFinite(cloudVersionCount) && cloudVersionCount >= 0) {
    localStorage.setItem(VERSION_COUNT_KEY, String(cloudVersionCount));
    setVersionCount(cloudVersionCount);
  }

  return true;
}

// Stable serialization for diffing parts in three-way merge.
function hashPart(part) {
  return JSON.stringify(part);
}

// Three-way merge of `parts` arrays:
//   base   = parts last known to be in sync with the cloud
//   local  = parts in this browser right now (may contain unsynced edits)
//   remote = parts just received from the cloud (another user's writes)
//
// Per-part rules:
//   - Only remote changed         -> take remote
//   - Only local changed          -> keep local
//   - Both changed (conflict)     -> remote wins (last-write-wins)
//   - Remote added                -> include remote
//   - Local added                 -> include local
//   - One side deleted, other side unchanged -> honor deletion
//   - One side deleted, other side modified  -> keep the modified version
function mergePartsThreeWay(basePartsArr, localPartsArr, remotePartsArr) {
  const baseMap = new Map((basePartsArr ?? []).map((p) => [p.id, p]));
  const localMap = new Map(localPartsArr.map((p) => [p.id, p]));
  const remoteMap = new Map(remotePartsArr.map((p) => [p.id, p]));

  // Preserve display order: start with remote order, then append local-only ids.
  const orderedIds = [];
  const seen = new Set();
  for (const part of remotePartsArr) {
    orderedIds.push(part.id);
    seen.add(part.id);
  }
  for (const part of localPartsArr) {
    if (!seen.has(part.id)) {
      orderedIds.push(part.id);
      seen.add(part.id);
    }
  }

  const merged = [];
  for (const id of orderedIds) {
    const base = baseMap.get(id) ?? null;
    const local = localMap.get(id) ?? null;
    const remote = remoteMap.get(id) ?? null;
    const baseH = base ? hashPart(base) : null;
    const localH = local ? hashPart(local) : null;
    const remoteH = remote ? hashPart(remote) : null;

    if (local && remote) {
      if (localH === baseH) {
        merged.push(clonePart(remote));
      } else if (remoteH === baseH) {
        merged.push(clonePart(local));
      } else {
        // Concurrent edit conflict — remote wins.
        merged.push(clonePart(remote));
      }
    } else if (!local && remote) {
      if (!base || remoteH !== baseH) {
        // Remote added the part, or remote modified it while local deleted it.
        merged.push(clonePart(remote));
      }
      // else: local deleted an unchanged part — honor the deletion.
    } else if (local && !remote) {
      if (!base || localH !== baseH) {
        // Local added the part, or local modified it while remote deleted it.
        merged.push(clonePart(local));
      }
      // else: remote deleted an unchanged part — honor the deletion.
    }
  }

  // Drop dangling dependency / sourceId references to parts that no longer exist.
  const idSet = new Set(merged.map((p) => p.id));
  return merged.map((part) => {
    const cleaned = clonePart(part);
    cleaned.dependencies = cleaned.dependencies.filter((depId) => idSet.has(depId));
    cleaned.dependencyLabels = Object.fromEntries(
      Object.entries(cleaned.dependencyLabels ?? {}).filter(([depId]) => idSet.has(depId)),
    );
    cleaned.dependencyAnchors = Object.fromEntries(
      Object.entries(cleaned.dependencyAnchors ?? {}).filter(([depId]) => idSet.has(depId)),
    );
    if (cleaned.sourceId && !idSet.has(cleaned.sourceId)) {
      cleaned.sourceId = null;
    }
    return cleaned;
  });
}

function createDefaultState() {
  return {
    parts: demoParts.map(clonePart),
    selectedId: demoParts[0].id,
    draft: null,
    connectionMode: 'dependency',
    connectingFromId: null,
    pendingConnection: null,
  };
}

function normalizePersistedState(parsed) {
  if (!parsed?.parts || !Array.isArray(parsed.parts)) {
    return createDefaultState();
  }

  return {
    parts: parsed.parts.map(clonePart),
    selectedId: parsed.selectedId ?? parsed.parts[0]?.id ?? null,
    draft: parsed.draft ? clonePart(parsed.draft) : null,
    connectionMode: parsed.connectionMode === 'source' ? 'source' : 'dependency',
    connectingFromId: parsed.connectingFromId ?? null,
    pendingConnection: parsed.pendingConnection ?? null,
  };
}

function nextAnchorSide(side) {
  const index = ANCHOR_SIDES.indexOf(side);
  if (index < 0) {
    return ANCHOR_SIDES[0];
  }
  return ANCHOR_SIDES[(index + 1) % ANCHOR_SIDES.length];
}

function clonePart(part) {
  const dependencyAnchors = Object.fromEntries(
    Object.entries(part.dependencyAnchors ?? {}).map(([dependencyId, anchor]) => [
      dependencyId,
      {
        from: anchor?.from ?? 'right',
        to: anchor?.to ?? 'left',
      },
    ]),
  );

  return {
    ...part,
    dependencies: [...(part.dependencies ?? [])],
    dependencyLabels: { ...(part.dependencyLabels ?? {}) },
    position: { ...(part.position ?? { x: 140, y: 140 }) },
    sourceAnchor: {
      from: part.sourceAnchor?.from ?? 'right',
      to: part.sourceAnchor?.to ?? 'left',
    },
    dependencyAnchors,
  };
}

function cloneAppState(source) {
  return {
    parts: source.parts.map(clonePart),
    selectedId: source.selectedId,
    draft: source.draft ? clonePart(source.draft) : null,
    connectionMode: source.connectionMode,
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return createDefaultState();
    }

    const parsed = JSON.parse(raw);
    return normalizePersistedState(parsed);
  } catch {
    return createDefaultState();
  }
}

function DetailLine({ label, value }) {
  return (
    <div className="detail-line">
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}

function versionLabel(count) {
  if (count <= 0) return null;
  const major = Math.floor((count - 1) / 10) + 1;
  const minor = (count - 1) % 10;
  return `${major}.${minor}`;
}

function loadVersionCount() {
  try {
    const raw = localStorage.getItem(VERSION_COUNT_KEY);
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function loadVersions() {
  try {
    const raw = localStorage.getItem(VERSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildStructureSummary(parts) {
  const partsMap = getPartsMap(parts);
  const childrenByParent = new Map();
  const dependentsByPart = new Map();

  for (const part of parts) {
    if (part.sourceId && partsMap.has(part.sourceId)) {
      const bucket = childrenByParent.get(part.sourceId) ?? [];
      bucket.push(part);
      childrenByParent.set(part.sourceId, bucket);
    }
    for (const depId of part.dependencies ?? []) {
      if (!partsMap.has(depId)) continue;
      const bucket = dependentsByPart.get(depId) ?? [];
      bucket.push({ part, label: part.dependencyLabels?.[depId] ?? null });
      dependentsByPart.set(depId, bucket);
    }
  }

  const entries = [...parts]
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map((part) => {
      const sourceChain = getSourceChainNames(part, partsMap);
      const directSource = part.sourceId ? partsMap.get(part.sourceId) : null;
      const dependencies = (part.dependencies ?? [])
        .map((depId) => {
          const dep = partsMap.get(depId);
          if (!dep) return null;
          return { id: depId, name: dep.name || '(unnamed)', label: part.dependencyLabels?.[depId] ?? null };
        })
        .filter(Boolean);
      const dependents = (dependentsByPart.get(part.id) ?? []).map((entry) => ({
        id: entry.part.id,
        name: entry.part.name || '(unnamed)',
        label: entry.label,
      }));
      const children = (childrenByParent.get(part.id) ?? []).map((child) => ({
        id: child.id,
        name: child.name || '(unnamed)',
      }));
      const isRoot = !directSource;
      const isLeaf = children.length === 0;
      const isOrphan = isRoot && dependents.length === 0 && dependencies.length === 0 && children.length === 0;
      return {
        id: part.id,
        name: part.name || '(unnamed)',
        owner: part.owner || '',
        sourceChain,
        directSource: directSource ? directSource.name || '(unnamed)' : null,
        dependencies,
        dependents,
        children,
        isRoot,
        isLeaf,
        isOrphan,
      };
    });

  const totalSourceLinks = parts.filter((part) => part.sourceId && partsMap.has(part.sourceId)).length;
  const totalDependencies = parts.reduce(
    (acc, part) => acc + (part.dependencies ?? []).filter((id) => partsMap.has(id)).length,
    0,
  );
  const roots = entries.filter((entry) => entry.isRoot);
  const leaves = entries.filter((entry) => entry.isLeaf);
  const orphans = entries.filter((entry) => entry.isOrphan);

  return {
    generatedAt: new Date(),
    totals: {
      parts: parts.length,
      sourceLinks: totalSourceLinks,
      dependencies: totalDependencies,
      roots: roots.length,
      leaves: leaves.length,
      orphans: orphans.length,
    },
    entries,
  };
}

function App({ auth = { enabled: false, activeAccount: null, signOut: null, publicAccess: false } }) {
  const activeAccount = auth.activeAccount ?? null;
  const cloudStore = useMemo(
    () => createCloudStore(auth),
    [auth.enabled, auth.activeAccount?.username, auth.activeAccount?.homeAccountId],
  );
  const [state, setState] = useState(() => loadState());
  const [cloudActionStatus, setCloudActionStatus] = useState('idle');
  const [cloudActionError, setCloudActionError] = useState(null);
  const adminStore = useMemo(() => createAdminStore(), []);
  const userStore = useMemo(() => createUserStore(), []);
  const statsRunbookStore = useMemo(() => createRunbookStore(), []);
  const [adminEmails, setAdminEmails] = useState([]);
  const [adminError, setAdminError] = useState(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const [users, setUsers] = useState([]);
  const [userDraft, setUserDraft] = useState({ email: '', role: 'viewer', displayName: '' });
  const [editingUserEmail, setEditingUserEmail] = useState(null);
  const [editingUserDraft, setEditingUserDraft] = useState(null);
  const [runbookConfigForStats, setRunbookConfigForStats] = useState({});

  const callerEmail = activeAccount?.username ?? null;

  // Effective users: prefer the new user registry; fall back to legacy admin
  // list so existing installations keep working before a save happens.
  const effectiveUsers = useMemo(() => {
    if (users.length > 0) return users;
    if (adminEmails.length === 0) return [];
    return adminEmails.map((email) => ({
      email,
      role: 'admin',
      displayName: '',
      addedAt: null,
      addedBy: '',
    }));
  }, [users, adminEmails]);

  const callerRole = getUserRole(callerEmail, effectiveUsers);
  const isSuper = isSuperAdmin(callerEmail);
  const isAdmin = isSuper || callerRole === 'admin' || computeIsAdmin(callerEmail, adminEmails);
  const isEditor = callerRole === 'editor';
  const canEdit = isAdmin;
  const canEditRunbook = isAdmin || isEditor;

  useEffect(() => {
    if (!adminStore.enabled) {
      return undefined;
    }
    const unsubscribe = adminStore.subscribeAdmins(
      (emails) => setAdminEmails(emails),
      (error) => {
        console.error('Admin list subscription failed:', error);
        setAdminError(error?.message ?? String(error));
      },
    );
    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [adminStore]);

  useEffect(() => {
    if (!userStore.enabled) {
      return undefined;
    }
    const unsubscribe = userStore.subscribeUsers(
      (nextUsers) => setUsers(nextUsers),
      (error) => {
        console.error('User list subscription failed:', error);
        setAdminError(error?.message ?? String(error));
      },
    );
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [userStore]);

  // Subscribe to runbook config for statistics panel
  useEffect(() => {
    if (!statsRunbookStore.enabled) return undefined;
    const unsubscribe = statsRunbookStore.subscribeConfig(
      (data, meta) => {
        if (meta?.hasPendingWrites) return;
        const cfg = (data && typeof data.config === 'object' && data.config) || {};
        setRunbookConfigForStats(cfg);
      },
      (error) => console.error('Runbook stats subscription failed:', error),
    );
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [statsRunbookStore]);
  const [currentPage, setCurrentPage] = useState('blueprint');
  const [connectionHoverId, setConnectionHoverId] = useState(null);
  const [draggingNodeId, setDraggingNodeId] = useState(null);
  const [hoveredLink, setHoveredLink] = useState(null);
  const [newDependencyId, setNewDependencyId] = useState('');
  const [exportQuality, setExportQuality] = useState('normal');
  const [showUserGuide, setShowUserGuide] = useState(false);
  const [structureSummary, setStructureSummary] = useState(null);
  const [openHandleMenuId, setOpenHandleMenuId] = useState(null);
  const [openEditMenuId, setOpenEditMenuId] = useState(null);
  const [catalogSearch, setCatalogSearch] = useState('');

  useEffect(() => {
    if (!showUserGuide) {
      return undefined;
    }
    function onGuideKey(event) {
      if (event.key === 'Escape') {
        setShowUserGuide(false);
      }
    }
    window.addEventListener('keydown', onGuideKey);
    return () => window.removeEventListener('keydown', onGuideKey);
  }, [showUserGuide]);

  useEffect(() => {
    if (!structureSummary) {
      return undefined;
    }
    function onSummaryKey(event) {
      if (event.key === 'Escape') {
        setStructureSummary(null);
      }
    }
    window.addEventListener('keydown', onSummaryKey);
    return () => window.removeEventListener('keydown', onSummaryKey);
  }, [structureSummary]);

  useEffect(() => {
    if (!openHandleMenuId) {
      return undefined;
    }
    function onDocPointerDown(event) {
      if (!event.target.closest('.graph-handle-wrap')) {
        setOpenHandleMenuId(null);
      }
    }
    function onDocKey(event) {
      if (event.key === 'Escape') {
        setOpenHandleMenuId(null);
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    window.addEventListener('keydown', onDocKey);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown);
      window.removeEventListener('keydown', onDocKey);
    };
  }, [openHandleMenuId]);

  useEffect(() => {
    if (!openEditMenuId) {
      return undefined;
    }
    function onDocPointerDown(event) {
      if (!event.target.closest('.graph-edit-wrap')) {
        setOpenEditMenuId(null);
      }
    }
    function onDocKey(event) {
      if (event.key === 'Escape') {
        setOpenEditMenuId(null);
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    window.addEventListener('keydown', onDocKey);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown);
      window.removeEventListener('keydown', onDocKey);
    };
  }, [openEditMenuId]);

  const [versionCount, setVersionCount] = useState(() => loadVersionCount());
  const initialLocalSnapshot = useMemo(
    () => createLocalSnapshot(loadState(), loadVersionCount()),
    [],
  );
  const cloudLoadedRef = useRef(false);
  const cloudInitializedRef = useRef(false);
  // Snapshot of `parts` that we last knew the server agreed with. Used as the
  // base for three-way merges when another browser pushes a change.
  const remoteBaselineRef = useRef(null);
  // Latest versionCount, accessed from the realtime subscription closure
  // without making the subscription re-bind on every version bump.
  const versionCountRef = useRef(0);
  const historyRef = useRef({ past: [], future: [] });
  const connectionStartRef = useRef(null);
  const dragRef = useRef(null);
  const suppressClickRef = useRef(null);
  const graphCanvasRef = useRef(null);
  const graphStageRef = useRef(null);
  const inspectorRef = useRef(null);
  const boardRef = useRef(null);
  const catalogRef = useRef(null);
  const partNameInputRef = useRef(null);
  const [startHereHint, setStartHereHint] = useState(false);
  const [justSavedId, setJustSavedId] = useState(null);
  const partsMap = useMemo(() => getPartsMap(state.parts), [state.parts]);
  const draft = state.draft ?? state.parts.find((part) => part.id === state.selectedId) ?? null;
  const displayParts = useMemo(() => {
    if (!draft || state.parts.some((part) => part.id === draft.id)) {
      return state.parts;
    }

    return [...state.parts, draft];
  }, [state.parts, draft]);
  const graph = useMemo(() => getGraphLayout(displayParts), [displayParts]);
  const exportBounds = useMemo(() => {
    const overflowPadding = 20;
    let maxX = graph.width;
    let maxY = graph.height;

    for (const part of state.parts) {
      const position = graph.positions.get(part.id);
      if (!position) {
        continue;
      }

      maxX = Math.max(maxX, position.x + NODE_WIDTH + overflowPadding);
      maxY = Math.max(maxY, position.y + NODE_HEIGHT + overflowPadding);
    }

    return { width: Math.ceil(maxX), height: Math.ceil(maxY) };
  }, [graph.width, graph.height, graph.positions, state.parts]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  useEffect(() => {
    cloudLoadedRef.current = false;
    cloudInitializedRef.current = false;
    remoteBaselineRef.current = null;

    if (!cloudStore.enabled) {
      cloudLoadedRef.current = true;
      return undefined;
    }

    const unsubscribe = cloudStore.subscribeSnapshot(
      (cloudSnapshot, meta) => {
        // Ignore echoes of writes that originated in THIS browser; otherwise we
        // would clobber the user's in-flight edits with a slightly stale copy.
        if (meta?.hasPendingWrites) {
          return;
        }

        if (!cloudSnapshot?.state) {
          // No cloud document yet — first user seeds it from their local state.
          if (!cloudInitializedRef.current) {
            cloudInitializedRef.current = true;
            cloudLoadedRef.current = true;
            const migrationKey = getCloudMigrationKey(cloudStore.userKey);
            const alreadyMigrated = localStorage.getItem(migrationKey) === 'true';
            if (!alreadyMigrated) {
              cloudStore
                .saveSnapshot({
                  state: initialLocalSnapshot.state,
                  versions: initialLocalSnapshot.versions,
                  versionCount: initialLocalSnapshot.versionCount,
                  migratedFromLocal: true,
                })
                .catch((error) => console.error('Cloud migration failed:', error));
              remoteBaselineRef.current = initialLocalSnapshot.state.parts.map(clonePart);
              localStorage.setItem(migrationKey, 'true');
            }
          }
          return;
        }

        const remoteState = normalizePersistedState(cloudSnapshot.state);

        if (!cloudInitializedRef.current) {
          // First snapshot for this session: adopt the cloud state wholesale.
          cloudInitializedRef.current = true;
          cloudLoadedRef.current = true;
          applyCloudSnapshot(cloudSnapshot, setState, setVersionCount);
          remoteBaselineRef.current = remoteState.parts.map(clonePart);
          return;
        }

        // Subsequent remote update — three-way merge with whatever the user
        // currently has in this browser so concurrent edits are preserved.
        setState((currentLocal) => {
          const baseline = remoteBaselineRef.current ?? remoteState.parts;
          const mergedParts = mergePartsThreeWay(baseline, currentLocal.parts, remoteState.parts);
          remoteBaselineRef.current = mergedParts.map(clonePart);

          // If the merge differs from what the server has, push the merged
          // result back so other browsers converge on the same state.
          if (hashPart(mergedParts) !== hashPart(remoteState.parts)) {
            cloudStore
              .saveSnapshot({
                state: { ...currentLocal, parts: mergedParts },
                versions: loadVersions(),
                versionCount: versionCountRef.current,
              })
              .catch((error) => console.error('Cloud merge save failed:', error));
          }

          // Keep this user's selection/draft/connection UI state local.
          const stillSelected = mergedParts.some((p) => p.id === currentLocal.selectedId);
          return {
            ...currentLocal,
            parts: mergedParts,
            selectedId: stillSelected ? currentLocal.selectedId : mergedParts[0]?.id ?? null,
          };
        });

        // Sync version metadata from the cloud as well.
        if (Array.isArray(cloudSnapshot.versions)) {
          localStorage.setItem(VERSIONS_KEY, JSON.stringify(cloudSnapshot.versions));
        }
        const cloudVersionCount = parseInt(cloudSnapshot.versionCount, 10);
        if (Number.isFinite(cloudVersionCount) && cloudVersionCount >= 0) {
          localStorage.setItem(VERSION_COUNT_KEY, String(cloudVersionCount));
          setVersionCount(cloudVersionCount);
        }
      },
      (error) => {
        console.error('Cloud subscription error:', error);
      },
    );

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [cloudStore, initialLocalSnapshot]);

  useEffect(() => {
    versionCountRef.current = versionCount;
  }, [versionCount]);

  useEffect(() => {
    if (!cloudStore.enabled || !cloudLoadedRef.current) {
      return;
    }

    // Only admins are allowed to push changes to the shared cloud document.
    if (!canEdit) {
      return;
    }

    // Skip saving when our local state already matches the server baseline
    // (e.g. just after applying a remote update). Avoids feedback loops.
    if (
      remoteBaselineRef.current &&
      hashPart(state.parts) === hashPart(remoteBaselineRef.current)
    ) {
      return;
    }

    const partsSnapshot = state.parts.map(clonePart);
    const timeoutId = window.setTimeout(() => {
      cloudStore
        .saveSnapshot({
          state,
          versions: loadVersions(),
          versionCount,
        })
        .then(() => {
          // Advance the baseline so the echoed snapshot from Firestore is a
          // no-op for the merge logic.
          remoteBaselineRef.current = partsSnapshot;
        })
        .catch((error) => {
          console.error('Cloud sync failed:', error);
        });
    }, 450);

    return () => window.clearTimeout(timeoutId);
  }, [cloudStore, state, versionCount, canEdit]);

  useEffect(() => {
    function onKeyDown(event) {
      const shortcut = (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z';
      const redoShortcut = (event.metaKey || event.ctrlKey) && (event.shiftKey && event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y');

      if (shortcut) {
        event.preventDefault();
        undo();
      }

      if (redoShortcut) {
        event.preventDefault();
        redo();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  useEffect(() => {
    setNewDependencyId('');
  }, [draft?.id]);

  const selectedResolved = draft ? getResolvedPart(draft.id, state.parts) ?? draft : null;
  const sourceChain = draft ? getSourceChainNames(draft, partsMap) : [];

  const stats = useMemo(() => {
    const roots = state.parts.filter((part) => !part.sourceId || !partsMap.has(part.sourceId)).length;
    const owners = new Set(state.parts.map((part) => part.owner || 'Unassigned')).size;
    const residences = new Set(state.parts.map((part) => part.residesIn || 'Unknown')).size;
    const dependencyLinks = state.parts.reduce((total, part) => total + part.dependencies.length, 0);
    return [
      [state.parts.length, 'parts in the atlas'],
      [roots, 'source roots'],
      [dependencyLinks, 'dependency links'],
      [`${owners} owners / ${residences} residences`, 'coverage marks'],
    ];
  }, [state.parts, partsMap]);

  const groupedParts = useMemo(() => {
    const groups = new Map();
    state.parts.forEach((part) => {
      const resolved = getResolvedPart(part.id, state.parts) ?? part;
      const key = resolved.residesIn || part.residesIn || 'Unknown residence';
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(part);
    });
    return [...groups.entries()].sort((left, right) => left[0].localeCompare(right[0]));
  }, [state.parts]);

  // Phase 2: catalog text search. Matches part name, owner, residence,
  // presented-in, notes, source name and dependency names.
  const trimmedCatalogSearch = catalogSearch.trim().toLowerCase();
  const filteredGroupedParts = useMemo(() => {
    if (!FEATURE_FLAGS.searchAndFilter || !trimmedCatalogSearch) {
      return groupedParts;
    }
    const matches = (part) => {
      const resolved = getResolvedPart(part.id, state.parts) ?? part;
      const haystackParts = [
        part.name,
        resolved.name,
        part.owner,
        resolved.owner,
        part.residesIn,
        resolved.residesIn,
        part.presentedIn,
        resolved.presentedIn,
        part.notes,
        resolved.notes,
        part.sourceId ? partsMap.get(part.sourceId)?.name : '',
        ...(part.dependencies ?? []).map((id) => partsMap.get(id)?.name ?? ''),
      ];
      return haystackParts.some(
        (value) => typeof value === 'string' && value.toLowerCase().includes(trimmedCatalogSearch),
      );
    };
    return groupedParts
      .map(([residence, parts]) => [residence, parts.filter(matches)])
      .filter(([, parts]) => parts.length > 0);
  }, [groupedParts, trimmedCatalogSearch, state.parts, partsMap]);

  const totalCatalogParts = state.parts.length;
  const visibleCatalogParts = useMemo(
    () => filteredGroupedParts.reduce((acc, [, parts]) => acc + parts.length, 0),
    [filteredGroupedParts],
  );

  const selectedId = draft?.id ?? state.selectedId;
  const addableDependencies = useMemo(() => {
    if (!draft) {
      return [];
    }
    return state.parts.filter((part) => part.id !== draft.id && !draft.dependencies.includes(part.id));
  }, [state.parts, draft]);

  function suggestAnchors(sourceId, targetId) {
    const source = graph.positions.get(sourceId);
    const target = graph.positions.get(targetId);
    if (!source || !target) {
      return { from: 'right', to: 'left' };
    }
    return getSuggestedAnchorSides(source, target);
  }

  function resolveAnchors(sourceId, targetId, storedAnchor) {
    const fallback = suggestAnchors(sourceId, targetId);
    return {
      from: ANCHOR_SIDES.includes(storedAnchor?.from) ? storedAnchor.from : fallback.from,
      to: ANCHOR_SIDES.includes(storedAnchor?.to) ? storedAnchor.to : fallback.to,
    };
  }

  function cycleSourceAnchorSide(targetPartId, sideKey) {
    commit((current) => {
      const target = current.parts.find((part) => part.id === targetPartId);
      if (!target?.sourceId) {
        return current;
      }

      const anchors = resolveAnchors(target.sourceId, targetPartId, target.sourceAnchor);
      const updatedAnchor = { ...anchors, [sideKey]: nextAnchorSide(anchors[sideKey]) };

      const parts = current.parts.map((part) => (part.id === targetPartId ? { ...part, sourceAnchor: updatedAnchor } : part));
      const draft = current.draft?.id === targetPartId ? { ...current.draft, sourceAnchor: updatedAnchor } : current.draft;
      return { ...current, parts, draft };
    });
  }

  function cycleDependencyAnchorSide(targetPartId, dependencyId, sideKey) {
    commit((current) => {
      const target = current.parts.find((part) => part.id === targetPartId);
      if (!target || !target.dependencies.includes(dependencyId)) {
        return current;
      }

      const anchors = resolveAnchors(dependencyId, targetPartId, target.dependencyAnchors?.[dependencyId]);
      const updatedAnchor = { ...anchors, [sideKey]: nextAnchorSide(anchors[sideKey]) };

      const parts = current.parts.map((part) => {
        if (part.id !== targetPartId) {
          return part;
        }
        return {
          ...part,
          dependencyAnchors: {
            ...(part.dependencyAnchors ?? {}),
            [dependencyId]: updatedAnchor,
          },
        };
      });

      const draft = current.draft?.id === targetPartId
        ? {
            ...current.draft,
            dependencyAnchors: {
              ...(current.draft.dependencyAnchors ?? {}),
              [dependencyId]: updatedAnchor,
            },
          }
        : current.draft;

      return { ...current, parts, draft };
    });
  }

  function commit(updater, { history = true } = {}) {
    setState((current) => {
      if (history) {
        historyRef.current.past.push(cloneAppState(current));
        historyRef.current.future = [];
      }

      const nextState = typeof updater === 'function' ? updater(current) : { ...current, ...updater };
      return nextState;
    });
  }

  function selectPart(partId) {
    const part = state.parts.find((entry) => entry.id === partId);
    if (!part) {
      return;
    }

    setState((current) => ({ ...current, selectedId: partId, draft: clonePart(part), connectingFromId: null, pendingConnection: null }));
  }

  function findFreeNodePosition() {
    const padding = 40;
    const startX = 140;
    const startY = 140;

    const positions = state.parts
      .map((part) => part.position)
      .filter((position) => position && Number.isFinite(position.x) && Number.isFinite(position.y));

    if (positions.length === 0) {
      return { x: startX, y: startY };
    }

    // Always place the new part at the very bottom of the canvas, left-aligned.
    // Never extend the canvas to the right — successive new parts stack downward.
    const maxBottom = positions.reduce(
      (acc, position) => Math.max(acc, position.y + NODE_HEIGHT),
      0,
    );
    return { x: startX, y: maxBottom + padding };
  }

  function scrollCanvasToPosition(position) {
    const stage = graphStageRef.current;
    if (!stage || !position) {
      return;
    }
    const margin = 40;
    const targetLeft = Math.max(0, position.x - margin);
    const targetTop = Math.max(0, position.y - margin);
    stage.scrollTo({ left: targetLeft, top: targetTop, behavior: 'smooth' });
  }

  function openNewPart() {
    if (!canEdit) return;
    openNewPartFrom(state.selectedId);
  }

  function openNewPartFrom(anchorId) {
    if (!canEdit) return;
    const anchor = state.parts.find((part) => part.id === anchorId) ?? null;
    const draftPart = createEmptyDraft();
    draftPart.sourceId = anchor?.id ?? null;
    const position = findFreeNodePosition();
    draftPart.position = position;
    setState((current) => ({ ...current, selectedId: null, draft: draftPart, connectingFromId: null, pendingConnection: null }));
    requestAnimationFrame(() => {
      scrollCanvasToPosition(position);
      inspectorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      window.setTimeout(() => {
        const input = partNameInputRef.current;
        if (input) {
          input.focus();
          try { input.select(); } catch { /* ignore */ }
        }
        setStartHereHint(true);
        window.setTimeout(() => setStartHereHint(false), 2400);
      }, 350);
    });
  }

  function resetDemo() {
    commit({ parts: demoParts.map(clonePart), selectedId: demoParts[0].id, draft: null, connectingFromId: null, pendingConnection: null });
  }

  function updateDraft(field, value) {
    if (!canEdit) return;
    if (!draft) {
      return;
    }

    const nextDraft = { ...draft, [field]: value };
    setState((current) => ({ ...current, draft: nextDraft }));
  }

  function updateSourceAnchor(sideKey, side) {
    if (!canEdit) return;
    if (!draft) {
      return;
    }

    const nextAnchor = {
      from: draft.sourceAnchor?.from ?? 'right',
      to: draft.sourceAnchor?.to ?? 'left',
      [sideKey]: side,
    };
    updateDraft('sourceAnchor', nextAnchor);
  }

  function updateDependencyAnchor(dependencyId, sideKey, side) {
    if (!canEdit) return;
    if (!draft) {
      return;
    }

    const nextAnchors = {
      ...(draft.dependencyAnchors ?? {}),
      [dependencyId]: {
        from: draft.dependencyAnchors?.[dependencyId]?.from ?? 'right',
        to: draft.dependencyAnchors?.[dependencyId]?.to ?? 'left',
        [sideKey]: side,
      },
    };
    updateDraft('dependencyAnchors', nextAnchors);
  }

  function addDependencyToDraft(dependencyId) {
    if (!canEdit) return;
    if (!draft || !dependencyId || dependencyId === draft.id || draft.dependencies.includes(dependencyId)) {
      return;
    }

    const sourcePart = partsMap.get(dependencyId);
    const nextDependencies = [...draft.dependencies, dependencyId];
    const nextDependencyAnchors = {
      ...(draft.dependencyAnchors ?? {}),
      [dependencyId]: draft.dependencyAnchors?.[dependencyId] ?? suggestAnchors(dependencyId, draft.id),
    };
    const nextDependencyLabels = {
      ...(draft.dependencyLabels ?? {}),
      [dependencyId]: draft.dependencyLabels?.[dependencyId] ?? `${sourcePart?.name ?? dependencyId} link`,
    };

    setState((current) => ({
      ...current,
      draft: current.draft
        ? {
            ...current.draft,
            dependencies: nextDependencies,
            dependencyAnchors: nextDependencyAnchors,
            dependencyLabels: nextDependencyLabels,
          }
        : current.draft,
    }));
  }

  function removeDependencyFromDraft(dependencyId) {
    if (!canEdit) return;
    if (!draft || !draft.dependencies.includes(dependencyId)) {
      return;
    }

    const nextDependencyAnchors = { ...(draft.dependencyAnchors ?? {}) };
    const nextDependencyLabels = { ...(draft.dependencyLabels ?? {}) };
    delete nextDependencyAnchors[dependencyId];
    delete nextDependencyLabels[dependencyId];

    setState((current) => ({
      ...current,
      draft: current.draft
        ? {
            ...current.draft,
            dependencies: current.draft.dependencies.filter((id) => id !== dependencyId),
            dependencyAnchors: nextDependencyAnchors,
            dependencyLabels: nextDependencyLabels,
          }
        : current.draft,
    }));
  }

  function updateDependencyLabel(dependencyId, label) {
    if (!canEdit) return;
    if (!draft) {
      return;
    }

    setState((current) => ({
      ...current,
      draft: current.draft
        ? {
            ...current.draft,
            dependencyLabels: {
              ...(current.draft.dependencyLabels ?? {}),
              [dependencyId]: label,
            },
          }
        : current.draft,
    }));
  }

  function beginNodeDrag(partId, event) {
    if (!canEdit) return;
    if (event.button !== 0) {
      return;
    }

    if (event.target.closest('.graph-handle')) {
      return;
    }

    const nodePosition = graph.positions.get(partId);
    if (!nodePosition) {
      return;
    }

    const pointerX = event.clientX;
    const pointerY = event.clientY;
    dragRef.current = {
      partId,
      startX: nodePosition.x,
      startY: nodePosition.y,
      pointerX,
      pointerY,
      moved: false,
      startState: cloneAppState(state),
    };
    setDraggingNodeId(partId);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function moveNode(partId, nextX, nextY) {
    setState((current) => {
      let changed = false;
      const parts = current.parts.map((part) => {
        if (part.id !== partId) {
          return part;
        }

        const clampedX = Math.max(24, Math.round(nextX));
        const clampedY = Math.max(24, Math.round(nextY));
        const same = part.position?.x === clampedX && part.position?.y === clampedY;
        if (same) {
          return part;
        }
        changed = true;
        return { ...part, position: { x: clampedX, y: clampedY } };
      });

      if (!changed) {
        return current;
      }

      const draft = current.draft?.id === partId
        ? { ...current.draft, position: { x: Math.max(24, Math.round(nextX)), y: Math.max(24, Math.round(nextY)) } }
        : current.draft;

      return { ...current, parts, draft };
    });
  }

  function onNodePointerMove(event) {
    const dragging = dragRef.current;
    if (!dragging) {
      return;
    }

    const scale = 1;
    const dx = (event.clientX - dragging.pointerX) / scale;
    const dy = (event.clientY - dragging.pointerY) / scale;
    if (!dragging.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      dragging.moved = true;
    }

    if (!dragging.moved) {
      return;
    }

    moveNode(dragging.partId, dragging.startX + dx, dragging.startY + dy);
  }

  function endNodeDrag(event) {
    const dragging = dragRef.current;
    if (!dragging) {
      return;
    }

    event.currentTarget.releasePointerCapture?.(event.pointerId);

    if (dragging.moved) {
      historyRef.current.past.push(dragging.startState);
      historyRef.current.future = [];
      suppressClickRef.current = dragging.partId;
    }

    dragRef.current = null;
    setDraggingNodeId(null);
  }

  function savePart(event) {
    if (!canEdit) {
      event?.preventDefault?.();
      return;
    }
    event.preventDefault();
    if (!draft?.name.trim()) {
      window.alert('Give the part a name before saving.');
      return;
    }

    const targetId = draft.id || createId();
    if (draft.sourceId && !canUseAsSource(draft.sourceId, targetId, state.parts)) {
      window.alert('That source would create a cycle. Choose another part.');
      return;
    }

    const nextPart = {
      ...draft,
      id: targetId,
      sourceId: draft.sourceId || null,
      dependencies: [...new Set((draft.dependencies || []).filter((dependencyId) => dependencyId !== targetId))],
      dependencyLabels: Object.fromEntries(
        Object.entries(draft.dependencyLabels ?? {}).filter(([dependencyId]) => (draft.dependencies || []).includes(dependencyId)),
      ),
      position: draft.position ?? { x: 140, y: 140 },
      sourceAnchor: {
        from: ANCHOR_SIDES.includes(draft.sourceAnchor?.from) ? draft.sourceAnchor.from : 'right',
        to: ANCHOR_SIDES.includes(draft.sourceAnchor?.to) ? draft.sourceAnchor.to : 'left',
      },
      dependencyAnchors: Object.fromEntries(
        Object.entries(draft.dependencyAnchors ?? {})
          .filter(([dependencyId]) => (draft.dependencies || []).includes(dependencyId))
          .map(([dependencyId, anchor]) => [
            dependencyId,
            {
              from: ANCHOR_SIDES.includes(anchor?.from) ? anchor.from : 'right',
              to: ANCHOR_SIDES.includes(anchor?.to) ? anchor.to : 'left',
            },
          ]),
      ),
    };

    const exists = state.parts.some((part) => part.id === targetId);
    const parts = exists ? state.parts.map((part) => (part.id === targetId ? nextPart : part)) : [...state.parts, nextPart];

    commit({ parts, selectedId: targetId, draft: clonePart(nextPart), connectingFromId: null, pendingConnection: null });

    requestAnimationFrame(() => {
      const nodeEl = graphCanvasRef.current?.querySelector(`[data-part-id="${targetId}"]`)
        ?? document.querySelector(`[data-part-id="${targetId}"]`);
      if (nodeEl && typeof nodeEl.scrollIntoView === 'function') {
        nodeEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      } else {
        boardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        scrollCanvasToPosition(nextPart.position);
      }
      setJustSavedId(targetId);
      window.setTimeout(() => {
        setJustSavedId((current) => (current === targetId ? null : current));
      }, 2600);
    });
  }

  function editPartInInspector(partId) {
    selectPart(partId);
    requestAnimationFrame(() => {
      inspectorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function deletePart() {
    if (!canEdit) return;
    if (!draft || !state.parts.some((part) => part.id === draft.id)) {
      window.alert('Pick a part to delete first.');
      return;
    }

    if (!window.confirm(`Delete ${draft.name}? Related parts will be reattached to its source if possible.`)) {
      return;
    }

    deletePartById(draft.id);
  }

  function deletePartById(removedId) {
    if (!canEdit) return;
    const target = state.parts.find((part) => part.id === removedId);
    if (!target) return;
    const removedSourceId = target.sourceId ?? null;
    const parts = state.parts
      .filter((part) => part.id !== removedId)
      .map((part) => ({
        ...part,
        sourceId: part.sourceId === removedId ? removedSourceId : part.sourceId,
        dependencies: part.dependencies.filter((dependencyId) => dependencyId !== removedId),
        dependencyLabels: Object.fromEntries(
          Object.entries(part.dependencyLabels ?? {}).filter(([dependencyId]) => dependencyId !== removedId),
        ),
        dependencyAnchors: Object.fromEntries(
          Object.entries(part.dependencyAnchors ?? {}).filter(([dependencyId]) => dependencyId !== removedId),
        ),
      }));

    const nextSelected = parts[0]?.id ?? null;
    commit({ parts, selectedId: nextSelected, draft: nextSelected ? clonePart(parts[0]) : createEmptyDraft(), connectingFromId: null, pendingConnection: null });
  }

  function beginConnection(partId, event) {
    if (!canEdit) return;
    event.stopPropagation();
    connectionStartRef.current = partId;
    setState((current) => ({ ...current, connectingFromId: partId, pendingConnection: null }));
  }

  function setConnectionMode(mode) {
    if (!canEdit) return;
    setState((current) => ({ ...current, connectionMode: mode, connectingFromId: null, pendingConnection: null }));
    connectionStartRef.current = null;
    setConnectionHoverId(null);
  }

  function onNodeClick(partId) {
    if (state.connectingFromId) {
      if (state.connectingFromId === partId) {
        return;
      }
      completeConnection(partId, connectionStartRef.current ?? state.connectingFromId);
      return;
    }

    selectPart(partId);
  }

  function completeConnection(targetId, sourceId = state.connectingFromId, { history = true } = {}) {
    if (!canEdit) return;
    if (!sourceId || sourceId === targetId) {
      setState((current) => ({ ...current, connectingFromId: null, pendingConnection: null }));
      return;
    }

    if (state.connectionMode === 'source' && !canUseAsSource(sourceId, targetId, state.parts)) {
      window.alert('That source would create a cycle.');
      cancelConnection();
      return;
    }

    commit((current) => {
      const mode = current.connectionMode;
      const fromId = sourceId;
      const parts = current.parts.map((part) => {
        if (mode === 'source' && part.id === targetId) {
          const defaultAnchor = suggestAnchors(fromId, targetId);
          return { ...part, sourceId: fromId, sourceAnchor: defaultAnchor };
        }

        if (mode === 'dependency' && part.id === targetId) {
          if (part.dependencies.includes(fromId)) {
            return part;
          }
          const dependencyName = current.parts.find((entry) => entry.id === fromId)?.name ?? fromId;
          const defaultAnchor = suggestAnchors(fromId, targetId);
          return {
            ...part,
            dependencies: [...part.dependencies, fromId],
            dependencyLabels: {
              ...(part.dependencyLabels ?? {}),
              [fromId]: part.dependencyLabels?.[fromId] ?? `${dependencyName} link`,
            },
            dependencyAnchors: {
              ...(part.dependencyAnchors ?? {}),
              [fromId]: part.dependencyAnchors?.[fromId] ?? defaultAnchor,
            },
          };
        }

        return part;
      });

      return { ...current, parts, connectingFromId: null, pendingConnection: null, selectedId: targetId, draft: clonePart(parts.find((part) => part.id === targetId) ?? current.draft ?? createEmptyDraft()) };
    }, { history });
  }

  function cancelConnection() {
    connectionStartRef.current = null;
    setConnectionHoverId(null);
    setState((current) => ({ ...current, connectingFromId: null, pendingConnection: null }));
  }

  function removeDependency(partId, dependencyId) {
    commit((current) => ({
      ...current,
      parts: current.parts.map((part) => {
        if (part.id !== partId) {
          return part;
        }
        const dependencyAnchors = { ...(part.dependencyAnchors ?? {}) };
        const dependencyLabels = { ...(part.dependencyLabels ?? {}) };
        delete dependencyAnchors[dependencyId];
        delete dependencyLabels[dependencyId];
        return { ...part, dependencies: part.dependencies.filter((id) => id !== dependencyId), dependencyAnchors, dependencyLabels };
      }),
      draft: current.draft?.id === partId
        ? {
            ...current.draft,
            dependencies: current.draft.dependencies.filter((id) => id !== dependencyId),
            dependencyAnchors: Object.fromEntries(Object.entries(current.draft.dependencyAnchors ?? {}).filter(([id]) => id !== dependencyId)),
            dependencyLabels: Object.fromEntries(Object.entries(current.draft.dependencyLabels ?? {}).filter(([id]) => id !== dependencyId)),
          }
        : current.draft,
    }));
  }

  function removeSourceLink(partId) {
    if (!canEdit) return;
    commit((current) => ({
      ...current,
      parts: current.parts.map((part) => (part.id === partId ? { ...part, sourceId: null, sourceAnchor: { from: 'right', to: 'left' } } : part)),
      draft: current.draft?.id === partId ? { ...current.draft, sourceId: null, sourceAnchor: { from: 'right', to: 'left' } } : current.draft,
    }));
  }

  function undo() {
    if (!canEdit) return;
    const previous = historyRef.current.past.pop();
    if (!previous) {
      return;
    }

    historyRef.current.future.push(cloneAppState(state));
    setState({ ...cloneAppState(previous), connectingFromId: null, pendingConnection: null });
    cancelConnection();
  }

  function redo() {
    if (!canEdit) return;
    const next = historyRef.current.future.pop();
    if (!next) {
      return;
    }

    historyRef.current.past.push(cloneAppState(state));
    setState({ ...cloneAppState(next), connectingFromId: null, pendingConnection: null });
    cancelConnection();
  }

  const connectionPreview = useMemo(() => {
    if (!state.connectingFromId) {
      return null;
    }

    const start = graph.positions.get(state.connectingFromId);
    const hover = connectionHoverId ? graph.positions.get(connectionHoverId) : null;
    if (!start || !hover) {
      return null;
    }

    return buildStructuredEdgePath(start, hover, state.connectionMode, 0);
  }, [graph.positions, state.connectingFromId, connectionHoverId, state.connectionMode]);

  function saveVersion() {
    if (!canEdit) return;
    const nextCount = versionCount + 1;
    const snapshot = {
      versionLabel: versionLabel(nextCount),
      savedAt: new Date().toISOString(),
      parts: state.parts.map(clonePart),
      selectedId: state.selectedId,
    };
    const existing = loadVersions();
    const updated = [...existing, snapshot];
    try {
      localStorage.setItem(VERSIONS_KEY, JSON.stringify(updated));
      localStorage.setItem(VERSION_COUNT_KEY, String(nextCount));
    } catch {
      // localStorage quota exceeded — silently ignore
    }
    setVersionCount(nextCount);
  }

  function ensureCloudPassword() {
    // Legacy password gate removed — admin access is now controlled via the
    // Firestore admins list. This stub is kept to avoid breaking any callers
    // and always returns true.
    return true;
  }

  async function migrateLocalDataToCloud() {
    if (!canEdit) {
      setCloudActionStatus('unauthorized');
      return;
    }
    if (!cloudStore.enabled) {
      setCloudActionStatus('unavailable');
      return;
    }

    if (!window.confirm('Upload the current local browser data and saved versions to Firebase cloud? This will overwrite the current cloud snapshot for this account.')) {
      return;
    }

    setCloudActionStatus('migrating');
    setCloudActionError(null);

    try {
      const snapshot = createLocalSnapshot(state, versionCount);
      await cloudStore.saveSnapshot({
        ...snapshot,
        migratedFromLocal: true,
        forcedManualMigration: true,
      });
      localStorage.setItem(getCloudMigrationKey(cloudStore.userKey), 'true');
      setCloudActionStatus('migrated');
    } catch (error) {
      console.error('Manual cloud migration failed:', error);
      setCloudActionError(error?.message ?? String(error));
      setCloudActionStatus('error');
    }
  }

  async function applyTemplate({ parts, runbookConfig, templateName }) {
    if (!isAdmin) return;
    const normalized = normalizePersistedState({
      parts: Array.isArray(parts) ? parts : [],
      selectedId: null,
    });
    setState((prev) => ({
      ...prev,
      parts: normalized.parts,
      selectedId: null,
      draft: null,
    }));
    if (statsRunbookStore.enabled) {
      try {
        await statsRunbookStore.saveConfig(runbookConfig ?? {});
      } catch (error) {
        console.error('Failed to apply runbook config from template:', error);
      }
    }
    setCloudActionStatus('idle');
    setCloudActionError(null);
    if (templateName) {
      window.setTimeout(() => {
        window.alert(`Template "${templateName}" applied. Switching to the blueprint…`);
      }, 50);
    }
    setCurrentPage('blueprint');
  }

  // Phase 0 safety-net: download a single JSON snapshot of EVERYTHING
  // (blueprint, runbook config, users, admin emails, templates, local
  // versions). Use this before any data-touching change so you always
  // have a known-good restore point. Admin-only.
  async function exportEverythingAsJson() {
    if (!isAdmin) {
      setCloudActionStatus('unauthorized');
      return;
    }
    setCloudActionStatus('exporting');
    setCloudActionError(null);
    try {
      const templateStore = createTemplateStore();
      const templates = templateStore.enabled ? await templateStore.loadTemplates() : [];
      const snapshot = {
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        exportedBy: callerEmail ?? '',
        blueprint: {
          parts: state.parts,
          selectedId: state.selectedId,
        },
        runbookConfig: runbookConfigForStats ?? {},
        users,
        adminEmails,
        templates,
        localVersions: loadVersions(),
        localVersionCount: versionCount,
      };
      const json = JSON.stringify(snapshot, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      link.href = url;
      link.download = `kundeplan-backup-${stamp}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setCloudActionStatus('exported');
    } catch (error) {
      console.error('Export everything failed:', error);
      setCloudActionError(error?.message ?? String(error));
      setCloudActionStatus('error');
    }
  }

  async function restoreCloudDataToLocal() {
    if (!canEdit) {
      setCloudActionStatus('unauthorized');
      return;
    }
    if (!cloudStore.enabled) {
      setCloudActionStatus('unavailable');
      return;
    }

    if (!window.confirm('Replace the current local browser data with the latest Firebase cloud snapshot for this account?')) {
      return;
    }

    setCloudActionStatus('restoring');
    setCloudActionError(null);

    try {
      const cloudSnapshot = await cloudStore.loadSnapshot();
      const restored = applyCloudSnapshot(cloudSnapshot, setState, setVersionCount);
      setCloudActionStatus(restored ? 'restored' : 'empty');
    } catch (error) {
      console.error('Restore from cloud failed:', error);
      setCloudActionError(error?.message ?? String(error));
      setCloudActionStatus('error');
    }
  }

  async function recoverLatestLocalBackupToCloud() {
    if (!canEdit) {
      setCloudActionStatus('unauthorized');
      return;
    }
    if (!cloudStore.enabled) {
      setCloudActionStatus('unavailable');
      return;
    }

    const versions = loadVersions();
    const backup = versions.at(-1);
    if (!backup || !Array.isArray(backup.parts)) {
      setCloudActionStatus('no-backup');
      return;
    }

    if (!window.confirm('Recover the latest local version backup and upload it to Firebase cloud for this account?')) {
      return;
    }

    setCloudActionStatus('migrating');
    setCloudActionError(null);

    try {
      const restoredState = normalizePersistedState({
        parts: backup.parts,
        selectedId: backup.selectedId,
      });

      setState(restoredState);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(restoredState));

      const currentVersionCount = loadVersionCount();
      await cloudStore.saveSnapshot({
        state: restoredState,
        versions,
        versionCount: currentVersionCount,
        migratedFromLocal: true,
        recoveredFromLocalVersion: true,
      });

      localStorage.setItem(getCloudMigrationKey(cloudStore.userKey), 'true');
      setCloudActionStatus('migrated');
    } catch (error) {
      console.error('Recover latest local backup failed:', error);
      setCloudActionError(error?.message ?? String(error));
      setCloudActionStatus('error');
    }
  }

  function getExportPixelRatio() {
    const qualityMultiplier = EXPORT_QUALITY_SCALE[exportQuality] ?? EXPORT_QUALITY_SCALE.normal;
    const baseRatio = Math.max(window.devicePixelRatio || 1, 2);
    return baseRatio * qualityMultiplier;
  }

  function renderToCanvas(el, options = {}) {
    const pixelRatio = getExportPixelRatio();
    return htmlToCanvas(el, {
      backgroundColor: '#fffdf6',
      pixelRatio,
      cacheBust: true,
      skipFonts: false,
      style: { transform: 'none', transformOrigin: 'top left' },
      ...options,
    });
  }

  function downloadCanvasAsPNG(canvas, filename) {
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = filename;
        link.href = url;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      'image/png',
      1,
    );
  }

  function downloadCanvasAsPDF(canvas, cssWidth, cssHeight, filename) {
    // Convert CSS pixels to millimeters at 96 DPI so PDF pages are sized sensibly
    // regardless of the high-DPI pixelRatio used to render the canvas.
    const widthMm = (cssWidth / 96) * 25.4;
    const heightMm = (cssHeight / 96) * 25.4;
    const pdf = new jsPDF({
      orientation: widthMm > heightMm ? 'landscape' : 'portrait',
      unit: 'mm',
      format: [widthMm, heightMm],
      compress: true,
    });
    const imgData = canvas.toDataURL('image/png');
    pdf.addImage(imgData, 'PNG', 0, 0, widthMm, heightMm, undefined, 'FAST');
    pdf.save(filename);
  }

  async function captureCanvas() {
    const el = graphCanvasRef.current;
    if (!el) return null;

    const exportPadding = 96;
    const cssWidth = exportBounds.width + exportPadding * 2;
    const cssHeight = exportBounds.height + exportPadding * 2;

    const previousClasses = el.className;
    el.classList.add('is-exporting');
    try {
      const canvas = await renderToCanvas(el, {
        width: cssWidth,
        height: cssHeight,
        canvasWidth: cssWidth,
        canvasHeight: cssHeight,
        style: {
          transform: `translate(${exportPadding}px, ${exportPadding}px)`,
          transformOrigin: 'top left',
          width: `${exportBounds.width}px`,
          height: `${exportBounds.height}px`,
        },
      });
      return { canvas, cssWidth, cssHeight };
    } finally {
      el.className = previousClasses;
    }
  }

  async function exportPNG() {
    const result = await captureCanvas();
    if (!result) return;
    downloadCanvasAsPNG(result.canvas, 'kundeplan.png');
  }

  async function exportPDF() {
    const result = await captureCanvas();
    if (!result) return;
    downloadCanvasAsPDF(result.canvas, result.cssWidth, result.cssHeight, 'kundeplan.pdf');
  }

  async function captureCatalog() {
    const el = catalogRef.current;
    if (!el) return null;
    const cssWidth = el.scrollWidth;
    const cssHeight = el.scrollHeight;
    const canvas = await renderToCanvas(el, {
      width: cssWidth,
      height: cssHeight,
      canvasWidth: cssWidth,
      canvasHeight: cssHeight,
    });
    return { canvas, cssWidth, cssHeight };
  }

  async function exportCatalogPNG() {
    const result = await captureCatalog();
    if (!result) return;
    downloadCanvasAsPNG(result.canvas, 'kundeplan-catalog.png');
  }

  async function exportCatalogPDF() {
    const result = await captureCatalog();
    if (!result) return;
    downloadCanvasAsPDF(result.canvas, result.cssWidth, result.cssHeight, 'kundeplan-catalog.pdf');
  }

  const connectionInstruction = state.connectingFromId
    ? `Click a target box to ${state.connectionMode === 'source' ? 'set a source link' : 'add a dependency'}.`
    : 'Click the link dot on a box, then click the target box.';

  function refreshStructureSummary() {
    setStructureSummary(buildStructureSummary(state.parts));
  }

  // ============================================================
  // USER MANAGEMENT
  // ============================================================

  async function addUser(event) {
    event?.preventDefault?.();
    if (!isAdmin) return;
    const email = (userDraft.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      window.alert('Enter a valid email address.');
      return;
    }
    if (email === SUPER_ADMIN_EMAIL) {
      window.alert('The super-admin is always present and cannot be added manually.');
      return;
    }
    if (effectiveUsers.some((u) => u.email === email)) {
      window.alert('That user is already in the list. Edit their role instead.');
      return;
    }
    setAdminBusy(true);
    setAdminError(null);
    try {
      const nextUsers = [
        ...effectiveUsers.filter((u) => u.email !== email),
        {
          email,
          role: userDraft.role || 'viewer',
          displayName: (userDraft.displayName || '').trim(),
          addedAt: new Date().toISOString(),
          addedBy: callerEmail ?? 'unknown',
        },
      ];
      await userStore.saveUsers(nextUsers);
      setUserDraft({ email: '', role: 'viewer', displayName: '' });
    } catch (error) {
      console.error('Add user failed:', error);
      setAdminError(error?.message ?? String(error));
    } finally {
      setAdminBusy(false);
    }
  }

  function startEditUser(user) {
    setEditingUserEmail(user.email);
    setEditingUserDraft({ ...user });
  }

  function cancelEditUser() {
    setEditingUserEmail(null);
    setEditingUserDraft(null);
  }

  async function saveEditUser() {
    if (!isAdmin || !editingUserDraft) return;
    setAdminBusy(true);
    setAdminError(null);
    try {
      const nextUsers = effectiveUsers.map((u) =>
        u.email === editingUserEmail
          ? {
              ...u,
              role: editingUserDraft.role || u.role,
              displayName: (editingUserDraft.displayName || '').trim(),
            }
          : u,
      );
      await userStore.saveUsers(nextUsers);
      cancelEditUser();
    } catch (error) {
      console.error('Save user failed:', error);
      setAdminError(error?.message ?? String(error));
    } finally {
      setAdminBusy(false);
    }
  }

  async function updateUserRole(email, role) {
    if (!isAdmin) return;
    setAdminBusy(true);
    setAdminError(null);
    try {
      const nextUsers = effectiveUsers.map((u) => (u.email === email ? { ...u, role } : u));
      await userStore.saveUsers(nextUsers);
    } catch (error) {
      console.error('Update role failed:', error);
      setAdminError(error?.message ?? String(error));
    } finally {
      setAdminBusy(false);
    }
  }

  async function deleteUser(email) {
    if (!isAdmin) return;
    if (email === SUPER_ADMIN_EMAIL) {
      window.alert('Cannot remove the super-admin.');
      return;
    }
    if (!window.confirm(`Remove user ${email} from the registry?`)) return;
    setAdminBusy(true);
    setAdminError(null);
    try {
      const nextUsers = effectiveUsers.filter((u) => u.email !== email);
      await userStore.saveUsers(nextUsers);
    } catch (error) {
      console.error('Delete user failed:', error);
      setAdminError(error?.message ?? String(error));
    } finally {
      setAdminBusy(false);
    }
  }

  // Sorted view of users (including the implicit super-admin row)
  const usersForDisplay = useMemo(() => {
    const rows = [
      {
        email: SUPER_ADMIN_EMAIL,
        role: 'admin',
        displayName: 'Super-admin',
        addedAt: null,
        addedBy: 'system',
        isSuper: true,
      },
      ...effectiveUsers
        .filter((u) => u.email !== SUPER_ADMIN_EMAIL)
        .map((u) => ({ ...u, isSuper: false })),
    ];
    rows.sort((a, b) => {
      if (a.isSuper) return -1;
      if (b.isSuper) return 1;
      const sa = ROLES[a.role]?.sortOrder ?? 9;
      const sb = ROLES[b.role]?.sortOrder ?? 9;
      if (sa !== sb) return sa - sb;
      return a.email.localeCompare(b.email);
    });
    return rows;
  }, [effectiveUsers]);

  // ============================================================
  // STATISTICS
  // ============================================================

  const adminStats = useMemo(() => {
    const roleCounts = { admin: 0, editor: 0, viewer: 0 };
    for (const u of usersForDisplay) {
      if (roleCounts[u.role] != null) roleCounts[u.role]++;
    }

    const totalParts = state.parts.length;
    const partsMapLocal = getPartsMap(state.parts);
    const rootCount = state.parts.filter((p) => !p.sourceId || !partsMapLocal.has(p.sourceId)).length;
    const dependencyLinkCount = state.parts.reduce(
      (acc, p) => acc + (p.dependencies ?? []).filter((id) => partsMapLocal.has(id)).length,
      0,
    );
    const sourceLinkCount = state.parts.filter((p) => p.sourceId && partsMapLocal.has(p.sourceId)).length;
    const ownerSet = new Set(state.parts.map((p) => p.owner).filter(Boolean));
    const residenceSet = new Set(state.parts.map((p) => p.residesIn).filter(Boolean));

    const rb = runbookConfigForStats || {};
    const rbEntries = Object.values(rb);
    const stepDone = rbEntries.filter((e) => e?.status === 'done').length;
    const stepInProgress = rbEntries.filter((e) => e?.status === 'in-progress').length;
    const stepSkipped = rbEntries.filter((e) => e?.status === 'skipped').length;
    const stepWithAssignee = rbEntries.filter((e) => e?.assignee).length;
    const todayStr = new Date().toISOString().slice(0, 10);
    const stepOverdue = rbEntries.filter(
      (e) => e?.dueDate && e.dueDate < todayStr && e?.status !== 'done' && e?.status !== 'skipped',
    ).length;
    const stepStartedNotDone = totalParts - stepDone - stepSkipped; // remaining

    const assigneeCounts = new Map();
    for (const e of rbEntries) {
      if (e?.assignee) {
        assigneeCounts.set(e.assignee, (assigneeCounts.get(e.assignee) ?? 0) + 1);
      }
    }
    const topAssignees = [...assigneeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    return {
      roleCounts,
      totalUsers: usersForDisplay.length,
      blueprint: {
        totalParts,
        rootCount,
        sourceLinkCount,
        dependencyLinkCount,
        ownerCount: ownerSet.size,
        residenceCount: residenceSet.size,
      },
      runbook: {
        totalSteps: totalParts,
        done: stepDone,
        inProgress: stepInProgress,
        skipped: stepSkipped,
        overdue: stepOverdue,
        withAssignee: stepWithAssignee,
        remaining: Math.max(0, stepStartedNotDone),
        donePct: totalParts > 0 ? Math.round((stepDone / totalParts) * 100) : 0,
      },
      topAssignees,
    };
  }, [usersForDisplay, state.parts, runbookConfigForStats]);

  return (
    <main className="app-shell">
      <div className="sky-blobs" aria-hidden="true" />
      <header className="hero">
        <button
          type="button"
          className="hero-guide-button"
          onClick={() => setShowUserGuide(true)}
          title="Open the user guide"
          aria-label="Open the user guide"
        >
          <span aria-hidden="true">?</span>
          <span className="hero-guide-label">User guide</span>
        </button>
        <div>
          <p className="eyebrow">ATEA AS customer plan atlas</p>
          <h1>Customer plan - source and relations</h1>
          <p className="hero-copy">
            Track every part, the owner, where it lives, where it is presented, and how it depends on the rest.
            One source of truth keeps updates propagating cleanly across the map.
          </p>
        </div>
        <div className="hero-actions">
          <button
            type="button"
            className="version-save-button"
            onClick={saveVersion}
            disabled={!canEdit}
            title={canEdit ? 'Save a labelled snapshot of the current plan.' : 'Only admins can save versions.'}
          >
            Save version
          </button>
          {versionCount > 0 ? (
            <span className="version-badge">v{versionLabel(versionCount)}</span>
          ) : null}
          {activeAccount ? (
            <span className={`pill ${isAdmin ? 'admin-pill' : 'readonly-pill'}`}>
              {isSuper ? 'Super-admin' : isAdmin ? 'Admin' : 'Read-only'}
            </span>
          ) : null}
          {!auth.enabled ? (
            <span className="auth-disabled-badge" title={auth.publicAccess ? 'Public access is enabled. Sign-in is not required.' : 'SSO is disabled until an Entra App Registration client ID is configured.'}>
              {auth.publicAccess ? 'Public access' : 'SSO not configured'}
            </span>
          ) : null}
          {activeAccount ? (
            <>
              <span className="user-badge" title={activeAccount.username}>
                {activeAccount.name ?? activeAccount.username}
              </span>
              <button
                type="button"
                className="secondary-button"
                onClick={() => auth.signOut?.()}
              >
                Sign out
              </button>
            </>
          ) : null}
        </div>
        <TomAndJerryFlag />
      </header>

      {/* Page navigation tabs */}
      <nav className="page-nav" aria-label="Application pages">
        <button
          type="button"
          className={`page-nav-tab${currentPage === 'blueprint' ? ' is-active' : ''}`}
          onClick={() => setCurrentPage('blueprint')}
          aria-current={currentPage === 'blueprint' ? 'page' : undefined}
        >
          Blueprint map
        </button>
        <button
          type="button"
          className={`page-nav-tab${currentPage === 'runbook' ? ' is-active' : ''}`}
          onClick={() => setCurrentPage('runbook')}
          aria-current={currentPage === 'runbook' ? 'page' : undefined}
        >
          Runbook
        </button>
        <button
          type="button"
          className={`page-nav-tab${currentPage === 'templates' ? ' is-active' : ''}`}
          onClick={() => setCurrentPage('templates')}
          aria-current={currentPage === 'templates' ? 'page' : undefined}
        >
          Templates
        </button>
      </nav>

      {currentPage === 'runbook' ? (
        <Suspense fallback={<PageLoadingFallback label="runbook" />}>
          <RunbookPage parts={state.parts} canEdit={canEditRunbook} />
        </Suspense>
      ) : null}

      {currentPage === 'templates' ? (
        <Suspense fallback={<PageLoadingFallback label="templates" />}>
          <TemplatesPage
            currentParts={state.parts}
            currentRunbookConfig={runbookConfigForStats}
            canManage={isAdmin}
            canApply={isAdmin}
            callerEmail={callerEmail}
            onApplyTemplate={applyTemplate}
          />
        </Suspense>
      ) : null}

      {currentPage === 'blueprint' ? (
      <section className="workspace-grid">        <section className="panel board-panel" ref={boardRef}>
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Blueprint map</p>
              <h2>Parts and dependencies</h2>
            </div>
            <div className="panel-tools panel-tools-compact panel-tools-stacked">
              <div className="panel-tools-row">
                <div className="panel-tools-group">
                  <button type="button" className="primary-button" onClick={openNewPart} disabled={!canEdit}>New part</button>
                  <button type="button" className="secondary-button" onClick={undo} disabled={!canEdit || !historyRef.current.past.length}>Undo</button>
                  <button type="button" className="secondary-button" onClick={redo} disabled={!canEdit || !historyRef.current.future.length}>Redo</button>
                </div>
                <div className="panel-tools-group">
                  <label>
                    Connection mode
                    <select value={state.connectionMode} onChange={(event) => setConnectionMode(event.target.value)} disabled={!canEdit}>
                      <option value="dependency">Dependency</option>
                      <option value="source">Source</option>
                    </select>
                  </label>
                  {state.connectingFromId ? (
                    <button type="button" className="secondary-button" onClick={cancelConnection}>
                      Cancel link
                    </button>
                  ) : null}
                  <div className="edge-legend" aria-label="Connection types">
                    <span className="edge-legend-item edge-legend-source">Source link</span>
                    <span className="edge-legend-item edge-legend-dependency">Dependency</span>
                  </div>
                </div>
                <span className="pill connection-instruction-pill">{connectionInstruction}</span>
              </div>
              <div className="panel-tools-row panel-tools-row-export">
                <div className="panel-tools-group">
                  <label>
                    Export quality
                    <select value={exportQuality} onChange={(event) => setExportQuality(event.target.value)}>
                      <option value="normal">Normal</option>
                      <option value="high">High</option>
                    </select>
                  </label>
                  <button type="button" className="secondary-button" onClick={exportPNG}>Export PNG</button>
                  <button type="button" className="secondary-button" onClick={exportPDF}>Export PDF</button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={refreshStructureSummary}
                    title="Generate a fresh summary of sources and dependencies in the flow canvas"
                  >
                    Structure summary
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="graph-stage" ref={graphStageRef} aria-live="polite" onClick={state.connectingFromId ? cancelConnection : undefined}>
            <div
              ref={graphCanvasRef}
            className="graph-canvas"
              style={{
                width: `${graph.width}px`,
                height: `${graph.height}px`,
              }}
            >
            <svg viewBox={`0 0 ${graph.width} ${graph.height}`} preserveAspectRatio="xMinYMin meet" style={{ width: `${graph.width}px`, height: `${graph.height}px` }} aria-hidden="true">
              <defs>
                <marker id="arrow-source" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="rgb(42, 152, 134)" />
                </marker>
                <marker id="arrow-dependency" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="rgb(255, 161, 67)" />
                </marker>
                <marker id="arrow-highlighted" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#1d9c8f" />
                </marker>
                <marker id="arrow-preview" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#ff5f92" />
                </marker>
              </defs>
              <g strokeLinecap="round" strokeLinejoin="round">
                {state.parts.map((part) => {
                  const source = part.sourceId ? graph.positions.get(part.sourceId) : null;
                  const target = graph.positions.get(part.id);
                  if (!source || !target) {
                    return null;
                  }

                  const anchors = resolveAnchors(part.sourceId, part.id, part.sourceAnchor);

                  return (
                    <path
                      key={`${part.id}-${part.sourceId}`}
                      d={buildStructuredEdgePath(source, target, 'source', 0, anchors)}
                      className={`edge-line edge-source ${part.id === selectedId ? 'is-highlighted' : ''}`}
                      onMouseEnter={() => setHoveredLink({ kind: 'source', targetId: part.id, sourceId: part.sourceId })}
                      onMouseLeave={() => setHoveredLink((current) => (current?.kind === 'source' && current?.targetId === part.id ? null : current))}
                    />
                  );
                })}
                {(() => {
                  const dependencyLaneCounts = new Map();
                  return state.parts.flatMap((part) =>
                    part.dependencies.map((dependencyId) => {
                      const source = graph.positions.get(dependencyId);
                      const target = graph.positions.get(part.id);
                      if (!source || !target) {
                        return null;
                      }

                      const lane = dependencyLaneCounts.get(part.id) ?? 0;
                      dependencyLaneCounts.set(part.id, lane + 1);
                      const anchors = resolveAnchors(dependencyId, part.id, part.dependencyAnchors?.[dependencyId]);
                      const geometry = getEdgeGeometry(source, target, 'dependency', lane, anchors);

                      return (
                        <g key={`${part.id}-${dependencyId}`}>
                          <path
                            d={geometry.path}
                            className="edge-line edge-dependency"
                            onMouseEnter={() => setHoveredLink({ kind: 'dependency', targetId: part.id, sourceId: dependencyId })}
                            onMouseLeave={() => setHoveredLink((current) => (current?.kind === 'dependency' && current?.targetId === part.id && current?.sourceId === dependencyId ? null : current))}
                          />
                        </g>
                      );
                    }),
                  );
                })()}
                {connectionPreview ? <path d={connectionPreview} className="edge-line connection-preview" /> : null}
                {state.parts.map((part) => {
                  const source = part.sourceId ? graph.positions.get(part.sourceId) : null;
                  const target = graph.positions.get(part.id);
                  if (!source || !target) {
                    return null;
                  }

                  const showHandles = part.id === selectedId || (hoveredLink?.kind === 'source' && hoveredLink?.targetId === part.id);
                  if (!showHandles) {
                    return null;
                  }

                  const anchors = resolveAnchors(part.sourceId, part.id, part.sourceAnchor);
                  const startPoint = getAnchorPoint(source, anchors.from);
                  const endPoint = getAnchorPoint(target, anchors.to);

                  return (
                    <g key={`source-handles-${part.id}-${part.sourceId}`}>
                      <circle
                        className="edge-anchor-handle edge-anchor-start edge-anchor-source"
                        cx={startPoint.x}
                        cy={startPoint.y}
                        r="7"
                        onPointerDown={(event) => event.stopPropagation()}
                        onMouseEnter={() => setHoveredLink({ kind: 'source', targetId: part.id, sourceId: part.sourceId })}
                        onMouseLeave={() => setHoveredLink((current) => (current?.kind === 'source' && current?.targetId === part.id ? null : current))}
                        onClick={(event) => {
                          event.stopPropagation();
                          cycleSourceAnchorSide(part.id, 'from');
                        }}
                      >
                        <title>Cycle source start side</title>
                      </circle>
                      <circle
                        className="edge-anchor-handle edge-anchor-end edge-anchor-source"
                        cx={endPoint.x}
                        cy={endPoint.y}
                        r="7"
                        onPointerDown={(event) => event.stopPropagation()}
                        onMouseEnter={() => setHoveredLink({ kind: 'source', targetId: part.id, sourceId: part.sourceId })}
                        onMouseLeave={() => setHoveredLink((current) => (current?.kind === 'source' && current?.targetId === part.id ? null : current))}
                        onClick={(event) => {
                          event.stopPropagation();
                          cycleSourceAnchorSide(part.id, 'to');
                        }}
                      >
                        <title>Cycle source end side</title>
                      </circle>
                    </g>
                  );
                })}
                {state.parts.flatMap((part) =>
                  part.dependencies.map((dependencyId) => {
                    const source = graph.positions.get(dependencyId);
                    const target = graph.positions.get(part.id);
                    if (!source || !target) {
                      return null;
                    }

                    const showHandles =
                      part.id === selectedId
                      || (hoveredLink?.kind === 'dependency' && hoveredLink?.targetId === part.id && hoveredLink?.sourceId === dependencyId);
                    if (!showHandles) {
                      return null;
                    }

                    const anchors = resolveAnchors(dependencyId, part.id, part.dependencyAnchors?.[dependencyId]);
                    const startPoint = getAnchorPoint(source, anchors.from);
                    const endPoint = getAnchorPoint(target, anchors.to);

                    return (
                      <g key={`dependency-handles-${part.id}-${dependencyId}`}>
                        <circle
                          className="edge-anchor-handle edge-anchor-start edge-anchor-dependency"
                          cx={startPoint.x}
                          cy={startPoint.y}
                          r="6"
                          onPointerDown={(event) => event.stopPropagation()}
                          onMouseEnter={() => setHoveredLink({ kind: 'dependency', targetId: part.id, sourceId: dependencyId })}
                          onMouseLeave={() => setHoveredLink((current) => (current?.kind === 'dependency' && current?.targetId === part.id && current?.sourceId === dependencyId ? null : current))}
                          onClick={(event) => {
                            event.stopPropagation();
                            cycleDependencyAnchorSide(part.id, dependencyId, 'from');
                          }}
                        >
                          <title>Cycle dependency start side</title>
                        </circle>
                        <circle
                          className="edge-anchor-handle edge-anchor-end edge-anchor-dependency"
                          cx={endPoint.x}
                          cy={endPoint.y}
                          r="6"
                          onPointerDown={(event) => event.stopPropagation()}
                          onMouseEnter={() => setHoveredLink({ kind: 'dependency', targetId: part.id, sourceId: dependencyId })}
                          onMouseLeave={() => setHoveredLink((current) => (current?.kind === 'dependency' && current?.targetId === part.id && current?.sourceId === dependencyId ? null : current))}
                          onClick={(event) => {
                            event.stopPropagation();
                            cycleDependencyAnchorSide(part.id, dependencyId, 'to');
                          }}
                        >
                          <title>Cycle dependency end side</title>
                        </circle>
                      </g>
                    );
                  }),
                )}
              </g>
            </svg>

            <div className="node-layer" style={{ minWidth: `${graph.width}px`, minHeight: `${graph.height}px` }}>
              {graph.nodes.map(({ part, depth }) => {
                const position = graph.positions.get(part.id) ?? { x: 120, y: 120 };
                const resolved = getResolvedPart(part.id, state.parts) ?? part;
                const selected = part.id === selectedId ? 'is-selected' : '';
                const sourceClass = part.sourceId ? 'is-source' : '';
                const color = colorPalette[depth % colorPalette.length];
                const sourceChainText = getSourceChainNames(part, graph.partsMap).length ? getSourceChainNames(part, graph.partsMap).join(' → ') : 'Source root';

                return (
                  <button
                    type="button"
                    key={part.id}
                    data-part-id={part.id}
                    className={`graph-node ${selected} ${sourceClass} ${state.connectingFromId === part.id ? 'is-connecting-from' : ''} ${connectionHoverId === part.id ? 'is-connect-target' : ''} ${draggingNodeId === part.id ? 'is-dragging' : ''} ${justSavedId === part.id ? 'is-just-saved' : ''}`}
                    style={{ left: position.x, top: position.y, width: `${NODE_WIDTH}px`, height: `${NODE_HEIGHT}px`, '--node-color': color }}
                    onClick={(event) => {
                      const shouldSuppressClick = suppressClickRef.current === part.id;
                      suppressClickRef.current = null;
                      if (shouldSuppressClick) {
                        event.stopPropagation();
                        return;
                      }
                      event.stopPropagation();
                      onNodeClick(part.id);
                    }}
                    onPointerDown={(event) => beginNodeDrag(part.id, event)}
                    onPointerMove={onNodePointerMove}
                    onPointerUp={endNodeDrag}
                    onPointerCancel={endNodeDrag}
                    onMouseEnter={() => {
                      if (state.connectingFromId && state.connectingFromId !== part.id) {
                        setConnectionHoverId(part.id);
                      }
                    }}
                    onMouseLeave={() => {
                      if (connectionHoverId === part.id) {
                        setConnectionHoverId(null);
                      }
                    }}
                  >
                    <span
                      className={`graph-handle-wrap${openHandleMenuId === part.id ? ' is-open' : ''}`}
                      onMouseEnter={() => setOpenHandleMenuId(part.id)}
                      onMouseLeave={() => setOpenHandleMenuId((current) => (current === part.id ? null : current))}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <span
                        className="graph-handle"
                        onPointerDown={(event) => beginConnection(part.id, event)}
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpenHandleMenuId(part.id);
                        }}
                        title="Click to choose connection type"
                      >
                        ↘
                      </span>
                      <span className="graph-handle-menu" role="menu" aria-label="Choose connection type">
                        <span
                          role="menuitem"
                          tabIndex={0}
                          className="graph-handle-menu-item is-source"
                          onClick={(event) => {
                            event.stopPropagation();
                            setState((current) => ({ ...current, connectionMode: 'source', connectingFromId: part.id, pendingConnection: null }));
                            connectionStartRef.current = part.id;
                            setOpenHandleMenuId(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              event.stopPropagation();
                              setState((current) => ({ ...current, connectionMode: 'source', connectingFromId: part.id, pendingConnection: null }));
                              connectionStartRef.current = part.id;
                              setOpenHandleMenuId(null);
                            }
                          }}
                        >
                          Connect <strong>SOURCE</strong>
                        </span>
                        <span
                          role="menuitem"
                          tabIndex={0}
                          className="graph-handle-menu-item is-dependency"
                          onClick={(event) => {
                            event.stopPropagation();
                            setState((current) => ({ ...current, connectionMode: 'dependency', connectingFromId: part.id, pendingConnection: null }));
                            connectionStartRef.current = part.id;
                            setOpenHandleMenuId(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              event.stopPropagation();
                              setState((current) => ({ ...current, connectionMode: 'dependency', connectingFromId: part.id, pendingConnection: null }));
                              connectionStartRef.current = part.id;
                              setOpenHandleMenuId(null);
                            }
                          }}
                        >
                          Connect <strong>DEPENDENCY</strong>
                        </span>
                        <span
                          role="button"
                          tabIndex={0}
                          className="graph-handle-menu-close"
                          aria-label="Close"
                          onClick={(event) => {
                            event.stopPropagation();
                            setOpenHandleMenuId(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              event.stopPropagation();
                              setOpenHandleMenuId(null);
                            }
                          }}
                        >
                          ×
                        </span>
                      </span>
                    </span>
                    <span
                      className={`graph-edit-wrap${openEditMenuId === part.id ? ' is-open' : ''}`}
                      onMouseEnter={() => setOpenEditMenuId(part.id)}
                      onMouseLeave={() => setOpenEditMenuId((current) => (current === part.id ? null : current))}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <span
                        className="graph-edit-handle"
                        role="button"
                        tabIndex={0}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpenEditMenuId(part.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            event.stopPropagation();
                            setOpenEditMenuId(part.id);
                          }
                        }}
                        title="Click to edit / add / delete this part"
                      >
                        ✎
                      </span>
                      <span className="graph-handle-menu graph-edit-menu" role="menu" aria-label="Part actions">
                        <span
                          role="menuitem"
                          tabIndex={0}
                          className="graph-handle-menu-item is-edit"
                          onClick={(event) => {
                            event.stopPropagation();
                            setOpenEditMenuId(null);
                            editPartInInspector(part.id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              event.stopPropagation();
                              setOpenEditMenuId(null);
                              editPartInInspector(part.id);
                            }
                          }}
                        >
                          <strong>EDIT</strong> in inspector
                        </span>
                        <span
                          role="menuitem"
                          tabIndex={0}
                          className="graph-handle-menu-item is-new"
                          onClick={(event) => {
                            event.stopPropagation();
                            setOpenEditMenuId(null);
                            openNewPartFrom(part.id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              event.stopPropagation();
                              setOpenEditMenuId(null);
                              openNewPartFrom(part.id);
                            }
                          }}
                        >
                          <strong>NEW</strong> part from here
                        </span>
                        <span
                          role="menuitem"
                          tabIndex={0}
                          className="graph-handle-menu-item is-delete"
                          onClick={(event) => {
                            event.stopPropagation();
                            setOpenEditMenuId(null);
                            if (window.confirm(`Delete ${part.name}? Related parts will be reattached to its source if possible.`)) {
                              deletePartById(part.id);
                            }
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              event.stopPropagation();
                              setOpenEditMenuId(null);
                              if (window.confirm(`Delete ${part.name}? Related parts will be reattached to its source if possible.`)) {
                                deletePartById(part.id);
                              }
                            }
                          }}
                        >
                          <strong>DELETE</strong> part
                        </span>
                        <span
                          role="button"
                          tabIndex={0}
                          className="graph-handle-menu-close"
                          aria-label="Close"
                          onClick={(event) => {
                            event.stopPropagation();
                            setOpenEditMenuId(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              event.stopPropagation();
                              setOpenEditMenuId(null);
                            }
                          }}
                        >
                          ×
                        </span>
                      </span>
                    </span>
                    <span className="node-title">{part.name}</span>
                    <span className="node-meta">{resolved.owner || 'No owner yet'}</span>
                    <span className="chip">{resolved.residesIn || 'No residence'}</span>
                    <span className="chip">{resolved.presentedIn || 'No presentation'}</span>
                    <span className="node-legend">
                      <span className="ribbon">{sourceChainText}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            </div>
          </div>
        </section>

        <section className="panel list-panel">
          <div className="panel-header catalog-header">
            <div className="catalog-header-intro">
              <p className="panel-kicker">Catalog</p>
              <h2>All parts grouped by residence</h2>
              <p className="panel-note">This table gives the exact owner, presentation point, and dependency footprint for each part.</p>
            </div>
            <div className="panel-tools panel-tools-compact catalog-header-actions">
              {FEATURE_FLAGS.searchAndFilter ? (
                <label className="catalog-search-label">
                  Search
                  <div className="catalog-search-input-wrap">
                    <input
                      type="search"
                      className="catalog-search-input"
                      value={catalogSearch}
                      onChange={(event) => setCatalogSearch(event.target.value)}
                      placeholder="Name, owner, residence, notes…"
                      aria-label="Search the catalog"
                    />
                    {catalogSearch ? (
                      <button
                        type="button"
                        className="catalog-search-clear"
                        onClick={() => setCatalogSearch('')}
                        aria-label="Clear search"
                      >
                        ×
                      </button>
                    ) : null}
                  </div>
                </label>
              ) : null}
              <label>
                Export quality
                <select value={exportQuality} onChange={(event) => setExportQuality(event.target.value)}>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              </label>
              <div className="panel-tools-group">
                <button type="button" className="secondary-button" onClick={exportCatalogPNG}>Export PNG</button>
                <button type="button" className="secondary-button" onClick={exportCatalogPDF}>Export PDF</button>
              </div>
            </div>
          </div>
          {FEATURE_FLAGS.searchAndFilter && trimmedCatalogSearch ? (
            <p className="catalog-search-status">
              Showing <strong>{visibleCatalogParts}</strong> of <strong>{totalCatalogParts}</strong> parts matching
              {' '}&ldquo;{catalogSearch.trim()}&rdquo;.
            </p>
          ) : null}
          <div className="catalog" ref={catalogRef}>
            {filteredGroupedParts.length === 0 ? (
              <p className="catalog-empty">No parts match your search.</p>
            ) : null}
            {filteredGroupedParts.map(([residence, parts]) => (
              <section className="catalog-group" key={residence}>
                <h3>{residence}</h3>
                <div className="catalog-list">
                  {parts.map((part) => {
                    const summary = getSourceChainNames(part, partsMap);
                    const sourceName = part.sourceId ? partsMap.get(part.sourceId)?.name ?? 'Missing source' : 'Source root';
                    const isDerived = summary.length > 0;
                    return (
                      <button type="button" className={`catalog-item ${part.id === selectedId ? 'is-selected' : ''}`} key={part.id} onClick={() => selectPart(part.id)}>
                        <div className="catalog-title">
                          <span>{part.name}</span>
                          <span className={`ribbon ${isDerived ? 'ribbon-derived' : 'ribbon-source'}`}>{isDerived ? 'Derived' : 'Source'}</span>
                        </div>
                        <div className="supporting-note">Owner: {part.owner || 'Unassigned'}</div>
                        <div className="supporting-note">Presented in: {part.presentedIn || 'Not set'}</div>
                        <div className="supporting-note">Source: {sourceName}</div>
                        <div className="catalog-meta">
                          {part.dependencies.length ? part.dependencies.map((dependencyId) => <span className="part-chip" key={dependencyId}>{partsMap.get(dependencyId)?.name ?? dependencyId}</span>) : <span className="part-chip">No dependencies</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </section>

        <aside className="panel inspector-panel" ref={inspectorRef}>
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Inspector</p>
              <h2>Edit one part at a time</h2>
            </div>
          </div>

          <form className="part-form" onSubmit={savePart}>
            <fieldset disabled={!canEdit} style={canEdit ? undefined : { border: 0, padding: 0, margin: 0, opacity: 0.7 }}>
            <div className="form-row">
              <label className={`part-name-label${startHereHint ? ' start-here-active' : ''}`}>
                Part name
                {startHereHint && <span className="start-here-bubble" aria-hidden="true">Start here :-)</span>}
                <input
                  ref={partNameInputRef}
                  name="name"
                  type="text"
                  value={draft?.name ?? ''}
                  onChange={(event) => updateDraft('name', event.target.value)}
                  placeholder="Customer plan epic"
                  className={startHereHint ? 'start-here-pulse' : ''}
                  required
                />
              </label>
              <label>
                Owner
                <input name="owner" type="text" value={draft?.owner ?? ''} onChange={(event) => updateDraft('owner', event.target.value)} placeholder="Plan steward" />
              </label>
            </div>

            <div className="form-row">
              <label>
                Resides in
                <input name="residesIn" type="text" value={draft?.residesIn ?? ''} onChange={(event) => updateDraft('residesIn', event.target.value)} placeholder="Portfolio vault" />
              </label>
              <label>
                Presented in
                <input name="presentedIn" type="text" value={draft?.presentedIn ?? ''} onChange={(event) => updateDraft('presentedIn', event.target.value)} placeholder="Steering board" />
              </label>
            </div>

            <label>
              Source part
              <select
                value={draft?.sourceId ?? ''}
                onChange={(event) => {
                  if (!draft) {
                    return;
                  }

                  const nextSourceId = event.target.value || null;
                  const nextAnchor = nextSourceId ? suggestAnchors(nextSourceId, draft.id) : { from: 'right', to: 'left' };
                  setState((current) => ({
                    ...current,
                    draft: current.draft
                      ? {
                          ...current.draft,
                          sourceId: nextSourceId,
                          sourceAnchor: nextAnchor,
                        }
                      : current.draft,
                  }));
                }}
              >
                <option value="">No source / root part</option>
                {state.parts
                  .filter((part) => part.id !== draft?.id)
                  .map((part) => (
                    <option value={part.id} key={part.id}>
                      {part.name}
                    </option>
                  ))}
              </select>
            </label>

            {draft?.sourceId ? (
              <div className="link-anchor-editor">
                <div className="picker-header">
                  <span>Source link endpoints</span>
                  <span className="hint">Choose which side the source line connects to</span>
                </div>
                <div className="form-row">
                  <label>
                    Start side on source box
                    <select value={draft.sourceAnchor?.from ?? 'right'} onChange={(event) => updateSourceAnchor('from', event.target.value)}>
                      {ANCHOR_SIDES.map((side) => (
                        <option value={side} key={side}>{ANCHOR_LABELS[side]}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    End side on this box
                    <select value={draft.sourceAnchor?.to ?? 'left'} onChange={(event) => updateSourceAnchor('to', event.target.value)}>
                      {ANCHOR_SIDES.map((side) => (
                        <option value={side} key={side}>{ANCHOR_LABELS[side]}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            ) : null}

            <label>
              Notes
              <textarea
                rows="4"
                value={draft?.description ?? ''}
                onChange={(event) => updateDraft('description', event.target.value)}
                placeholder="Short description, rules, or context. Blank values inherit from the source part."
              />
            </label>

            <div className="form-actions">
              <button type="submit" className="primary-button">Save part</button>
              <button type="button" className="danger-button" onClick={deletePart}>Delete part</button>
              <button type="button" className="secondary-button" onClick={() => removeSourceLink(draft?.id)} disabled={!draft?.sourceId}>Clear source</button>
            </div>

            <div className="dependency-picker">
              <div className="picker-header">
                <span>Dependency manager</span>
                <span className="hint">Create, label, and remove dependencies for this part</span>
              </div>
              <div className="dependency-create-row">
                <label>
                  Add dependency from part
                  <select value={newDependencyId} onChange={(event) => setNewDependencyId(event.target.value)}>
                    <option value="">Select part</option>
                    {addableDependencies.map((part) => (
                      <option value={part.id} key={part.id}>{part.name}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    if (!newDependencyId) {
                      return;
                    }
                    addDependencyToDraft(newDependencyId);
                    setNewDependencyId('');
                  }}
                  disabled={!newDependencyId}
                >
                  Add dependency
                </button>
              </div>

              {!draft?.dependencies?.length ? <p className="catalog-empty">No dependencies yet.</p> : null}
              <div className="dependency-manager-list">
                {(draft?.dependencies ?? []).map((dependencyId) => {
                  const dependencyName = partsMap.get(dependencyId)?.name ?? dependencyId;
                  return (
                    <div className="dependency-manager-item" key={dependencyId}>
                      <div className="dependency-manager-head">
                        <strong>{dependencyName}</strong>
                        <button type="button" className="danger-button" onClick={() => removeDependencyFromDraft(dependencyId)}>Remove</button>
                      </div>
                      <label>
                        Dependency label
                        <input
                          type="text"
                          value={draft?.dependencyLabels?.[dependencyId] ?? ''}
                          onChange={(event) => updateDependencyLabel(dependencyId, event.target.value)}
                          placeholder="e.g. Feeds status updates"
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>

            {draft?.dependencies?.length ? (
              <div className="link-anchor-editor">
                <div className="picker-header">
                  <span>Dependency line endpoints</span>
                  <span className="hint">Set where each dependency line starts and ends</span>
                </div>
                <div className="dependency-anchor-list">
                  {draft.dependencies.map((dependencyId) => {
                    const dependencyName = partsMap.get(dependencyId)?.name ?? dependencyId;
                    const anchor = draft.dependencyAnchors?.[dependencyId] ?? suggestAnchors(dependencyId, draft.id);
                    return (
                      <div className="dependency-anchor-item" key={dependencyId}>
                        <div className="dependency-anchor-title">{dependencyName}</div>
                        <div className="form-row">
                          <label>
                            Start side on dependency box
                            <select value={anchor.from} onChange={(event) => updateDependencyAnchor(dependencyId, 'from', event.target.value)}>
                              {ANCHOR_SIDES.map((side) => (
                                <option value={side} key={side}>{ANCHOR_LABELS[side]}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            End side on this box
                            <select value={anchor.to} onChange={(event) => updateDependencyAnchor(dependencyId, 'to', event.target.value)}>
                              {ANCHOR_SIDES.map((side) => (
                                <option value={side} key={side}>{ANCHOR_LABELS[side]}</option>
                              ))}
                            </select>
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
            </fieldset>
          </form>

          <div className="details-card">
            <div className="details-head">
              <p className="panel-kicker">Selected part</p>
              <span className="pill">{draft ? (state.parts.some((part) => part.id === draft.id) ? 'Editing existing part' : 'New draft') : 'Nothing selected'}</span>
            </div>
            <div className="detail-view">
              {!draft ? (
                <p className="catalog-empty">Click a node or catalog entry to inspect a part. New parts can start as blank or inherit from the currently selected source.</p>
              ) : (
                <>
                  <DetailLine label="Name" value={selectedResolved?.name || 'Untitled'} />
                  <DetailLine label="Owner" value={selectedResolved?.owner || 'Inherit from source'} />
                  <DetailLine label="Resides in" value={selectedResolved?.residesIn || 'Inherit from source'} />
                  <DetailLine label="Presented in" value={selectedResolved?.presentedIn || 'Inherit from source'} />
                  <DetailLine label="Source" value={draft.sourceId ? partsMap.get(draft.sourceId)?.name ?? 'Missing source' : 'Source root'} />
                  <DetailLine label="Dependencies" value={draft.dependencies.length ? draft.dependencies.map((dependencyId) => partsMap.get(dependencyId)?.name).filter(Boolean).join(', ') : 'No dependencies yet'} />
                  <DetailLine label="Origin chain" value={sourceChain.length ? sourceChain.join(' → ') : 'This part starts the chain'} />
                  <DetailLine label="Notes" value={selectedResolved?.description || 'No notes yet'} />
                </>
              )}
            </div>
          </div>
        </aside>
      </section>
      ) : null}

      <section className="stats-row" aria-label="Plan summary">
        {stats.map(([value, label]) => (
          <article className="stat-card" key={label}>
            <span className="stat-value">{value}</span>
            <span className="stat-label">{label}</span>
          </article>
        ))}
      </section>

      {isAdmin ? (
      <section className="panel cloud-panel">
        <div className="panel-header cloud-panel-header">
          <div>
            <p className="panel-kicker">Cloud sync</p>
            <h2>Firebase backup and restore</h2>
            <p className="panel-note">
              Push this browser&apos;s local data to Firebase, or restore the latest Firebase snapshot back into this device.
            </p>
          </div>
          <div className="cloud-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={migrateLocalDataToCloud}
              disabled={!cloudStore.enabled || cloudActionStatus === 'migrating' || cloudActionStatus === 'restoring'}
              title={cloudStore.enabled ? 'Upload current local browser data to Firebase for this account.' : 'Firebase cloud sync is unavailable until Firebase environment variables are configured.'}
            >
              {cloudActionStatus === 'migrating' ? 'Migrating…' : 'Migrate local to cloud'}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={restoreCloudDataToLocal}
              disabled={!cloudStore.enabled || cloudActionStatus === 'migrating' || cloudActionStatus === 'restoring'}
              title={cloudStore.enabled ? 'Replace local browser data with the latest Firebase snapshot for this account.' : 'Firebase cloud sync is unavailable until Firebase environment variables are configured.'}
            >
              {cloudActionStatus === 'restoring' ? 'Restoring…' : 'Restore cloud to local'}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={recoverLatestLocalBackupToCloud}
              disabled={!cloudStore.enabled || cloudActionStatus === 'migrating' || cloudActionStatus === 'restoring'}
              title={cloudStore.enabled ? 'Recover the latest local version backup and upload it to Firebase for this account.' : 'Firebase cloud sync is unavailable until Firebase environment variables are configured.'}
            >
              Recover latest local backup
            </button>
            {FEATURE_FLAGS.exportEverything ? (
              <button
                type="button"
                className="secondary-button"
                onClick={exportEverythingAsJson}
                disabled={cloudActionStatus === 'exporting' || cloudActionStatus === 'migrating' || cloudActionStatus === 'restoring'}
                title="Download a full JSON snapshot of blueprint, runbook, users, templates and local versions. Use as a safety backup before any large change."
              >
                {cloudActionStatus === 'exporting' ? 'Exporting…' : 'Export everything (JSON)'}
              </button>
            ) : null}
            <span className="pill cloud-user-pill">
              {cloudStore.enabled ? `Cloud user: ${cloudStore.userKey}` : 'Firebase not configured'}
            </span>
            {cloudActionStatus !== 'idle' ? (
              <span className={`cloud-status-badge is-${cloudActionStatus}`}>
                {
                  {
                    migrated: 'Cloud updated',
                    restored: 'Local data restored',
                    empty: 'No cloud snapshot found',
                    error: 'Cloud action failed',
                    unavailable: 'Cloud unavailable',
                    unauthorized: 'Not authorized (admin only)',
                    'no-backup': 'No local backup found',
                    migrating: 'Uploading…',
                    restoring: 'Downloading…',
                    exporting: 'Preparing backup…',
                    exported: 'Backup downloaded',
                  }[cloudActionStatus]
                }
              </span>
            ) : null}
            {cloudActionStatus === 'error' && cloudActionError ? (
              <span className="cloud-status-error" title={cloudActionError}>
                {cloudActionError}
              </span>
            ) : null}
          </div>
        </div>
      </section>
      ) : null}

      {isAdmin ? (
      <section className="panel cloud-panel admin-panel users-panel">
        <div className="panel-header cloud-panel-header">
          <div>
            <p className="panel-kicker">Users &amp; roles</p>
            <h2>Manage users, assign roles, and audit access</h2>
            <p className="panel-note">
              Add, edit, or remove users and assign them a role. Only admins can change the shared cloud data;
              editors can update the runbook; viewers have read-only access.
              {isSuper ? ' You are the super-admin and can always manage this list.' : ''}
            </p>
          </div>
        </div>

        {/* Add user form */}
        <form className="user-add-form" onSubmit={addUser}>
          <label className="user-add-field">
            <span>Email</span>
            <input
              type="email"
              value={userDraft.email}
              onChange={(e) => setUserDraft((d) => ({ ...d, email: e.target.value }))}
              placeholder="someone@atea.no"
              disabled={adminBusy || !userStore.enabled}
              required
            />
          </label>
          <label className="user-add-field">
            <span>Display name</span>
            <input
              type="text"
              value={userDraft.displayName}
              onChange={(e) => setUserDraft((d) => ({ ...d, displayName: e.target.value }))}
              placeholder="Optional friendly name"
              disabled={adminBusy || !userStore.enabled}
            />
          </label>
          <label className="user-add-field">
            <span>Role</span>
            <select
              value={userDraft.role}
              onChange={(e) => setUserDraft((d) => ({ ...d, role: e.target.value }))}
              disabled={adminBusy || !userStore.enabled}
            >
              {Object.entries(ROLES).map(([key, meta]) => (
                <option key={key} value={key}>{meta.label}</option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="primary-button"
            disabled={adminBusy || !userStore.enabled || !userDraft.email.trim()}
          >
            {adminBusy ? 'Saving…' : 'Add user'}
          </button>
        </form>

        {/* Role legend */}
        <div className="user-role-legend">
          {Object.entries(ROLES).map(([key, meta]) => (
            <span key={key} className={`user-role-pill role-${key}`}>
              <strong>{meta.label}</strong> — {meta.description}
            </span>
          ))}
        </div>

        {/* Users table */}
        <div className="user-table-wrap">
          <table className="user-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Display name</th>
                <th>Role</th>
                <th>Added by</th>
                <th>Added at</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {usersForDisplay.length === 0 ? (
                <tr>
                  <td colSpan={6} className="user-table-empty">No users yet. Add the first one above.</td>
                </tr>
              ) : (
                usersForDisplay.map((user) => {
                  const isEditing = editingUserEmail === user.email;
                  return (
                    <tr key={user.email} className={`role-row-${user.role} ${user.isSuper ? 'is-super' : ''}`}>
                      <td className="user-email">
                        {user.email}
                        {user.isSuper ? <span className="pill cloud-user-pill">Super</span> : null}
                      </td>
                      <td>
                        {isEditing ? (
                          <input
                            type="text"
                            value={editingUserDraft?.displayName ?? ''}
                            onChange={(e) => setEditingUserDraft((d) => ({ ...d, displayName: e.target.value }))}
                            disabled={adminBusy}
                          />
                        ) : (
                          user.displayName || <span className="user-empty-cell">—</span>
                        )}
                      </td>
                      <td>
                        {user.isSuper ? (
                          <span className={`user-role-badge role-${user.role}`}>{ROLES[user.role]?.label ?? user.role}</span>
                        ) : isEditing ? (
                          <select
                            value={editingUserDraft?.role ?? user.role}
                            onChange={(e) => setEditingUserDraft((d) => ({ ...d, role: e.target.value }))}
                            disabled={adminBusy}
                          >
                            {Object.entries(ROLES).map(([key, meta]) => (
                              <option key={key} value={key}>{meta.label}</option>
                            ))}
                          </select>
                        ) : (
                          <select
                            value={user.role}
                            onChange={(e) => updateUserRole(user.email, e.target.value)}
                            disabled={adminBusy}
                            className={`role-${user.role}`}
                            title="Change role"
                          >
                            {Object.entries(ROLES).map(([key, meta]) => (
                              <option key={key} value={key}>{meta.label}</option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="user-meta">{user.addedBy || <span className="user-empty-cell">—</span>}</td>
                      <td className="user-meta">
                        {user.addedAt ? new Date(user.addedAt).toLocaleString() : <span className="user-empty-cell">—</span>}
                      </td>
                      <td className="user-actions">
                        {user.isSuper ? null : isEditing ? (
                          <>
                            <button type="button" className="secondary-button" onClick={saveEditUser} disabled={adminBusy}>Save</button>
                            <button type="button" className="secondary-button" onClick={cancelEditUser} disabled={adminBusy}>Cancel</button>
                          </>
                        ) : (
                          <>
                            <button type="button" className="secondary-button" onClick={() => startEditUser(user)} disabled={adminBusy}>Edit</button>
                            <button type="button" className="danger-button" onClick={() => deleteUser(user.email)} disabled={adminBusy}>Delete</button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {adminError ? (
          <span className="cloud-status-error" title={adminError}>{adminError}</span>
        ) : null}
      </section>
      ) : null}

      {isAdmin ? (
      <section className="panel stats-panel">
        <div className="panel-header">
          <div>
            <p className="panel-kicker">Statistics</p>
            <h2>Live view of users, blueprint, and runbook</h2>
            <p className="panel-note">
              Updates in real time from the cloud. Useful for spotting bottlenecks and tracking progress at a glance.
            </p>
          </div>
        </div>

        <div className="stats-grid">
          {/* User stats */}
          <article className="stats-card stats-card-users">
            <h3>Users</h3>
            <div className="stats-big-number">{adminStats.totalUsers}</div>
            <div className="stats-sub">total registered</div>
            <div className="stats-breakdown">
              <div className="stats-line">
                <span className={`stats-dot role-admin`} />
                <span>Admins</span>
                <strong>{adminStats.roleCounts.admin}</strong>
              </div>
              <div className="stats-line">
                <span className={`stats-dot role-editor`} />
                <span>Editors</span>
                <strong>{adminStats.roleCounts.editor}</strong>
              </div>
              <div className="stats-line">
                <span className={`stats-dot role-viewer`} />
                <span>Viewers</span>
                <strong>{adminStats.roleCounts.viewer}</strong>
              </div>
            </div>
          </article>

          {/* Blueprint stats */}
          <article className="stats-card stats-card-blueprint">
            <h3>Blueprint map</h3>
            <div className="stats-big-number">{adminStats.blueprint.totalParts}</div>
            <div className="stats-sub">parts in the atlas</div>
            <div className="stats-breakdown">
              <div className="stats-line"><span>Source roots</span><strong>{adminStats.blueprint.rootCount}</strong></div>
              <div className="stats-line"><span>Source links</span><strong>{adminStats.blueprint.sourceLinkCount}</strong></div>
              <div className="stats-line"><span>Dependency links</span><strong>{adminStats.blueprint.dependencyLinkCount}</strong></div>
              <div className="stats-line"><span>Owners</span><strong>{adminStats.blueprint.ownerCount}</strong></div>
              <div className="stats-line"><span>Residences</span><strong>{adminStats.blueprint.residenceCount}</strong></div>
            </div>
          </article>

          {/* Runbook stats */}
          <article className="stats-card stats-card-runbook">
            <h3>Runbook progress</h3>
            <div className="stats-big-number">{adminStats.runbook.donePct}%</div>
            <div className="stats-sub">complete ({adminStats.runbook.done}/{adminStats.runbook.totalSteps})</div>
            <div className="stats-progress-bar" role="progressbar" aria-valuenow={adminStats.runbook.donePct} aria-valuemin={0} aria-valuemax={100}>
              <div className="stats-progress-fill" style={{ width: `${adminStats.runbook.donePct}%` }} />
            </div>
            <div className="stats-breakdown">
              <div className="stats-line"><span className="stats-dot stats-dot-done" /><span>Done</span><strong>{adminStats.runbook.done}</strong></div>
              <div className="stats-line"><span className="stats-dot stats-dot-wip" /><span>In progress</span><strong>{adminStats.runbook.inProgress}</strong></div>
              <div className="stats-line"><span className="stats-dot stats-dot-skipped" /><span>Skipped</span><strong>{adminStats.runbook.skipped}</strong></div>
              <div className="stats-line stats-line-warn"><span className="stats-dot stats-dot-overdue" /><span>Overdue</span><strong>{adminStats.runbook.overdue}</strong></div>
              <div className="stats-line"><span>Assigned</span><strong>{adminStats.runbook.withAssignee}</strong></div>
            </div>
          </article>

          {/* Top assignees */}
          <article className="stats-card stats-card-assignees">
            <h3>Top assignees</h3>
            {adminStats.topAssignees.length === 0 ? (
              <p className="stats-empty">No assignees yet. Assign people to runbook steps to see the leaderboard.</p>
            ) : (
              <ol className="stats-assignee-list">
                {adminStats.topAssignees.map(([name, count], idx) => (
                  <li key={name}>
                    <span className="stats-rank">{idx + 1}.</span>
                    <span className="stats-assignee-name">{name}</span>
                    <span className="stats-assignee-count">{count} {count === 1 ? 'step' : 'steps'}</span>
                  </li>
                ))}
              </ol>
            )}
          </article>
        </div>
      </section>
      ) : null}

      {showUserGuide ? (
        <div
          className="user-guide-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="user-guide-title"
          onClick={() => setShowUserGuide(false)}
        >
          <div
            className="user-guide-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="user-guide-header">
              <div>
                <p className="panel-kicker">Help</p>
                <h2 id="user-guide-title">Kundeplan user guide</h2>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setShowUserGuide(false)}
                aria-label="Close the user guide"
              >
                Close
              </button>
            </header>

            <div className="user-guide-body">
              <nav className="user-guide-toc" aria-label="Contents">
                <p className="user-guide-toc-title">Contents</p>
                <ol className="user-guide-toc-list">
                  {[
                    { id: 'guide-overview', label: 'What this app does' },
                    { id: 'guide-roles', label: 'Roles & permissions' },
                    { id: 'guide-hero', label: 'Top bar (hero) actions' },
                    { id: 'guide-nav', label: 'Page navigation' },
                    { id: 'guide-blueprint', label: 'Blueprint map (the graph)' },
                    { id: 'guide-inspector', label: 'Inspector (right panel)' },
                    { id: 'guide-runbook', label: 'Runbook page' },
                    { id: 'guide-templates', label: 'Templates (shared repository)' },
                    { id: 'guide-catalog', label: 'Catalog (parts grouped by residence)' },
                    { id: 'guide-summary', label: 'Plan summary' },
                    { id: 'guide-cloud', label: 'Cloud sync (Firebase)' },
                    { id: 'guide-users', label: 'Users & roles (admin only)' },
                    { id: 'guide-stats', label: 'Statistics (admin only)' },
                    { id: 'guide-versions', label: 'Versions' },
                    { id: 'guide-tips', label: 'Tips' },
                    { id: 'guide-keyboard', label: 'Keyboard & accessibility' },
                  ].map((item) => (
                    <li key={item.id}>
                      <a
                        href={`#${item.id}`}
                        onClick={(event) => {
                          event.preventDefault();
                          const target = document.getElementById(item.id);
                          if (target && typeof target.scrollIntoView === 'function') {
                            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                          }
                        }}
                      >
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ol>
              </nav>

              <section id="guide-overview">
                <h3>1. What this app does</h3>
                <p>
                  Kundeplan maps the parts of a customer plan — who owns each part, where it
                  lives, where it is presented, and how the parts depend on each other. The map
                  keeps a single source of truth so updates propagate cleanly between derived
                  parts and their sources.
                </p>
                <p>
                  The app has three working pages plus an admin area:
                  <strong> Blueprint map</strong> (the graph),
                  <strong> Runbook</strong> (execution checklist generated from the blueprint),
                  and <strong>Templates</strong> (a shared repository of saved blueprint + runbook snapshots).
                  Admins also see <strong>Users &amp; roles</strong> and a live <strong>Statistics</strong> panel.
                </p>
              </section>

              <section id="guide-roles">
                <h3>2. Roles &amp; permissions</h3>
                <p>Every signed-in user has exactly one role:</p>
                <ul>
                  <li><strong>Admin</strong> — full access. Edit the blueprint, edit the runbook, manage users, create/apply/delete templates, run cloud sync actions.</li>
                  <li><strong>Editor</strong> — read-only on the blueprint, but may edit the runbook (status, notes, assignee, due date). Can browse and export templates; cannot create, apply, or delete them.</li>
                  <li><strong>Viewer</strong> — read-only everywhere. Can browse the blueprint, runbook, and the template repository, and can export templates as JSON / CSV / PDF.</li>
                </ul>
                <p>
                  The super-admin (<code>ernst.magne.carlsen@atea.no</code>) is always treated as an
                  admin and cannot be demoted or deleted. Only <code>@atea.no</code> accounts with a
                  verified email can sign in.
                </p>
              </section>

              <section id="guide-hero">
                <h3>3. Top bar (hero) actions</h3>
                <ul>
                  <li><strong>User guide</strong> — opens this document.</li>
                  <li><strong>Save version</strong> — stores a labelled snapshot of the current plan you can restore later.</li>
                  <li><strong>Version badge (v…)</strong> — shows how many versions you have saved.</li>
                  <li><strong>Sign in / Sign out</strong> — when SSO is enabled, the signed-in user appears here along with their role badge.</li>
                </ul>
              </section>

              <section id="guide-nav">
                <h3>4. Page navigation</h3>
                <p>Three tabs sit directly below the header:</p>
                <ul>
                  <li><strong>Blueprint map</strong> — interactive graph editor (see section 5).</li>
                  <li><strong>Runbook</strong> — execution checklist derived from the blueprint (see section 7).</li>
                  <li><strong>Templates</strong> — shared template repository (see section 8).</li>
                </ul>
              </section>

              <section id="guide-blueprint">
                <h3>5. Blueprint map (the graph)</h3>
                <p>The Blueprint map shows every part as a card and every relation as a line. Admin-only for edits; viewers and editors see it read-only.</p>
                <h4>Toolbar</h4>
                <ul>
                  <li><strong>New part</strong> — creates a blank draft and opens it in the Inspector. The new part is placed at the bottom of the canvas, left-aligned. The canvas auto-scrolls to the new spot and the <em>Part name</em> field is focused with a <em>"Start here :-)"</em> bubble.</li>
                  <li><strong>Undo / Redo</strong> — step through your recent changes.</li>
                  <li><strong>Connection mode</strong> — global default for new links (<em>Dependency</em> or <em>Source</em>). Per-node popouts override this per click.</li>
                  <li><strong>Cancel link</strong> — appears while you are drawing a link; click to abort.</li>
                  <li><strong>Instruction pill</strong> — shows the next step for the current connection mode.</li>
                  <li><strong>Edge legend</strong> — colour key for Source vs Dependency lines.</li>
                  <li><strong>Export quality</strong> — Normal (fast) or High (sharper PNG/PDF capture).</li>
                  <li><strong>Export PNG / Export PDF</strong> — saves the Blueprint map as an image or PDF. The Catalog panel has its own separate PNG/PDF export.</li>
                </ul>
                <h4>Working with nodes</h4>
                <ul>
                  <li><strong>Click a node</strong> — selects it and loads it in the Inspector.</li>
                  <li><strong>Drag a node</strong> — re-positions it on the canvas; positions are saved automatically.</li>
                  <li><strong>Link handle (↘) — Connections popout</strong> — top-right of each node. Hover (or click) the icon to open a popout with two pill buttons:
                    <ul>
                      <li><strong>Connect SOURCE</strong> — sets connection mode to <em>source</em> and starts a link from this part. Click another node to complete the source link.</li>
                      <li><strong>Connect DEPENDENCY</strong> — sets connection mode to <em>dependency</em> and starts a link from this part. Click another node to complete the dependency.</li>
                    </ul>
                    The popout closes when you click an option, click the small <strong>×</strong>, press <kbd>Esc</kbd>, click outside, or move your mouse away.
                  </li>
                  <li><strong>Edit handle (✎) — Part actions popout</strong> — just below the link handle. Hover or click to open a second popout with three pill buttons:
                    <ul>
                      <li><strong>EDIT in inspector</strong> — opens this part in the Inspector and smooth-scrolls the page down to it. The <strong>Part name</strong> field is auto-focused and pulses with a <em>"Start here :-)"</em> bubble.</li>
                      <li><strong>NEW part from here</strong> — opens a blank draft with this part pre-set as its source. The new part is placed at the bottom of the canvas, the canvas auto-scrolls to it, and the Inspector is focused with the <em>Start here</em> hint.</li>
                      <li><strong>DELETE part</strong> — asks for confirmation, then removes the part; descendants are re-attached to its source where possible.</li>
                    </ul>
                  </li>
                </ul>
                <h4>Visual feedback</h4>
                <ul>
                  <li><strong>"Start here :-)" bubble</strong> — appears above the <em>Part name</em> field whenever the Inspector is opened from a New/Edit action.</li>
                  <li><strong>"Saved ✓" bubble</strong> — after pressing <strong>Save part</strong>, the canvas scrolls to centre the saved node and a green pulse + <em>Saved ✓</em> bubble appears above it for a couple of seconds.</li>
                  <li><strong>Auto-scroll</strong> — actions that open the Inspector smooth-scroll the page down to it; saving a part smooth-scrolls back up to the saved node.</li>
                </ul>
                <h4>Reading the lines</h4>
                <ul>
                  <li><strong>Source link</strong> — this part inherits its values from its source. Changes to the source flow downstream.</li>
                  <li><strong>Dependency</strong> — this part depends on another part but does not inherit from it.</li>
                </ul>
              </section>

              <section id="guide-inspector">
                <h3>6. Inspector (right panel)</h3>
                <p>Use the Inspector to edit the selected part. Fields are:</p>
                <ul>
                  <li><strong>Name</strong> — required.</li>
                  <li><strong>Owner</strong>, <strong>Resides in</strong>, <strong>Presented in</strong>, <strong>Notes</strong> — leave blank to inherit from the source.</li>
                  <li><strong>Source</strong> — pick the part this one is derived from, or leave empty to mark it a root.</li>
                  <li><strong>Dependencies</strong> — add or remove links to other parts. You can label each dependency.</li>
                  <li><strong>Anchors</strong> — choose which side of each box the link enters and leaves.</li>
                </ul>
                <p>Buttons (directly under the Notes field):</p>
                <ul>
                  <li><strong>Save part</strong> — writes your edits to the plan, smooth-scrolls back to the Blueprint map, centres the saved node in view and flashes the <em>Saved ✓</em> bubble.</li>
                  <li><strong>Delete part</strong> — removes the current part; descendants are re-attached to its source where possible.</li>
                  <li><strong>Clear source</strong> — detaches this part from its current source without deleting it.</li>
                </ul>
                <p>The lower detail view summarises the part's resolved values, source chain, and dependencies for quick reference.</p>
              </section>

              <section id="guide-runbook">
                <h3>7. Runbook page</h3>
                <p>
                  The Runbook is generated automatically from the blueprint. Every part becomes
                  one step, ordered by a topological sort that respects both source links and
                  dependencies (a part's prerequisites are always listed before it).
                </p>
                <h4>Search &amp; filters</h4>
                <ul>
                  <li><strong>Search</strong> — free-text box matching the part name, owner, residence, assignee, due date, or any note.</li>
                  <li><strong>Status</strong> / <strong>Owner</strong> / <strong>Assignee</strong> / <strong>Residence</strong> dropdowns narrow the list further.</li>
                  <li>The pill above the list shows how many of the total steps are currently visible.</li>
                </ul>
                <h4>Per-step fields (editable by admins and editors)</h4>
                <ul>
                  <li><strong>Status</strong> — Not started · In progress · Done · Skipped. Status changes feed the statistics panel and progress badges.</li>
                  <li><strong>Assignee</strong> — free-text name or email of the person responsible.</li>
                  <li><strong>Due date</strong> — picks a date; overdue rows (past due + not done/skipped) are flagged.</li>
                  <li><strong>Notes</strong> — free-text notes for this step.</li>
                </ul>
                <h4>Indicators</h4>
                <ul>
                  <li><strong>Blocked</strong> — shown when one of this step's prerequisites is not yet Done or Skipped.</li>
                  <li><strong>Overdue</strong> — shown when the due date is in the past and the step is not Done/Skipped.</li>
                  <li><strong>Cloud status badge</strong> — confirms the runbook is synced to Firebase across all users.</li>
                </ul>
                <h4>Toolbar</h4>
                <ul>
                  <li><strong>Reset</strong> — admins only; clears the per-step state.</li>
                  <li><strong>Export CSV</strong> — downloads the entire runbook (one row per step) for spreadsheet use.</li>
                  <li><strong>Export PDF</strong> — generates a printable A4 runbook with all fields.</li>
                </ul>
                <p>
                  All edits sync to Firebase in real time — everyone with access sees the same
                  state. Viewers see the runbook in read-only mode.
                </p>
              </section>

              <section id="guide-templates">
                <h3>8. Templates (shared repository)</h3>
                <p>
                  The Templates page is a shared repository of named snapshots that bundle the
                  entire blueprint (parts, sources, dependencies, positions) <em>plus</em> the
                  runbook configuration (status, assignee, due date, notes per step). Use them
                  to preserve known-good states or to reuse a plan across engagements.
                </p>
                <h4>What admins can do</h4>
                <ul>
                  <li><strong>Save current state as template</strong> — enter a name (required) and an optional description; the current blueprint + runbook are saved to the shared repository.</li>
                  <li><strong>Import from JSON…</strong> — load a previously exported template file into the repository.</li>
                  <li><strong>Apply</strong> — replaces the live blueprint and runbook for <em>everyone</em> with the template's contents. A confirmation prompt is shown first.</li>
                  <li><strong>Rename</strong> — change a template's name or description inline.</li>
                  <li><strong>Delete</strong> — permanently removes a template (with confirmation).</li>
                </ul>
                <h4>What everyone (viewer, editor, admin) can do</h4>
                <ul>
                  <li><strong>Browse</strong> — every template shows its name, description, parts count, runbook step count, creator, and timestamp.</li>
                  <li><strong>Preview</strong> — opens a modal listing all parts and configured runbook steps in the template.</li>
                  <li><strong>Export JSON</strong> — machine-readable full snapshot (re-importable by an admin).</li>
                  <li><strong>Export CSV</strong> — flat tabular export of parts and runbook config.</li>
                  <li><strong>Export PDF</strong> — printable A4 document.</li>
                </ul>
                <p>
                  Applying a template is a destructive action — it overwrites the current
                  blueprint and runbook for all users. Save a version (or a template) of the
                  current state first if you want to keep it.
                </p>
              </section>

              <section id="guide-catalog">
                <h3>9. Catalog (parts grouped by residence)</h3>
                <p>
                  A compact, scannable list of every part, grouped by where it resides. Click any
                  entry to load it in the Inspector. A <strong>Search</strong> box in the catalog
                  header filters by part name, owner, residence, presentation point, notes, source
                  name, or dependency names &mdash; matching groups stay visible, empty ones are
                  hidden. The catalog also has its own <strong>Export quality</strong> selector plus
                  dedicated <strong>Export PNG</strong> / <strong>Export PDF</strong> buttons that
                  capture only the catalog view (independent from the Blueprint map exports).
                </p>
              </section>

              <section id="guide-summary">
                <h3>10. Plan summary</h3>
                <p>The stats row beneath the catalog shows the totals (parts, sources, dependencies, etc.) for the current plan.</p>
              </section>

              <section id="guide-cloud">
                <h3>11. Cloud sync (Firebase)</h3>
                <p>
                  Available to admins only. The blueprint, runbook, users, and templates all sync
                  to Firebase automatically — every signed-in user reads from the same shared
                  documents. The manual sync actions below are escape hatches:
                </p>
                <ul>
                  <li><strong>Migrate local to cloud</strong> — uploads this browser's data, overwriting the cloud snapshot.</li>
                  <li><strong>Restore cloud to local</strong> — downloads the latest cloud snapshot and replaces your local data.</li>
                  <li><strong>Recover latest local backup</strong> — uploads your most recent saved version to the cloud.</li>
                  <li><strong>Cloud user pill</strong> — shows the account in use, or "Firebase not configured".</li>
                  <li><strong>Status badge</strong> — confirms the result of the last action.</li>
                </ul>
              </section>

              <section id="guide-users">
                <h3>12. Users &amp; roles (admin only)</h3>
                <p>
                  The Users panel lists everyone in the registry along with their role. Admins can:
                </p>
                <ul>
                  <li><strong>Add user</strong> — enter email + display name and pick a role (admin / editor / viewer).</li>
                  <li><strong>Edit</strong> — change a user's role or display name inline.</li>
                  <li><strong>Delete</strong> — remove a user from the registry.</li>
                </ul>
                <p>
                  The super-admin row is shown but locked — it cannot be edited or deleted. Saving
                  changes automatically updates the legacy admin/editor email lists used by the
                  Firestore security rules, so permissions take effect immediately.
                </p>
              </section>

              <section id="guide-stats">
                <h3>13. Statistics (admin only)</h3>
                <p>The Statistics panel shows four live cards driven by the cloud data:</p>
                <ul>
                  <li><strong>Users</strong> — total user count plus breakdown by role.</li>
                  <li><strong>Blueprint</strong> — totals for parts, root parts, source links, dependencies, owners, and residences.</li>
                  <li><strong>Runbook progress</strong> — progress bar of % done plus counts for Done / In progress / Skipped / Overdue.</li>
                  <li><strong>Top assignees</strong> — top five people by number of runbook steps assigned to them.</li>
                </ul>
              </section>

              <section id="guide-versions">
                <h3>14. Versions</h3>
                <ul>
                  <li>Use <strong>Save version</strong> in the hero to snapshot the current plan locally.</li>
                  <li>The version counter increments with each save (e.g. v3).</li>
                  <li>"Recover latest local backup" in Cloud sync uploads your most recent saved version to the cloud.</li>
                  <li>For shareable snapshots across users, save a <strong>template</strong> instead (section 8) — versions are local, templates are cloud-wide.</li>
                </ul>
              </section>

              <section id="guide-tips">
                <h3>15. Tips</h3>
                <ul>
                  <li>Drag nodes to organise the map; layout positions are persisted.</li>
                  <li>Use Source links sparingly — they create inheritance, so changes flow downstream.</li>
                  <li>Use Dependency links to express "needs" relationships without inheritance.</li>
                  <li>Export at High quality before sharing for printing or large screens.</li>
                  <li>Save a template before sweeping changes so you can roll back for everyone with one click.</li>
                  <li>Use the runbook to track execution; use the blueprint to track structure.</li>
                </ul>
              </section>

              <section id="guide-keyboard">
                <h3>16. Keyboard &amp; accessibility</h3>
                <ul>
                  <li>Both per-node popouts (Connections ↘ and Part actions ✎) respond to keyboard focus. Use <kbd>Tab</kbd> to focus the icon, then <kbd>Enter</kbd> or <kbd>Space</kbd> on each menu item.</li>
                  <li>Press <kbd>Esc</kbd> to close any open popout, the user guide, or the template preview.</li>
                  <li>Click outside a popout, modal, or overlay to close it.</li>
                </ul>
              </section>
            </div>
          </div>
        </div>
      ) : null}

      {structureSummary ? (
        <div
          className="user-guide-overlay structure-summary-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="structure-summary-title"
          onClick={() => setStructureSummary(null)}
        >
          <div
            className="user-guide-modal structure-summary-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="user-guide-header">
              <div>
                <p className="panel-kicker">Flow canvas</p>
                <h2 id="structure-summary-title">Structure summary</h2>
                <p className="structure-summary-meta">
                  Generated {structureSummary.generatedAt.toLocaleString()}
                </p>
              </div>
              <div className="structure-summary-header-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={refreshStructureSummary}
                  title="Re-read the canvas and rebuild this summary"
                >
                  Refresh
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setStructureSummary(null)}
                  aria-label="Close the structure summary"
                >
                  Close
                </button>
              </div>
            </header>

            <div className="user-guide-body structure-summary-body">
              <section className="structure-summary-totals">
                <span className="pill"><strong>{structureSummary.totals.parts}</strong> parts</span>
                <span className="pill"><strong>{structureSummary.totals.sourceLinks}</strong> source links</span>
                <span className="pill"><strong>{structureSummary.totals.dependencies}</strong> dependencies</span>
                <span className="pill"><strong>{structureSummary.totals.roots}</strong> roots</span>
                <span className="pill"><strong>{structureSummary.totals.leaves}</strong> leaves</span>
                <span className="pill"><strong>{structureSummary.totals.orphans}</strong> orphans</span>
              </section>

              {structureSummary.entries.length === 0 ? (
                <p>No parts on the canvas yet.</p>
              ) : (
                <ul className="structure-summary-list">
                  {structureSummary.entries.map((entry) => (
                    <li key={entry.id} className="structure-summary-item">
                      <div className="structure-summary-item-header">
                        <h3>{entry.name}</h3>
                        <div className="structure-summary-tags">
                          {entry.isRoot ? <span className="pill">root</span> : null}
                          {entry.isLeaf ? <span className="pill">leaf</span> : null}
                          {entry.isOrphan ? <span className="pill">orphan</span> : null}
                        </div>
                      </div>
                      {entry.owner ? (
                        <p className="structure-summary-owner">Owner: {entry.owner}</p>
                      ) : null}

                      <dl className="structure-summary-dl">
                        <dt>Source path</dt>
                        <dd>
                          {entry.sourceChain.length > 0
                            ? `${entry.sourceChain.join(' → ')} → ${entry.name}`
                            : '— (root)'}
                        </dd>

                        <dt>Direct source</dt>
                        <dd>{entry.directSource ?? '—'}</dd>

                        <dt>Children (parts that inherit from this)</dt>
                        <dd>
                          {entry.children.length === 0
                            ? '—'
                            : entry.children.map((child) => child.name).join(', ')}
                        </dd>

                        <dt>Dependencies ({entry.dependencies.length})</dt>
                        <dd>
                          {entry.dependencies.length === 0 ? (
                            '—'
                          ) : (
                            <ul className="structure-summary-sublist">
                              {entry.dependencies.map((dep) => (
                                <li key={dep.id}>
                                  {dep.name}
                                  {dep.label ? <span className="structure-summary-label"> — {dep.label}</span> : null}
                                </li>
                              ))}
                            </ul>
                          )}
                        </dd>

                        <dt>Dependents ({entry.dependents.length})</dt>
                        <dd>
                          {entry.dependents.length === 0 ? (
                            '—'
                          ) : (
                            <ul className="structure-summary-sublist">
                              {entry.dependents.map((dep) => (
                                <li key={dep.id}>
                                  {dep.name}
                                  {dep.label ? <span className="structure-summary-label"> — {dep.label}</span> : null}
                                </li>
                              ))}
                            </ul>
                          )}
                        </dd>
                      </dl>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function TomAndJerryFlag() {
  return (
    <div className="tom-jerry" aria-hidden="true" title="Garfield chasing Odie with the ATEA AS flag">
      <svg viewBox="0 0 360 170" xmlns="http://www.w3.org/2000/svg">
        {/* Ground shadow */}
        <ellipse cx="180" cy="158" rx="150" ry="6" fill="rgba(36,48,70,0.12)" />

        {/* Motion / dust puffs trailing the chase */}
        <g stroke="#293042" strokeWidth="2" fill="#fffdf6" opacity="0.9">
          <circle cx="335" cy="140" r="6" />
          <circle cx="322" cy="150" r="4" />
          <circle cx="310" cy="144" r="3" />
        </g>
        <g stroke="#293042" strokeWidth="1.5" fill="none" opacity="0.6">
          <path d="M300 90 L320 88" />
          <path d="M300 100 L325 100" />
          <path d="M300 110 L322 112" />
        </g>

        {/* === ODIE (yellow dog, running left, fleeing) === */}
        <g>
          {/* Back legs (mid-stride, kicked back) */}
          <path d="M70 138 L92 150 L100 152" stroke="#293042" strokeWidth="3" fill="none" strokeLinecap="round" />
          <path d="M75 140 L96 156" stroke="#f6c945" strokeWidth="7" strokeLinecap="round" />
          <path d="M75 140 L96 156" stroke="#293042" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          {/* Body */}
          <ellipse cx="60" cy="120" rx="42" ry="22" fill="#f6c945" stroke="#293042" strokeWidth="3" />
          {/* Belly */}
          <ellipse cx="60" cy="128" rx="26" ry="10" fill="#fff2b8" />
          {/* Front legs (stretched forward) */}
          <path d="M28 130 L10 150" stroke="#f6c945" strokeWidth="7" strokeLinecap="round" />
          <path d="M28 130 L10 150" stroke="#293042" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M36 134 L22 154" stroke="#f6c945" strokeWidth="7" strokeLinecap="round" />
          <path d="M36 134 L22 154" stroke="#293042" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          {/* Tail (whipping back) */}
          <path d="M100 118 Q118 108 124 118" stroke="#f6c945" strokeWidth="6" fill="none" strokeLinecap="round" />
          <path d="M100 118 Q118 108 124 118" stroke="#293042" strokeWidth="2" fill="none" strokeLinecap="round" />
          {/* Head (facing left) */}
          <ellipse cx="22" cy="108" rx="20" ry="17" fill="#f6c945" stroke="#293042" strokeWidth="3" />
          {/* Snout */}
          <ellipse cx="8" cy="116" rx="10" ry="7" fill="#fff2b8" stroke="#293042" strokeWidth="2.5" />
          {/* Nose */}
          <ellipse cx="2" cy="114" rx="3" ry="2.5" fill="#293042" />
          {/* Tongue */}
          <path d="M2 119 Q-6 124 -10 120 Q-6 122 -2 122 Z" fill="#ff7da8" stroke="#293042" strokeWidth="1.5" />
          {/* Eye (wide, scared) */}
          <circle cx="20" cy="104" r="5" fill="#fffdf6" stroke="#293042" strokeWidth="2" />
          <circle cx="22" cy="105" r="2.5" fill="#293042" />
          {/* Floppy ear flying back */}
          <path d="M30 96 Q50 78 60 92 Q52 102 38 102 Z" fill="#d49a1b" stroke="#293042" strokeWidth="2.5" />
          {/* Tuft of hair */}
          <path d="M20 92 L18 80 M24 91 L26 80 M16 93 L12 82" stroke="#293042" strokeWidth="2" strokeLinecap="round" />
        </g>

        {/* === GREEN ATEA AS FLAG (held by Garfield, waving back) === */}
        {/* Pole */}
        <line x1="270" y1="40" x2="248" y2="120" stroke="#293042" strokeWidth="4" strokeLinecap="round" />
        <circle cx="271" cy="38" r="5" fill="#ffd84f" stroke="#293042" strokeWidth="2" />
        {/* Flag cloth (waving) */}
        <path d="M268 46 Q310 38 348 52 Q336 70 348 92 Q310 84 260 96 Z" fill="#2faa4a" stroke="#293042" strokeWidth="3" />
        {/* ATEA AS text */}
        <text x="305" y="68" textAnchor="middle" fontFamily="Trebuchet MS, Segoe UI, sans-serif" fontSize="16" fontWeight="900" fill="#ffffff">ATEA</text>
        <text x="305" y="84" textAnchor="middle" fontFamily="Trebuchet MS, Segoe UI, sans-serif" fontSize="12" fontWeight="900" fill="#ffffff">AS</text>

        {/* === GARFIELD (orange tabby, chasing from the right) === */}
        <g>
          {/* Back legs (mid-stride) */}
          <path d="M260 140 L278 156" stroke="#ff9a3c" strokeWidth="8" strokeLinecap="round" />
          <path d="M260 140 L278 156" stroke="#293042" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M250 142 L240 158" stroke="#ff9a3c" strokeWidth="8" strokeLinecap="round" />
          <path d="M250 142 L240 158" stroke="#293042" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          {/* Body */}
          <ellipse cx="240" cy="125" rx="40" ry="24" fill="#ff9a3c" stroke="#293042" strokeWidth="3" />
          {/* Belly */}
          <ellipse cx="240" cy="133" rx="24" ry="11" fill="#ffd9a8" />
          {/* Tiger stripes */}
          <path d="M218 112 Q222 118 218 124" stroke="#7a3b00" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M232 108 Q236 116 232 124" stroke="#7a3b00" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M248 108 Q252 116 248 124" stroke="#7a3b00" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          {/* Front leg (reaching forward toward Odie, also holding flag pole) */}
          <path d="M205 130 Q190 124 175 130" stroke="#ff9a3c" strokeWidth="8" fill="none" strokeLinecap="round" />
          <path d="M205 130 Q190 124 175 130" stroke="#293042" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <circle cx="173" cy="131" r="6" fill="#ff9a3c" stroke="#293042" strokeWidth="2" />
          {/* Other arm holding flag pole */}
          <path d="M225 110 Q235 90 250 95" stroke="#ff9a3c" strokeWidth="8" fill="none" strokeLinecap="round" />
          <path d="M225 110 Q235 90 250 95" stroke="#293042" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          {/* Tail (curled up behind) */}
          <path d="M278 122 Q300 100 290 80" stroke="#ff9a3c" strokeWidth="7" fill="none" strokeLinecap="round" />
          <path d="M278 122 Q300 100 290 80" stroke="#293042" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M284 95 Q288 90 290 88" stroke="#7a3b00" strokeWidth="2" fill="none" strokeLinecap="round" />
          {/* Head (facing left, mouth open) */}
          <ellipse cx="200" cy="108" rx="26" ry="22" fill="#ff9a3c" stroke="#293042" strokeWidth="3" />
          {/* Cheeks */}
          <ellipse cx="186" cy="116" rx="8" ry="6" fill="#ffd9a8" />
          <ellipse cx="200" cy="116" rx="6" ry="5" fill="#ffd9a8" />
          {/* Forehead stripes */}
          <path d="M196 92 Q200 88 204 92" stroke="#7a3b00" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M188 94 Q192 88 196 92" stroke="#7a3b00" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M204 92 Q208 88 212 94" stroke="#7a3b00" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          {/* Ears (pointy, laid back slightly) */}
          <polygon points="182,90 178,72 192,84" fill="#ff9a3c" stroke="#293042" strokeWidth="2.5" />
          <polygon points="218,90 222,72 208,84" fill="#ff9a3c" stroke="#293042" strokeWidth="2.5" />
          <polygon points="184,86 182,76 190,84" fill="#ff7da8" />
          <polygon points="216,86 218,76 210,84" fill="#ff7da8" />
          {/* Eyes (half-lidded, determined) */}
          <ellipse cx="188" cy="104" rx="6" ry="7" fill="#fffdf6" stroke="#293042" strokeWidth="2" />
          <ellipse cx="202" cy="104" rx="6" ry="7" fill="#fffdf6" stroke="#293042" strokeWidth="2" />
          <circle cx="186" cy="106" r="2.5" fill="#293042" />
          <circle cx="200" cy="106" r="2.5" fill="#293042" />
          {/* Heavy lids */}
          <path d="M182 100 Q188 98 194 100" stroke="#293042" strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M196 100 Q202 98 208 100" stroke="#293042" strokeWidth="2" fill="none" strokeLinecap="round" />
          {/* Nose & open mouth */}
          <path d="M180 116 Q176 118 178 122 Q182 124 184 120" fill="#293042" />
          <path d="M180 122 Q174 130 178 134 Q184 132 184 126" fill="#7a1a1a" stroke="#293042" strokeWidth="1.5" />
          {/* Whiskers */}
          <path d="M180 120 L168 118 M180 124 L168 126 M210 118 L222 116 M210 122 L222 124" stroke="#293042" strokeWidth="1.2" />
        </g>
      </svg>
    </div>
  );
}

export default App;