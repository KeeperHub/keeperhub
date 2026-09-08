import { userJourney } from "./scenarios/user-journey.js";

const TARGET_VUS = parseInt(__ENV.K6_TARGET_VUS || "500", 10);
const STAGE_DURATION = __ENV.K6_STAGE_DURATION || "5m";
const P95_THRESHOLD = parseInt(__ENV.K6_P95_RESPONSE_TIME || "2000", 10);
const ERROR_RATE = parseFloat(__ENV.K6_ERROR_RATE || "0.05");

export const options = {
  scenarios: {
    smoke: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
    },
  },
  thresholds: {
    http_req_failed: [`rate<${ERROR_RATE}`],
    http_req_duration: [`p(95)<${P95_THRESHOLD}`],
  },
};

// Staged load test config (activate by running with K6_SCENARIO=load)
// k6 run load-test.js -e K6_SCENARIO=load
if (__ENV.K6_SCENARIO === "load") {
  const vusStages = [10, 50, 100, 250, TARGET_VUS];
  const rampDurations = ["30s", "1m", "1m", "2m", "2m"];
  const stages = [];

  for (let i = 0; i < vusStages.length; i++) {
    stages.push({ duration: rampDurations[i], target: vusStages[i] });
    stages.push({ duration: STAGE_DURATION, target: vusStages[i] });
  }
  stages.push({ duration: "2m", target: 0 });

  options.scenarios = {
    load: {
      executor: "ramping-vus",
      startVUs: 0,
      stages,
      gracefulRampDown: "30s",
    },
  };
}

// CI mode: VUs and iterations are passed via CLI flags (--vus, --iterations)
// so we just clear the scenario config and let k6 use those CLI values.
if (__ENV.K6_SCENARIO === "ci") {
  delete options.scenarios;
}

export default function () {
  userJourney();
}
