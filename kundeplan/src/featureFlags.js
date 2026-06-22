// Feature flags for staged rollout of improvements. Flip any flag to false
// to disable the feature without deploying old code. Each flag is read at
// component-mount time; toggling it requires a page reload.
//
// Rollback playbook:
//   1. Set the flag to false here.
//   2. Rebuild and redeploy (or revert the commit that turned it on).
//   3. No data is read or written under the disabled flag, so legacy
//      behaviour is preserved.
//
// Schema version used for any new Firestore documents we write going forward.
export const SCHEMA_VERSION = 1;

export const FEATURE_FLAGS = Object.freeze({
  // Phase 0
  exportEverything: true,
  // Phase 1 — bundle splitting is build-time; rollback via `git revert`.
  // Phase 2
  searchAndFilter: true,
  // Phase 3 — append-only audit log + Activity panel.
  auditLog: true,
  // Phase 4 — multi-plan support (separate blueprint + runbook per plan).
  // Switching plans triggers a page reload; templates, users, and audit log
  // remain global. Disable to revert to a single shared plan.
  multiPlan: true,
  // Phase 5 (not implemented yet)
  comments: false,
});

export function isFeatureEnabled(name) {
  return Boolean(FEATURE_FLAGS[name]);
}
