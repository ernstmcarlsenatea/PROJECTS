import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getFirestore,
  initializeFirestore,
  limit as firestoreLimit,
  onSnapshot,
  orderBy,
  persistentLocalCache,
  persistentMultipleTabManager,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { FEATURE_FLAGS } from './featureFlags.js';

// Bootstrap super-admin. This email always has admin rights even if no
// admins document exists yet, so it can grant admin status to other users.
export const SUPER_ADMIN_EMAIL = 'ernst.magne.carlsen@atea.no';
const ADMINS_DOC_PATH = ['kundeplanAdmins', 'list'];
const EDITORS_DOC_PATH = ['kundeplanEditors', 'list'];
const USERS_DOC_PATH = ['kundeplanUsers', 'list'];
const TEMPLATES_DOC_PATH = ['kundeplanTemplates', 'list'];
const AUDIT_COLLECTION = 'kundeplanAudit';
const AUDIT_SCHEMA_VERSION = 1;
const PLANS_DOC_PATH = ['kundeplanPlans', 'registry'];
const PLANS_SCHEMA_VERSION = 1;
const COMMENTS_COLLECTION = 'kundeplanComments';
const COMMENTS_SCHEMA_VERSION = 1;
const VERSIONS_COLLECTION = 'kundeplanVersions';
const VERSIONS_SCHEMA_VERSION = 1;
const VERSIONS_LIST_LIMIT = 50;

// Phase 4: the "default" plan continues to read/write the existing
// kundeplanStates/shared and kundeplanRunbook/shared docs so no migration is
// needed for existing installations. Any other plan uses a doc id derived
// from its planId.
export const DEFAULT_PLAN_ID = 'default';

export function getPlanDocKey(planId) {
  if (!planId || planId === DEFAULT_PLAN_ID) return SHARED_DOC_KEY;
  return `plan_${sanitizeKey(String(planId))}`;
}

// Available roles. Order = display/sort order.
export const ROLES = {
  admin: {
    label: 'Admin',
    description: 'Full access — edit blueprint, runbook, and manage users.',
    sortOrder: 0,
  },
  editor: {
    label: 'Editor',
    description: 'Edit runbook status, notes, assignee, and due dates.',
    sortOrder: 1,
  },
  viewer: {
    label: 'Viewer',
    description: 'Read-only access — can browse but not modify anything.',
    sortOrder: 2,
  },
};

export function isValidRole(role) {
  return Object.prototype.hasOwnProperty.call(ROLES, role);
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isSuperAdmin(email) {
  return normalizeEmail(email) === SUPER_ADMIN_EMAIL;
}

// Resolve role for a given email. Super-admin always = admin. Otherwise look
// up in the supplied users array; default to 'viewer' for trusted but
// unregistered users.
export function getUserRole(email, users) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  if (normalized === SUPER_ADMIN_EMAIL) return 'admin';
  if (!Array.isArray(users)) return 'viewer';
  const entry = users.find((u) => normalizeEmail(u?.email) === normalized);
  return entry?.role && isValidRole(entry.role) ? entry.role : 'viewer';
}

export function computeIsAdmin(email, adminEmails) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return false;
  }
  if (normalized === SUPER_ADMIN_EMAIL) {
    return true;
  }
  if (!Array.isArray(adminEmails)) {
    return false;
  }
  return adminEmails.some((entry) => normalizeEmail(entry) === normalized);
}

export const firebaseConfig = {
  apiKey: (import.meta.env.VITE_FIREBASE_API_KEY ?? 'AIzaSyDorw7eeJtpJcqSr3crBIFiiq8OEqj56FA').trim(),
  authDomain: (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? 'kundeplan.firebaseapp.com').trim(),
  projectId: (import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'kundeplan').trim(),
  appId: (import.meta.env.VITE_FIREBASE_APP_ID ?? '1:519939507728:web:5be17b1b2c391294742c95').trim(),
  storageBucket: (import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? 'kundeplan.firebasestorage.app').trim(),
  messagingSenderId: (import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '519939507728').trim(),
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

const REQUIRED_KEYS = ['apiKey', 'authDomain', 'projectId', 'appId'];

function isConfigured() {
  return REQUIRED_KEYS.every((key) => Boolean(firebaseConfig[key]));
}

// Phase 6: cache the Firestore instance so we only call initializeFirestore
// once (the SDK throws if called twice on the same app). When the offline
// flag is on we use a persistent IndexedDB cache with multi-tab support;
// otherwise we use the default memory cache.
let _dbInstance = null;
function getDb() {
  if (!isConfigured()) {
    return null;
  }
  if (_dbInstance) return _dbInstance;
  if (FEATURE_FLAGS.offline) {
    try {
      _dbInstance = initializeFirestore(firebaseApp, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      });
    } catch (err) {
      // Already initialized elsewhere, or the browser blocked IndexedDB
      // (private mode, storage disabled). Fall back to the default instance.
      _dbInstance = getFirestore(firebaseApp);
    }
  } else {
    _dbInstance = getFirestore(firebaseApp);
  }
  return _dbInstance;
}

function sanitizeKey(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

// Shared document key: every signed-in user reads from and writes to the same
// Firestore document so that the latest content is always visible to everyone,
// including first-time users. The `auth` argument is intentionally ignored.
const SHARED_DOC_KEY = 'shared';

// eslint-disable-next-line no-unused-vars
function getUserKey(auth) {
  return SHARED_DOC_KEY;
}

function isMissingDefaultDatabaseError(error) {
  const message = String(error?.message ?? '');
  return error?.code === 'not-found' || message.includes("Database '(default)' not found");
}

export function createCloudStore(auth, options = {}) {
  const db = getDb();
  const planId = options?.planId ?? DEFAULT_PLAN_ID;
  // For the default plan we keep using the legacy shared key so existing
  // installations don't migrate. Non-default plans use a derived id.
  const userKey = getPlanDocKey(planId);

  if (!db) {
    return {
      enabled: false,
      userKey,
      planId,
      reason: 'missing_config',
      async loadSnapshot() {
        return null;
      },
      async saveSnapshot() {
        return null;
      },
      subscribeSnapshot() {
        return () => {};
      },
    };
  }

  const stateRef = doc(db, 'kundeplanStates', userKey);
  let cloudAvailable = true;

  return {
    enabled: true,
    userKey,
    planId,
    reason: null,
    async loadSnapshot() {
      if (!cloudAvailable) {
        return null;
      }

      try {
        const snapshot = await getDoc(stateRef);
        if (!snapshot.exists()) {
          return null;
        }
        return snapshot.data();
      } catch (error) {
        if (isMissingDefaultDatabaseError(error)) {
          cloudAvailable = false;
          return null;
        }

        throw error;
      }
    },
    subscribeSnapshot(onChange, onError) {
      if (!cloudAvailable) {
        return () => {};
      }

      return onSnapshot(
        stateRef,
        { includeMetadataChanges: false },
        (snapshot) => {
          if (!snapshot.exists()) {
            onChange(null, { fromCache: snapshot.metadata.fromCache, hasPendingWrites: snapshot.metadata.hasPendingWrites });
            return;
          }
          onChange(snapshot.data(), {
            fromCache: snapshot.metadata.fromCache,
            hasPendingWrites: snapshot.metadata.hasPendingWrites,
          });
        },
        (error) => {
          if (isMissingDefaultDatabaseError(error)) {
            cloudAvailable = false;
            return;
          }
          if (typeof onError === 'function') {
            onError(error);
          } else {
            console.error('Cloud snapshot subscription failed:', error);
          }
        },
      );
    },
    async saveSnapshot(payload) {
      if (!cloudAvailable) {
        return;
      }

      try {
        await setDoc(
          stateRef,
          {
            ...payload,
            userKey,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
      } catch (error) {
        if (isMissingDefaultDatabaseError(error)) {
          cloudAvailable = false;
          return;
        }

        throw error;
      }
    },
  };
}

export function createAdminStore() {
  const db = getDb();
  if (!db) {
    return {
      enabled: false,
      async loadAdmins() {
        return [];
      },
      subscribeAdmins() {
        return () => {};
      },
      async saveAdmins() {
        throw new Error('Firebase is not configured.');
      },
    };
  }

  const adminsRef = doc(db, ADMINS_DOC_PATH[0], ADMINS_DOC_PATH[1]);

  function readEmails(data) {
    const raw = Array.isArray(data?.emails) ? data.emails : [];
    const cleaned = raw.map(normalizeEmail).filter(Boolean);
    return Array.from(new Set(cleaned));
  }

  return {
    enabled: true,
    async loadAdmins() {
      try {
        const snapshot = await getDoc(adminsRef);
        return snapshot.exists() ? readEmails(snapshot.data()) : [];
      } catch (error) {
        if (isMissingDefaultDatabaseError(error)) {
          return [];
        }
        throw error;
      }
    },
    subscribeAdmins(onChange, onError) {
      return onSnapshot(
        adminsRef,
        (snapshot) => {
          onChange(snapshot.exists() ? readEmails(snapshot.data()) : []);
        },
        (error) => {
          if (typeof onError === 'function') {
            onError(error);
          } else {
            console.error('Admin subscription failed:', error);
          }
        },
      );
    },
    async saveAdmins(emails) {
      const cleaned = Array.from(
        new Set((Array.isArray(emails) ? emails : []).map(normalizeEmail).filter(Boolean)),
      );
      await setDoc(
        adminsRef,
        {
          emails: cleaned,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      return cleaned;
    },
  };
}

// Shared runbook config store. Keeps per-step state (status, notes, assignee,
// due date) synced across all signed-in users. Trusted users read; admins write.
// Phase 4: an optional { planId } selects a per-plan doc id. The default plan
// keeps using the legacy 'shared' key so existing data is unchanged.
export function createRunbookStore(options = {}) {
  const db = getDb();
  const planId = options?.planId ?? DEFAULT_PLAN_ID;
  const docKey = getPlanDocKey(planId);

  if (!db) {
    return {
      enabled: false,
      planId,
      async loadConfig() {
        return null;
      },
      async saveConfig() {
        return null;
      },
      subscribeConfig() {
        return () => {};
      },
    };
  }

  const runbookRef = doc(db, 'kundeplanRunbook', docKey);
  let cloudAvailable = true;

  return {
    enabled: true,
    planId,
    async loadConfig() {
      if (!cloudAvailable) return null;
      try {
        const snapshot = await getDoc(runbookRef);
        return snapshot.exists() ? snapshot.data() : null;
      } catch (error) {
        if (isMissingDefaultDatabaseError(error)) {
          cloudAvailable = false;
          return null;
        }
        throw error;
      }
    },
    subscribeConfig(onChange, onError) {
      if (!cloudAvailable) return () => {};
      return onSnapshot(
        runbookRef,
        { includeMetadataChanges: true },
        (snapshot) => {
          const data = snapshot.exists() ? snapshot.data() : null;
          onChange(data, {
            fromCache: snapshot.metadata.fromCache,
            hasPendingWrites: snapshot.metadata.hasPendingWrites,
          });
        },
        (error) => {
          if (isMissingDefaultDatabaseError(error)) {
            cloudAvailable = false;
            return;
          }
          if (typeof onError === 'function') {
            onError(error);
          } else {
            console.error('Runbook subscription failed:', error);
          }
        },
      );
    },
    async saveConfig(config) {
      if (!cloudAvailable) return;
      try {
        await setDoc(
          runbookRef,
          {
            config: config ?? {},
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
      } catch (error) {
        if (isMissingDefaultDatabaseError(error)) {
          cloudAvailable = false;
          return;
        }
        throw error;
      }
    },
  };
}

// Read + normalize the users array from a raw Firestore doc.
function readUsersData(data) {
  const raw = Array.isArray(data?.users) ? data.users : [];
  const seen = new Set();
  const cleaned = [];
  for (const u of raw) {
    const email = normalizeEmail(u?.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    cleaned.push({
      email,
      role: isValidRole(u?.role) ? u.role : 'viewer',
      displayName: typeof u?.displayName === 'string' ? u.displayName.trim() : '',
      addedAt: u?.addedAt ?? null,
      addedBy: typeof u?.addedBy === 'string' ? u.addedBy : '',
    });
  }
  return cleaned;
}

// Full user management store. Reads from kundeplanUsers/list and synchronizes
// kundeplanAdmins/list and kundeplanEditors/list so the firestore.rules can
// continue using simple email-in-array checks for permission decisions.
export function createUserStore() {
  const db = getDb();

  if (!db) {
    return {
      enabled: false,
      async loadUsers() {
        return [];
      },
      subscribeUsers() {
        return () => {};
      },
      async saveUsers() {
        throw new Error('Firebase is not configured.');
      },
    };
  }

  const usersRef = doc(db, USERS_DOC_PATH[0], USERS_DOC_PATH[1]);
  const adminsRef = doc(db, ADMINS_DOC_PATH[0], ADMINS_DOC_PATH[1]);
  const editorsRef = doc(db, EDITORS_DOC_PATH[0], EDITORS_DOC_PATH[1]);

  return {
    enabled: true,
    async loadUsers() {
      try {
        const snap = await getDoc(usersRef);
        return snap.exists() ? readUsersData(snap.data()) : [];
      } catch (error) {
        if (isMissingDefaultDatabaseError(error)) return [];
        throw error;
      }
    },
    subscribeUsers(onChange, onError) {
      return onSnapshot(
        usersRef,
        (snap) => onChange(snap.exists() ? readUsersData(snap.data()) : []),
        (error) => {
          if (isMissingDefaultDatabaseError(error)) return;
          if (typeof onError === 'function') onError(error);
          else console.error('Users subscription failed:', error);
        },
      );
    },
    async saveUsers(users) {
      const cleaned = readUsersData({ users });
      await setDoc(
        usersRef,
        { users: cleaned, updatedAt: serverTimestamp() },
        { merge: true },
      );
      // Sync legacy lists used by firestore.rules.
      const adminEmails = cleaned.filter((u) => u.role === 'admin').map((u) => u.email);
      const editorEmails = cleaned.filter((u) => u.role === 'editor').map((u) => u.email);
      await setDoc(
        adminsRef,
        { emails: adminEmails, updatedAt: serverTimestamp() },
        { merge: true },
      );
      await setDoc(
        editorsRef,
        { emails: editorEmails, updatedAt: serverTimestamp() },
        { merge: true },
      );
      return cleaned;
    },
  };
}

// Read + normalize a templates array from a raw Firestore doc.
function readTemplatesData(data) {
  const raw = Array.isArray(data?.templates) ? data.templates : [];
  const seen = new Set();
  const cleaned = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const id = typeof t.id === 'string' && t.id ? t.id : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    cleaned.push({
      id,
      name: typeof t.name === 'string' ? t.name.trim() : '',
      description: typeof t.description === 'string' ? t.description.trim() : '',
      createdAt: t.createdAt ?? null,
      createdBy: typeof t.createdBy === 'string' ? t.createdBy : '',
      parts: Array.isArray(t.parts) ? t.parts : [],
      runbookConfig: t.runbookConfig && typeof t.runbookConfig === 'object' ? t.runbookConfig : {},
    });
  }
  return cleaned;
}

// Template repository store. Stores named snapshots of blueprint parts +
// runbook config so admins can save reusable templates. All trusted users
// may read templates (to view + export); only admins may write.
export function createTemplateStore() {
  const db = getDb();

  if (!db) {
    return {
      enabled: false,
      async loadTemplates() {
        return [];
      },
      subscribeTemplates() {
        return () => {};
      },
      async saveTemplates() {
        throw new Error('Firebase is not configured.');
      },
    };
  }

  const templatesRef = doc(db, TEMPLATES_DOC_PATH[0], TEMPLATES_DOC_PATH[1]);

  return {
    enabled: true,
    async loadTemplates() {
      try {
        const snap = await getDoc(templatesRef);
        return snap.exists() ? readTemplatesData(snap.data()) : [];
      } catch (error) {
        if (isMissingDefaultDatabaseError(error)) return [];
        throw error;
      }
    },
    subscribeTemplates(onChange, onError) {
      return onSnapshot(
        templatesRef,
        (snap) => onChange(snap.exists() ? readTemplatesData(snap.data()) : []),
        (error) => {
          if (isMissingDefaultDatabaseError(error)) return;
          if (typeof onError === 'function') onError(error);
          else console.error('Templates subscription failed:', error);
        },
      );
    },
    async saveTemplates(templates) {
      const cleaned = readTemplatesData({ templates });
      await setDoc(
        templatesRef,
        { templates: cleaned, updatedAt: serverTimestamp() },
        { merge: true },
      );
      return cleaned;
    },
  };
}

// Phase 3 audit log: append-only event store. Each event is a separate
// Firestore document in the `kundeplanAudit` collection. Editors (which
// includes admins) may create events; nobody may update or delete them.
// Trusted users may read so the Activity panel can render history.
export const AUDIT_EVENT_TYPES = Object.freeze({
  USER_ADD: 'user.add',
  USER_UPDATE: 'user.update',
  USER_REMOVE: 'user.remove',
  USER_ROLE: 'user.role',
  TEMPLATE_SAVE: 'template.save',
  TEMPLATE_UPDATE: 'template.update',
  TEMPLATE_DELETE: 'template.delete',
  TEMPLATE_IMPORT: 'template.import',
  TEMPLATE_APPLY: 'template.apply',
  RUNBOOK_STEP_STATUS: 'runbook.step.status',
  RUNBOOK_RESET: 'runbook.reset',
  VERSION_SAVE: 'version.save',
  VERSION_RESTORE: 'version.restore',
  VERSION_DELETE: 'version.delete',
});

function sanitizeAuditDetails(details) {
  if (!details || typeof details !== 'object') return null;
  // Strip undefined and non-serializable values; cap to a small object.
  try {
    const safe = JSON.parse(JSON.stringify(details));
    return safe && typeof safe === 'object' ? safe : null;
  } catch {
    return null;
  }
}

export function createAuditStore() {
  const db = getDb();

  if (!db) {
    return {
      enabled: false,
      async record() {
        return null;
      },
      subscribeRecent() {
        return () => {};
      },
    };
  }

  const auditCol = collection(db, AUDIT_COLLECTION);
  let cloudAvailable = true;

  return {
    enabled: true,
    schemaVersion: AUDIT_SCHEMA_VERSION,
    async record({ type, summary, actor, details }) {
      if (!cloudAvailable) return null;
      if (!type || typeof type !== 'string') return null;
      const actorEmail = normalizeEmail(actor?.email);
      if (!actorEmail) return null;
      try {
        const ref = await addDoc(auditCol, {
          schemaVersion: AUDIT_SCHEMA_VERSION,
          type,
          summary: typeof summary === 'string' ? summary.slice(0, 500) : '',
          actor: {
            email: actorEmail,
            displayName: typeof actor?.displayName === 'string' ? actor.displayName.slice(0, 200) : '',
          },
          details: sanitizeAuditDetails(details),
          createdAt: serverTimestamp(),
        });
        return ref.id;
      } catch (error) {
        if (isMissingDefaultDatabaseError(error)) {
          cloudAvailable = false;
          return null;
        }
        // Audit must never break a foreground operation — log and swallow.
        console.warn('Audit event write failed:', error);
        return null;
      }
    },
    subscribeRecent(maxEvents, onChange, onError) {
      if (!cloudAvailable) {
        onChange?.([]);
        return () => {};
      }
      const safeLimit = Math.min(Math.max(parseInt(maxEvents, 10) || 50, 1), 200);
      const q = query(auditCol, orderBy('createdAt', 'desc'), firestoreLimit(safeLimit));
      return onSnapshot(
        q,
        (snap) => {
          const events = [];
          snap.forEach((d) => {
            const data = d.data() ?? {};
            events.push({
              id: d.id,
              type: typeof data.type === 'string' ? data.type : '',
              summary: typeof data.summary === 'string' ? data.summary : '',
              actor: data.actor && typeof data.actor === 'object' ? data.actor : null,
              details: data.details ?? null,
              schemaVersion: data.schemaVersion ?? null,
              // createdAt may be null briefly while server timestamp resolves.
              createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : null,
            });
          });
          onChange?.(events);
        },
        (error) => {
          if (isMissingDefaultDatabaseError(error)) {
            cloudAvailable = false;
            return;
          }
          if (typeof onError === 'function') onError(error);
          else console.warn('Audit subscription failed:', error);
        },
      );
    },
  };
}

// Phase 4 multi-plan registry. Stores the list of named plans the workspace
// knows about. The 'default' plan is always implicit and never appears in
// this list — it maps to the legacy 'shared' doc id. Only admins may write.
function readPlansData(data) {
  const raw = Array.isArray(data?.plans) ? data.plans : [];
  const seen = new Set();
  const cleaned = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const id = typeof p.id === 'string' ? sanitizeKey(p.id) : '';
    if (!id || id === DEFAULT_PLAN_ID || seen.has(id)) continue;
    seen.add(id);
    cleaned.push({
      id,
      name: typeof p.name === 'string' ? p.name.trim().slice(0, 120) : '',
      description: typeof p.description === 'string' ? p.description.trim().slice(0, 500) : '',
      createdAt: p.createdAt ?? null,
      createdBy: typeof p.createdBy === 'string' ? p.createdBy : '',
    });
  }
  return cleaned;
}

export function generatePlanId(name) {
  // Make a stable, URL/Firestore-safe ID with a short random suffix so renames
  // don't break anything but accidental duplicates are still possible.
  const base = sanitizeKey(String(name || 'plan').toLowerCase().replace(/\s+/g, '-')).slice(0, 40);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${base || 'plan'}_${rand}`;
}

export function createPlansStore() {
  const db = getDb();

  if (!db) {
    return {
      enabled: false,
      async loadPlans() { return []; },
      subscribePlans() { return () => {}; },
      async createPlan() { throw new Error('Firebase is not configured.'); },
      async updatePlan() { throw new Error('Firebase is not configured.'); },
      async deletePlan() { throw new Error('Firebase is not configured.'); },
    };
  }

  const plansRef = doc(db, PLANS_DOC_PATH[0], PLANS_DOC_PATH[1]);

  async function readCurrent() {
    const snap = await getDoc(plansRef);
    return snap.exists() ? readPlansData(snap.data()) : [];
  }

  async function writePlans(plans) {
    const cleaned = readPlansData({ plans });
    await setDoc(
      plansRef,
      {
        schemaVersion: PLANS_SCHEMA_VERSION,
        plans: cleaned,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
    return cleaned;
  }

  return {
    enabled: true,
    schemaVersion: PLANS_SCHEMA_VERSION,
    async loadPlans() {
      try {
        return await readCurrent();
      } catch (error) {
        if (isMissingDefaultDatabaseError(error)) return [];
        throw error;
      }
    },
    subscribePlans(onChange, onError) {
      return onSnapshot(
        plansRef,
        (snap) => onChange(snap.exists() ? readPlansData(snap.data()) : []),
        (error) => {
          if (isMissingDefaultDatabaseError(error)) return;
          if (typeof onError === 'function') onError(error);
          else console.error('Plans subscription failed:', error);
        },
      );
    },
    async createPlan({ name, description, createdBy }) {
      const trimmedName = String(name ?? '').trim();
      if (!trimmedName) throw new Error('Plan name is required.');
      const id = generatePlanId(trimmedName);
      const docKey = getPlanDocKey(id);

      // Seed the per-plan blueprint and runbook docs BEFORE adding the plan
      // to the registry. If seeding fails, the registry never references a
      // plan whose data docs do not exist, and the next visitor will not
      // accidentally seed the new plan from their local default-plan cache.
      const stateRef = doc(db, 'kundeplanStates', docKey);
      const runbookRef = doc(db, 'kundeplanRunbook', docKey);
      await setDoc(
        stateRef,
        {
          state: { parts: [], selectedId: null },
          versions: [],
          versionCount: 0,
          schemaVersion: PLANS_SCHEMA_VERSION,
          createdForPlan: id,
          updatedAt: serverTimestamp(),
        },
        { merge: false },
      );
      await setDoc(
        runbookRef,
        {
          config: {},
          schemaVersion: PLANS_SCHEMA_VERSION,
          createdForPlan: id,
          updatedAt: serverTimestamp(),
        },
        { merge: false },
      );

      const current = await readCurrent();
      const entry = {
        id,
        name: trimmedName.slice(0, 120),
        description: String(description ?? '').trim().slice(0, 500),
        createdAt: new Date().toISOString(),
        createdBy: typeof createdBy === 'string' ? createdBy : '',
      };
      await writePlans([...current, entry]);
      return entry;
    },
    async updatePlan(planId, patch) {
      if (!planId || planId === DEFAULT_PLAN_ID) {
        throw new Error('Cannot edit the default plan.');
      }
      const current = await readCurrent();
      const next = current.map((p) =>
        p.id === planId
          ? {
              ...p,
              name: typeof patch?.name === 'string' ? patch.name.trim().slice(0, 120) : p.name,
              description: typeof patch?.description === 'string' ? patch.description.trim().slice(0, 500) : p.description,
            }
          : p,
      );
      return writePlans(next);
    },
    async deletePlan(planId) {
      if (!planId || planId === DEFAULT_PLAN_ID) {
        throw new Error('Cannot delete the default plan.');
      }
      const current = await readCurrent();
      const next = current.filter((p) => p.id !== planId);
      await writePlans(next);
      // Note: per-plan state + runbook docs are intentionally left in place.
      // Removing them would be irreversible; the admin can clear them in the
      // Firebase console if they want a hard delete.
      return next;
    },
  };
}

// Phase 5: per-entity comments. Single collection with one doc per comment.
// Threads are filtered by a composite `entityKey` so we never need a Firestore
// composite index: a single equality filter is enough and sorting happens on
// the client (typical thread is small).
export const COMMENT_ENTITY_TYPES = Object.freeze({
  PART: 'part',
  RUNBOOK_STEP: 'runbookStep',
});

export function getCommentEntityKey({ planId, entityType, entityId }) {
  const p = planId || DEFAULT_PLAN_ID;
  return `${p}::${entityType}::${entityId}`;
}

function readCommentDoc(snapDoc) {
  const data = snapDoc.data() ?? {};
  return {
    id: snapDoc.id,
    schemaVersion: data.schemaVersion ?? null,
    planId: typeof data.planId === 'string' ? data.planId : DEFAULT_PLAN_ID,
    entityType: typeof data.entityType === 'string' ? data.entityType : '',
    entityId: typeof data.entityId === 'string' ? data.entityId : '',
    entityKey: typeof data.entityKey === 'string' ? data.entityKey : '',
    body: typeof data.body === 'string' ? data.body : '',
    author: data.author && typeof data.author === 'object'
      ? { email: data.author.email ?? '', displayName: data.author.displayName ?? '' }
      : { email: '', displayName: '' },
    createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : null,
    editedAt: data.editedAt?.toDate ? data.editedAt.toDate() : null,
  };
}

export function createCommentsStore() {
  const db = getDb();

  if (!db) {
    return {
      enabled: false,
      schemaVersion: COMMENTS_SCHEMA_VERSION,
      async addComment() { throw new Error('Firebase is not configured.'); },
      async updateComment() { throw new Error('Firebase is not configured.'); },
      async deleteComment() { throw new Error('Firebase is not configured.'); },
      subscribeThread() { return () => {}; },
    };
  }

  const commentsCol = collection(db, COMMENTS_COLLECTION);
  let cloudAvailable = true;

  return {
    enabled: true,
    schemaVersion: COMMENTS_SCHEMA_VERSION,

    async addComment({ planId, entityType, entityId, body, author }) {
      if (!cloudAvailable) return null;
      const trimmed = typeof body === 'string' ? body.trim() : '';
      if (!trimmed) throw new Error('Comment body is required.');
      if (trimmed.length > 4000) throw new Error('Comment is too long (max 4000 characters).');
      const authorEmail = normalizeEmail(author?.email);
      if (!authorEmail) throw new Error('Sign-in required to comment.');
      const safePlanId = planId || DEFAULT_PLAN_ID;
      const safeEntityType = entityType in COMMENT_ENTITY_TYPES_BY_VALUE ? entityType : null;
      if (!safeEntityType) throw new Error('Unknown entity type for comment.');
      if (!entityId || typeof entityId !== 'string') throw new Error('Missing entityId for comment.');

      const ref = await addDoc(commentsCol, {
        schemaVersion: COMMENTS_SCHEMA_VERSION,
        planId: safePlanId,
        entityType: safeEntityType,
        entityId,
        entityKey: getCommentEntityKey({ planId: safePlanId, entityType: safeEntityType, entityId }),
        body: trimmed,
        author: {
          email: authorEmail,
          displayName: typeof author?.displayName === 'string' ? author.displayName.slice(0, 200) : '',
        },
        createdAt: serverTimestamp(),
        editedAt: null,
      });
      return ref.id;
    },

    async updateComment(commentId, { body }) {
      if (!cloudAvailable) return null;
      const trimmed = typeof body === 'string' ? body.trim() : '';
      if (!trimmed) throw new Error('Comment body is required.');
      if (trimmed.length > 4000) throw new Error('Comment is too long (max 4000 characters).');
      await updateDoc(doc(db, COMMENTS_COLLECTION, commentId), {
        body: trimmed,
        editedAt: serverTimestamp(),
      });
      return commentId;
    },

    async deleteComment(commentId) {
      if (!cloudAvailable) return null;
      await deleteDoc(doc(db, COMMENTS_COLLECTION, commentId));
      return commentId;
    },

    subscribeThread({ planId, entityType, entityId }, onChange, onError) {
      if (!cloudAvailable) {
        onChange?.([]);
        return () => {};
      }
      const key = getCommentEntityKey({ planId, entityType, entityId });
      const q = query(commentsCol, where('entityKey', '==', key));
      return onSnapshot(
        q,
        (snap) => {
          const items = [];
          snap.forEach((d) => items.push(readCommentDoc(d)));
          // Client-side sort avoids needing a composite Firestore index.
          items.sort((a, b) => {
            const ta = a.createdAt?.getTime?.() ?? 0;
            const tb = b.createdAt?.getTime?.() ?? 0;
            return ta - tb;
          });
          onChange?.(items);
        },
        (error) => {
          if (isMissingDefaultDatabaseError(error)) {
            cloudAvailable = false;
            return;
          }
          if (typeof onError === 'function') onError(error);
          else console.warn('Comments subscription failed:', error);
        },
      );
    },
  };
}

const COMMENT_ENTITY_TYPES_BY_VALUE = Object.freeze(
  Object.fromEntries(Object.values(COMMENT_ENTITY_TYPES).map((v) => [v, true])),
);

function readVersionDoc(d) {
  const data = d.data() ?? {};
  return {
    id: d.id,
    planId: data.planId ?? DEFAULT_PLAN_ID,
    label: data.label ?? '',
    description: data.description ?? '',
    parts: Array.isArray(data.parts) ? data.parts : [],
    runbookConfig: data.runbookConfig && typeof data.runbookConfig === 'object' ? data.runbookConfig : {},
    author: data.author ?? null,
    createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : null,
  };
}

// Phase 7 — cloud-shared version snapshots. Append-only collection: every
// 'Save version' click writes one new doc with the full blueprint + runbook
// configuration for the active plan. Anyone with admin rights can restore
// from one of these docs, which overwrites the live plan for everyone.
//
// Docs include parts and runbookConfig inline. Firestore caps a single doc
// at ~1 MB which is plenty for typical plans (a few hundred parts).
export function createVersionsStore() {
  const db = getDb();

  if (!db) {
    return {
      enabled: false,
      schemaVersion: VERSIONS_SCHEMA_VERSION,
      async addVersion() { throw new Error('Firebase is not configured.'); },
      async deleteVersion() { throw new Error('Firebase is not configured.'); },
      async getVersion() { throw new Error('Firebase is not configured.'); },
      subscribeList() { return () => {}; },
    };
  }

  const versionsCol = collection(db, VERSIONS_COLLECTION);
  let cloudAvailable = true;

  return {
    enabled: true,
    schemaVersion: VERSIONS_SCHEMA_VERSION,

    async addVersion({ planId, label, description, parts, runbookConfig, author }) {
      if (!cloudAvailable) return null;
      const safePlanId = planId || DEFAULT_PLAN_ID;
      const trimmedLabel = typeof label === 'string' ? label.trim().slice(0, 120) : '';
      if (!trimmedLabel) throw new Error('Version label is required.');
      const safeDescription = typeof description === 'string' ? description.trim().slice(0, 500) : '';
      const safeParts = Array.isArray(parts) ? parts : [];
      const safeRunbook = runbookConfig && typeof runbookConfig === 'object' ? runbookConfig : {};
      const authorEmail = normalizeEmail(author?.email);
      if (!authorEmail) throw new Error('Sign-in required to save a version.');

      const ref = await addDoc(versionsCol, {
        schemaVersion: VERSIONS_SCHEMA_VERSION,
        planId: safePlanId,
        label: trimmedLabel,
        description: safeDescription,
        parts: safeParts,
        runbookConfig: safeRunbook,
        author: {
          email: authorEmail,
          displayName: typeof author?.displayName === 'string' ? author.displayName.slice(0, 200) : '',
        },
        createdAt: serverTimestamp(),
      });
      return ref.id;
    },

    async deleteVersion(versionId) {
      if (!cloudAvailable) return null;
      await deleteDoc(doc(db, VERSIONS_COLLECTION, versionId));
      return versionId;
    },

    async getVersion(versionId) {
      if (!cloudAvailable) return null;
      const snap = await getDoc(doc(db, VERSIONS_COLLECTION, versionId));
      if (!snap.exists()) return null;
      return readVersionDoc(snap);
    },

    subscribeList({ planId }, onChange, onError) {
      if (!cloudAvailable) {
        onChange?.([]);
        return () => {};
      }
      const safePlanId = planId || DEFAULT_PLAN_ID;
      // Single equality filter + client-side sort avoids a composite index.
      const q = query(versionsCol, where('planId', '==', safePlanId));
      return onSnapshot(
        q,
        (snap) => {
          const items = [];
          snap.forEach((d) => items.push(readVersionDoc(d)));
          items.sort((a, b) => {
            const ta = a.createdAt?.getTime?.() ?? 0;
            const tb = b.createdAt?.getTime?.() ?? 0;
            return tb - ta; // newest first
          });
          onChange?.(items.slice(0, VERSIONS_LIST_LIMIT));
        },
        (error) => {
          if (isMissingDefaultDatabaseError(error)) {
            cloudAvailable = false;
            return;
          }
          if (typeof onError === 'function') onError(error);
          else console.warn('Versions subscription failed:', error);
        },
      );
    },
  };
}

const USER_AUTO_COLLECTION = 'kundeplanUserAuto';
const USER_AUTO_SCHEMA_VERSION = 1;

export function getUserAutoDocId(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return '';
  // Firestore allows '.' in doc ids but we replace it to avoid surprises.
  return normalized.replace(/[^a-z0-9_-]/g, '_').slice(0, 200);
}

function readUserAutoDoc(d) {
  const data = d.data() ?? {};
  return {
    id: d.id,
    email: typeof data.email === 'string' ? data.email : '',
    displayName: typeof data.displayName === 'string' ? data.displayName : '',
    emailVerified: typeof data.emailVerified === 'boolean' ? data.emailVerified : null,
    firstSeenAt: data.firstSeenAt?.toDate ? data.firstSeenAt.toDate() : null,
    lastSeenAt: data.lastSeenAt?.toDate ? data.lastSeenAt.toDate() : null,
  };
}

// Phase 8 — self-written sign-in stub. Every time a trusted user signs in
// the app calls recordSignIn(), which upserts a small doc under their email
// key. The Users panel reads the whole collection and surfaces any stub
// whose email is not in the curated kundeplanUsers/list as an auto-viewer
// row, so admins can see (and promote) anyone who has accessed the app.
export function createUserAutoStore() {
  const db = getDb();

  if (!db) {
    return {
      enabled: false,
      async registerNewAccount() { return null; },
      async recordSignIn() { return null; },
      async deleteAuto() { return null; },
      subscribeAll() { return () => {}; },
    };
  }

  const autoCol = collection(db, USER_AUTO_COLLECTION);
  let cloudAvailable = true;

  return {
    enabled: true,
    schemaVersion: USER_AUTO_SCHEMA_VERSION,

    // One-shot stub write called from the account-creation flow. The caller
    // is signed in but not yet email-verified, so we intentionally avoid a
    // prior getDoc (which requires isTrustedUser) and do a single
    // setDoc-with-merge that pins the immutable fields. Silent on failure.
    async registerNewAccount({ email, displayName, emailVerified }) {
      if (!cloudAvailable) return null;
      const normalized = normalizeEmail(email);
      if (!normalized) return null;
      const docId = getUserAutoDocId(normalized);
      const ref = doc(db, USER_AUTO_COLLECTION, docId);
      try {
        await setDoc(
          ref,
          {
            schemaVersion: USER_AUTO_SCHEMA_VERSION,
            email: normalized,
            displayName: typeof displayName === 'string' ? displayName.slice(0, 200) : '',
            emailVerified: emailVerified === true,
            firstSeenAt: serverTimestamp(),
            lastSeenAt: serverTimestamp(),
          },
          { merge: true },
        );
        return docId;
      } catch (err) {
        if (isMissingDefaultDatabaseError(err)) {
          cloudAvailable = false;
          return null;
        }
        console.warn('registerNewAccount failed:', err);
        return null;
      }
    },

    // Idempotent. Creates the stub on first sign-in, updates lastSeenAt on
    // subsequent sign-ins. Silent on failure so a permission glitch never
    // blocks the actual sign-in flow.
    async recordSignIn({ email, displayName, emailVerified }) {
      if (!cloudAvailable) return null;
      const normalized = normalizeEmail(email);
      if (!normalized) return null;
      const docId = getUserAutoDocId(normalized);
      const ref = doc(db, USER_AUTO_COLLECTION, docId);
      try {
        const existing = await getDoc(ref);
        if (existing.exists()) {
          await setDoc(
            ref,
            {
              lastSeenAt: serverTimestamp(),
              ...(typeof emailVerified === 'boolean' ? { emailVerified } : {}),
            },
            { merge: true },
          );
        } else {
          await setDoc(ref, {
            schemaVersion: USER_AUTO_SCHEMA_VERSION,
            email: normalized,
            displayName: typeof displayName === 'string' ? displayName.slice(0, 200) : '',
            emailVerified: emailVerified === true,
            firstSeenAt: serverTimestamp(),
            lastSeenAt: serverTimestamp(),
          });
        }
        return docId;
      } catch (err) {
        if (isMissingDefaultDatabaseError(err)) {
          cloudAvailable = false;
          return null;
        }
        console.warn('recordSignIn failed:', err);
        return null;
      }
    },

    async deleteAuto(docId) {
      if (!cloudAvailable || !docId) return null;
      try {
        await deleteDoc(doc(db, USER_AUTO_COLLECTION, docId));
        return docId;
      } catch (err) {
        console.warn('deleteAuto failed:', err);
        return null;
      }
    },

    subscribeAll(onChange, onError) {
      if (!cloudAvailable) {
        onChange?.([]);
        return () => {};
      }
      return onSnapshot(
        autoCol,
        (snap) => {
          const items = [];
          snap.forEach((d) => items.push(readUserAutoDoc(d)));
          items.sort((a, b) => {
            const ta = a.firstSeenAt?.getTime?.() ?? 0;
            const tb = b.firstSeenAt?.getTime?.() ?? 0;
            return tb - ta;
          });
          onChange?.(items);
        },
        (error) => {
          if (isMissingDefaultDatabaseError(error)) {
            cloudAvailable = false;
            return;
          }
          if (typeof onError === 'function') onError(error);
          else console.warn('User auto subscription failed:', error);
        },
      );
    },
  };
}
