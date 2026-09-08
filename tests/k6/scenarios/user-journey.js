import { check, sleep } from "k6";
import { post, get, put } from "../helpers/http.js";
import { registerAndLogin } from "../helpers/auth.js";
import { getAllWorkflowPayloads } from "../helpers/workflows.js";
import exec from "k6/execution";

// Module-level state per VU (each VU gets its own JS context)
let vuApiKey = null;

export function userJourney() {
  const vuId = exec.vu.idInTest;
  const isFirstIteration = exec.vu.iterationInScenario === 0;

  // Phase 1 & 2: Auth + workflow creation (first iteration only)
  if (isFirstIteration) {
    const user = registerAndLogin(vuId);
    if (!user) {
      console.error(`VU ${vuId}: auth failed, aborting`);
      return;
    }

    vuApiKey = user.apiKey;

    // Create 5 workflows
    const workflowPayloads = getAllWorkflowPayloads(vuId);
    const createdWorkflows = [];

    for (const payload of workflowPayloads) {
      const createRes = post("/api/workflows/create", payload);

      const createOk = check(createRes, {
        "workflow create: status 200": (r) => r.status === 200,
      });

      if (!createOk) {
        console.error(
          `VU ${vuId}: workflow create failed: ${createRes.status} ${createRes.body}`
        );
        continue;
      }

      const workflow = JSON.parse(createRes.body);
      createdWorkflows.push(workflow);

      // Enable workflow (PUT with required name field)
      const goLiveRes = put(`/api/workflows/${workflow.id}/go-live`, {
        name: workflow.name || payload.name,
      });
      check(goLiveRes, {
        "go-live: status 200": (r) => r.status === 200,
      });
    }

    // Store workflow IDs on the VU for subsequent iterations
    exec.vu.tags["workflowCount"] = String(createdWorkflows.length);
  }

  // Phase 3: Steady-state operations
  steadyStateOps(vuId);
}

function steadyStateOps(vuId) {
  // List workflows
  const listRes = get("/api/workflows");
  const listOk = check(listRes, {
    "list workflows: status 200": (r) => r.status === 200,
  });

  if (!listOk) {
    console.error(
      `VU ${vuId}: list workflows failed: ${listRes.status} ${listRes.body}`
    );
    return;
  }

  let workflows;
  try {
    workflows = JSON.parse(listRes.body);
  } catch {
    console.error(`VU ${vuId}: failed to parse workflow list`);
    return;
  }

  if (!Array.isArray(workflows) || workflows.length === 0) {
    console.error(`VU ${vuId}: no workflows found`);
    return;
  }

  // Get a specific workflow
  const randomWorkflow = workflows[Math.floor(Math.random() * workflows.length)];
  const getRes = get(`/api/workflows/${randomWorkflow.id}`);
  check(getRes, {
    "get workflow: status 200": (r) => r.status === 200,
  });

  // Find a manual workflow to execute
  const manualWorkflow = workflows.find(
    (w) =>
      w.nodes &&
      w.nodes[0] &&
      w.nodes[0].data &&
      w.nodes[0].data.config &&
      w.nodes[0].data.config.triggerType === "Manual"
  );

  if (manualWorkflow) {
    // Execute the manual workflow
    const executeRes = post(`/api/workflow/${manualWorkflow.id}/execute`, {});
    const executeOk = check(executeRes, {
      "execute workflow: status 200": (r) =>
        r.status === 200 || r.status === 201,
    });

    if (executeOk) {
      let execBody;
      try {
        execBody = JSON.parse(executeRes.body);
      } catch {
        // noop
      }

      // Poll execution status if we got an executionId
      if (execBody && execBody.executionId) {
        sleep(1);
        const statusRes = get(
          `/api/workflows/executions/${execBody.executionId}/status`
        );
        check(statusRes, {
          "execution status: status 200": (r) => r.status === 200,
        });
      }
    }
  }

  // Find and trigger the webhook workflow (requires user API key)
  if (vuApiKey) {
    const webhookWorkflow = workflows.find(
      (w) =>
        w.nodes &&
        w.nodes[0] &&
        w.nodes[0].data &&
        w.nodes[0].data.config &&
        w.nodes[0].data.config.triggerType === "Webhook"
    );

    if (webhookWorkflow) {
      const webhookRes = post(
        `/api/workflows/${webhookWorkflow.id}/webhook`,
        { test: true },
        { headers: { Authorization: `Bearer ${vuApiKey}` } }
      );
      check(webhookRes, {
        "webhook trigger: status 200": (r) =>
          r.status === 200 || r.status === 201 || r.status === 202,
      });
    }
  }

  // List executions for a workflow
  if (manualWorkflow) {
    const execListRes = get(
      `/api/workflows/${manualWorkflow.id}/executions`
    );
    check(execListRes, {
      "list executions: status 200": (r) => r.status === 200,
    });
  }

  sleep(Math.random() * 2 + 1);
}
