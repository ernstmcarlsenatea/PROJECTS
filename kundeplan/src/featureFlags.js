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
  // Phase 1
  lazyPages: true,
  // Phase 2 (not implemented yet)
  searchAndFilter: false,
  // Phase 3 (not implemented yet)
  auditLog: false,
  // Phase 4 (not implemented yet)
  multiPlan: false,
  // Phase 5 (not implemented yet)
  comments: false,
});

export function isFeatureEnabled(name) {
  return Boolean(FEATURE_FLAGS[name]);
}
