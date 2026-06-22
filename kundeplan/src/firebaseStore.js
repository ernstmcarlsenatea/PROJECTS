import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getFirestore,
  limit as firestoreLimit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';

// Bootstrap super-admin. This email always has admin rights even if no
// admins document exists yet, so it can grant admin status to other users.
export const SUPER_ADMIN_EMAIL = 'ernst.magne.carlsen@atea.no';
const ADMINS_DOC_PATH = ['kundeplanAdmins', 'list'];
const EDITORS_DOC_PATH = ['kundeplanEditors', 'list'];
const USERS_DOC_PATH = ['kundeplanUsers', 'list'];
const TEMPLATES_DOC_PATH = ['kundeplanTemplates', 'list'];
const AUDIT_COLLECTION = 'kundeplanAudit';
const AUDIT_SCHEMA_VERSION = 1;

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

function getDb() {
  if (!isConfigured()) {
    return null;
  }

  return getFirestore(firebaseApp);
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

export function createCloudStore(auth) {
  const db = getDb();
  const userKey = getUserKey(auth);

  if (!db) {
    return {
      enabled: false,
      userKey,
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
export function createRunbookStore() {
  const db = getDb();
  const docKey = SHARED_DOC_KEY;

  if (!db) {
    return {
      enabled: false,
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
