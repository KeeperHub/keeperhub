// Public display values from reproducible-demo-evidence.json. Keep this small
// snapshot in application source because Docker builds exclude tests/. The
// starter-workflow test checks it against the full recorded evidence.
export const pythDemoEvidence = {
  executionId: "40e7sxteumqdfy8muq04h",
  feedId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  price: "2470.47459758",
  threshold: "2470.39595354",
  duplicateDeliveries: 2,
  actionCount: 1,
} as const;

export const PYTH_FEATURE_PR =
  "https://github.com/KeeperHub/keeperhub/pull/2363";
export const PYTH_EVIDENCE_URL =
  "https://github.com/Webghost01-NG/keeperhub-pyth-trigger/blob/feat/issue-2242-pyth-trigger/tests/fixtures/pyth-trigger/reproducible-demo-evidence.json";
