// Execution-focused load test scenario.
// Assumes users and workflows are already created by the shell orchestrator.
// Each VU signs in as its assigned user, then continuously triggers
// manual/webhook workflows and polls execution results.

import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";
import { SharedArray } from "k6/data";
import http from "k6/http";
import exec from "k6/execution";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const TEST_API_KEY = __ENV.TEST_API_KEY || "";

const executionSuccess = new Counter("execution_success");
const executionError = new Counter("execution_error");
const executionTimeout = new Counter("execution_timeout");
const executionDuration = new Trend("execution_duration", true);

const userData = new SharedArray("users", function () {
  const path = __ENV.USER_DATA_PATH || "/tmp/k6-exec-load/users.json";
  return JSON.parse(open(path));
});

export const options = {
  thresholds: {
    execution_success: ["count>0"],
  },
};

if (__ENV.K6_SCENARIO === "exec-load") {
  delete options.scenarios;
}

function commonHeaders() {
  const h = {
    "Content-Type": "application/json",
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
  };
  if (TEST_API_KEY) {
    h["X-Test-API-Key"] = TEST_API_KEY;
  }
  return h;
}

// Per-VU state: whether we've signed in
let signedIn = false;

export default function () {
  const vuId = exec.vu.idInTest;
  const user = userData[(vuId - 1) % userData.length];

  if (!user || !user.workflows || user.workflows.length === 0) {
    sleep(5);
    return;
  }

  // Sign in on first iteration to establish session cookie in k6's jar
  if (!signedIn) {
    const signinRes = http.post(
      `${BASE_URL}/api/auth/sign-in/email`,
      JSON.stringify({ email: user.email, password: "K6LoadTest!2024" }),
      { headers: commonHeaders() }
    );
    if (signinRes.status === 200) {
      signedIn = true;
    } else {
      executionError.add(1);
      sleep(2);
      return;
    }
  }

  const iterIdx = exec.vu.iterationInScenario;
  const wf = user.workflows[iterIdx % user.workflows.length];

  if (!wf.id) {
    sleep(1);
    return;
  }

  const triggerType = wf.triggerType || "Manual";

  // Trigger the workflow
  let triggerRes;
  if (triggerType === "Webhook" && user.apiKey) {
    triggerRes = http.post(
      `${BASE_URL}/api/workflows/${wf.id}/webhook`,
      JSON.stringify({ test: true }),
      { headers: { ...commonHeaders(), Authorization: `Bearer ${user.apiKey}` } }
    );
  } else {
    triggerRes = http.post(
      `${BASE_URL}/api/workflow/${wf.id}/execute`,
      JSON.stringify({}),
      { headers: commonHeaders() }
    );
  }

  const triggerOk = check(triggerRes, {
    "trigger: status 200": (r) => r.status === 200 || r.status === 201,
  });

  if (!triggerOk) {
    executionError.add(1);
    sleep(0.5);
    return;
  }

  let execBody;
  try {
    execBody = JSON.parse(triggerRes.body);
  } catch {
    executionError.add(1);
    sleep(0.5);
    return;
  }

  const executionId = execBody.executionId;
  if (!executionId) {
    // Webhook triggers may not return executionId directly
    executionSuccess.add(1);
    sleep(0.5);
    return;
  }

  // Poll execution status until it completes (max 30s)
  const maxPollTime = 30;
  let elapsed = 0;
  let finalStatus = "unknown";

  while (elapsed < maxPollTime) {
    sleep(1);
    elapsed += 1;

    const statusRes = http.get(
      `${BASE_URL}/api/workflows/executions/${executionId}/status`,
      { headers: commonHeaders() }
    );

    if (statusRes.status !== 200) {
      continue;
    }

    let statusBody;
    try {
      statusBody = JSON.parse(statusRes.body);
    } catch {
      continue;
    }

    finalStatus = statusBody.status;
    if (finalStatus === "success" || finalStatus === "error" || finalStatus === "cancelled") {
      break;
    }
  }

  if (finalStatus === "success") {
    executionSuccess.add(1);
  } else if (finalStatus === "error" || finalStatus === "cancelled") {
    executionError.add(1);
  } else {
    executionTimeout.add(1);
  }

  sleep(0.5);
}
