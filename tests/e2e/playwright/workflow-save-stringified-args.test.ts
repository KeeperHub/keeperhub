import { expect, test } from "./fixtures";
import {
  createTestWorkflow,
  deleteTestWorkflow,
  PERSISTENT_TEST_USER_EMAIL,
} from "./utils/db";

const READ_CONTRACT_ABI = JSON.stringify([
  {
    inputs: [{ internalType: "bytes32", name: "id", type: "bytes32" }],
    name: "reader",
    outputs: [
      { internalType: "uint256", name: "Art", type: "uint256" },
      { internalType: "uint256", name: "rate", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
]);

const WRITE_CONTRACT_ABI = JSON.stringify([
  {
    inputs: [],
    name: "doWrite",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
]);

type WorkflowNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    label?: string;
    type: string;
    config: Record<string, unknown>;
  };
};

function triggerNode(): WorkflowNode {
  return {
    id: "trigger",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      label: "Manual",
      type: "trigger",
      config: { actionType: "Manual" },
    },
  };
}

function readContractNode(
  overrides: Partial<Record<string, unknown>> = {},
  id = "read-1"
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 120 },
    data: {
      label: "Read Contract",
      type: "action",
      config: {
        actionType: "web3/read-contract",
        network: "1",
        contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        abi: READ_CONTRACT_ABI,
        abiFunction: "reader",
        functionArgs: '["{{@prev-loop:Prev Loop.currentItem.idBytes32}}"]',
        ...overrides,
      },
    },
  };
}

function discordNode(id = "notify-1"): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 240 },
    data: {
      label: "Discord",
      type: "action",
      config: {
        actionType: "discord/send-message",
        discordMessage: "done",
      },
    },
  };
}

test.describe("KEEP-571: workflow save with stringified container fields", () => {
  test("saves a 3-node workflow with web3/read-contract stringified functionArgs (templated-args shape)", async ({
    page,
    apiRequest,
  }) => {
    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `keep-571-read-contract-${Date.now()}`,
      triggerType: "manual",
      nodes: [triggerNode(), readContractNode(), discordNode()],
      edges: [
        { id: "e1", source: "trigger", target: "read-1" },
        { id: "e2", source: "read-1", target: "notify-1" },
      ],
    });

    try {
      await page.goto(`/workflows/${workflow.id}`, {
        waitUntil: "domcontentloaded",
      });

      const response = await apiRequest.patch(`/api/workflows/${workflow.id}`, {
        data: {
          nodes: [triggerNode(), readContractNode(), discordNode()],
          edges: [
            { id: "e1", source: "trigger", target: "read-1" },
            { id: "e2", source: "read-1", target: "notify-1" },
          ],
        },
      });

      const body = await response.text();
      expect(response.status(), `PATCH failed with body: ${body}`).toBe(200);
    } finally {
      await deleteTestWorkflow(workflow.id);
    }
  });

  test("saves a workflow with legacy `functionName` on web3/write-contract (legacy functionName shape)", async ({
    page,
    apiRequest,
  }) => {
    const writeNode: WorkflowNode = {
      id: "write-1",
      type: "action",
      position: { x: 0, y: 120 },
      data: {
        label: "Write Contract",
        type: "action",
        config: {
          actionType: "web3/write-contract",
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: WRITE_CONTRACT_ABI,
          functionName: "doWrite",
          functionArgs: "[]",
        },
      },
    };

    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `keep-571-legacy-fn-name-${Date.now()}`,
      triggerType: "manual",
      nodes: [triggerNode(), writeNode, discordNode()],
      edges: [
        { id: "e1", source: "trigger", target: "write-1" },
        { id: "e2", source: "write-1", target: "notify-1" },
      ],
    });

    try {
      await page.goto(`/workflows/${workflow.id}`, {
        waitUntil: "domcontentloaded",
      });

      const response = await apiRequest.patch(`/api/workflows/${workflow.id}`, {
        data: {
          nodes: [triggerNode(), writeNode, discordNode()],
          edges: [
            { id: "e1", source: "trigger", target: "write-1" },
            { id: "e2", source: "write-1", target: "notify-1" },
          ],
        },
      });

      const body = await response.text();
      expect(response.status(), `PATCH failed with body: ${body}`).toBe(200);
    } finally {
      await deleteTestWorkflow(workflow.id);
    }
  });

  test("saves a workflow with an empty-array stringified functionArgs (no-arg function)", async ({
    page,
    apiRequest,
  }) => {
    const noArgWrite: WorkflowNode = {
      id: "write-1",
      type: "action",
      position: { x: 0, y: 120 },
      data: {
        label: "Write Contract",
        type: "action",
        config: {
          actionType: "web3/write-contract",
          network: "1",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          abi: WRITE_CONTRACT_ABI,
          abiFunction: "doWrite",
          functionArgs: "[]",
        },
      },
    };

    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `keep-571-empty-args-${Date.now()}`,
      triggerType: "manual",
      nodes: [triggerNode(), noArgWrite, discordNode()],
      edges: [
        { id: "e1", source: "trigger", target: "write-1" },
        { id: "e2", source: "write-1", target: "notify-1" },
      ],
    });

    try {
      await page.goto(`/workflows/${workflow.id}`, {
        waitUntil: "domcontentloaded",
      });

      const response = await apiRequest.patch(`/api/workflows/${workflow.id}`, {
        data: {
          nodes: [triggerNode(), noArgWrite, discordNode()],
          edges: [
            { id: "e1", source: "trigger", target: "write-1" },
            { id: "e2", source: "write-1", target: "notify-1" },
          ],
        },
      });

      const body = await response.text();
      expect(response.status(), `PATCH failed with body: ${body}`).toBe(200);
    } finally {
      await deleteTestWorkflow(workflow.id);
    }
  });

  test("rejects a non-JSON, non-template literal in functionArgs with 422 INVALID_ACTION_CONFIG", async ({
    page,
    apiRequest,
  }) => {
    const badNode = readContractNode({
      functionArgs: "this-is-not-json-or-a-template",
    });

    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `keep-571-bad-args-${Date.now()}`,
      triggerType: "manual",
      nodes: [triggerNode(), readContractNode(), discordNode()],
      edges: [
        { id: "e1", source: "trigger", target: "read-1" },
        { id: "e2", source: "read-1", target: "notify-1" },
      ],
    });

    try {
      await page.goto(`/workflows/${workflow.id}`, {
        waitUntil: "domcontentloaded",
      });

      const response = await apiRequest.patch(`/api/workflows/${workflow.id}`, {
        data: {
          nodes: [triggerNode(), badNode, discordNode()],
          edges: [
            { id: "e1", source: "trigger", target: "read-1" },
            { id: "e2", source: "read-1", target: "notify-1" },
          ],
        },
      });

      expect(response.status()).toBe(422);
      const body = await response.json();
      expect(body.error).toBe("INVALID_ACTION_CONFIG");
      expect(body.invalidFields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "INVALID_FIELD_TYPE",
            field: "functionArgs",
          }),
        ])
      );
    } finally {
      await deleteTestWorkflow(workflow.id);
    }
  });

  test("saves the exact templated-args prod node shape that was failing (mock-workflow-id)", async ({
    page,
    apiRequest,
  }) => {
    const mockTemplatedNode: WorkflowNode = {
      id: "node-6",
      type: "action",
      position: { x: 0, y: 120 },
      data: {
        label: "Read mock contract",
        type: "action",
        config: {
          actionType: "web3/read-contract",
          abi: '[{"inputs":[{"internalType":"bytes32","name":"id","type":"bytes32"}],"name":"reader","outputs":[{"internalType":"uint256","name":"Art","type":"uint256"},{"internalType":"uint256","name":"rate","type":"uint256"},{"internalType":"uint256","name":"spot","type":"uint256"},{"internalType":"uint256","name":"line","type":"uint256"},{"internalType":"uint256","name":"dust","type":"uint256"}],"stateMutability":"view","type":"function"}]',
          network: "1",
          abiFunction: "reader",
          functionArgs: '["{{@prev-loop:Prev Loop.currentItem.idBytes32}}"]',
          contractAddress:
            "{{@fetch@prev-fetch:Prev Fetch.data.targetAddress}}",
        },
      },
    };

    const nodes = [triggerNode(), mockTemplatedNode, discordNode("notify-1")];
    const edges = [
      { id: "e1", source: "trigger", target: "node-6" },
      { id: "e2", source: "node-6", target: "notify-1" },
    ];

    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `keep-571-templated-args-${Date.now()}`,
      triggerType: "manual",
      nodes,
      edges,
    });

    try {
      await page.goto(`/workflows/${workflow.id}`, {
        waitUntil: "domcontentloaded",
      });

      const response = await apiRequest.patch(`/api/workflows/${workflow.id}`, {
        data: { nodes, edges },
      });

      const body = await response.text();
      expect(response.status(), `PATCH failed with body: ${body}`).toBe(200);
    } finally {
      await deleteTestWorkflow(workflow.id);
    }
  });

  test("node-count invariance: saves a 6-node workflow with the affected read-contract at index 3", async ({
    page,
    apiRequest,
  }) => {
    const filler = (id: string, y: number): WorkflowNode => ({
      id,
      type: "action",
      position: { x: 0, y },
      data: {
        label: "Discord",
        type: "action",
        config: {
          actionType: "discord/send-message",
          discordMessage: `step-${id}`,
        },
      },
    });

    const nodes: WorkflowNode[] = [
      triggerNode(),
      filler("f-1", 120),
      filler("f-2", 240),
      readContractNode({}, "r-3"),
      filler("f-4", 480),
      filler("f-5", 600),
    ];

    const edges = [
      { id: "e1", source: "trigger", target: "f-1" },
      { id: "e2", source: "f-1", target: "f-2" },
      { id: "e3", source: "f-2", target: "r-3" },
      { id: "e4", source: "r-3", target: "f-4" },
      { id: "e5", source: "f-4", target: "f-5" },
    ];

    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `keep-571-6node-${Date.now()}`,
      triggerType: "manual",
      nodes,
      edges,
    });

    try {
      await page.goto(`/workflows/${workflow.id}`, {
        waitUntil: "domcontentloaded",
      });

      const response = await apiRequest.patch(`/api/workflows/${workflow.id}`, {
        data: { nodes, edges },
      });

      const body = await response.text();
      expect(response.status(), `PATCH failed with body: ${body}`).toBe(200);
    } finally {
      await deleteTestWorkflow(workflow.id);
    }
  });

  test("node-count invariance: saves a 10-node workflow with TWO affected read-contract nodes (proves no aggregate cap)", async ({
    page,
    apiRequest,
  }) => {
    const filler = (id: string, y: number): WorkflowNode => ({
      id,
      type: "action",
      position: { x: 0, y },
      data: {
        label: "Discord",
        type: "action",
        config: {
          actionType: "discord/send-message",
          discordMessage: id,
        },
      },
    });

    const nodes: WorkflowNode[] = [triggerNode()];
    for (let i = 1; i <= 9; i++) {
      if (i === 2 || i === 7) {
        nodes.push(readContractNode({}, `r-${i}`));
      } else {
        nodes.push(filler(`f-${i}`, i * 120));
      }
    }

    const edges: Array<{ id: string; source: string; target: string }> = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({
        id: `e-${i}`,
        source: nodes[i].id,
        target: nodes[i + 1].id,
      });
    }

    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `keep-571-10node-${Date.now()}`,
      triggerType: "manual",
      nodes,
      edges,
    });

    try {
      await page.goto(`/workflows/${workflow.id}`, {
        waitUntil: "domcontentloaded",
      });

      const response = await apiRequest.patch(`/api/workflows/${workflow.id}`, {
        data: { nodes, edges },
      });

      const body = await response.text();
      expect(response.status(), `PATCH failed with body: ${body}`).toBe(200);
    } finally {
      await deleteTestWorkflow(workflow.id);
    }
  });

  test("saves a 2-node workflow (trigger + single affected read-contract) -- baseline for the original report", async ({
    page,
    apiRequest,
  }) => {
    const nodes = [triggerNode(), readContractNode({}, "r-1")];
    const edges = [{ id: "e1", source: "trigger", target: "r-1" }];

    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `keep-571-2node-${Date.now()}`,
      triggerType: "manual",
      nodes,
      edges,
    });

    try {
      await page.goto(`/workflows/${workflow.id}`, {
        waitUntil: "domcontentloaded",
      });

      const response = await apiRequest.patch(`/api/workflows/${workflow.id}`, {
        data: { nodes, edges },
      });

      const body = await response.text();
      expect(response.status(), `PATCH failed with body: ${body}`).toBe(200);
    } finally {
      await deleteTestWorkflow(workflow.id);
    }
  });

  test("partial PATCH that does not include `nodes` succeeds without triggering validation", async ({
    page,
    apiRequest,
  }) => {
    const nodes = [triggerNode(), readContractNode(), discordNode()];
    const edges = [
      { id: "e1", source: "trigger", target: "read-1" },
      { id: "e2", source: "read-1", target: "notify-1" },
    ];

    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `keep-571-partial-${Date.now()}`,
      triggerType: "manual",
      nodes,
      edges,
    });

    try {
      await page.goto(`/workflows/${workflow.id}`, {
        waitUntil: "domcontentloaded",
      });

      const response = await apiRequest.patch(`/api/workflows/${workflow.id}`, {
        data: { name: `renamed-${Date.now()}` },
      });

      const body = await response.text();
      expect(response.status(), `PATCH failed with body: ${body}`).toBe(200);
    } finally {
      await deleteTestWorkflow(workflow.id);
    }
  });

  test("rejected error response reports the correct node-index path in a large workflow", async ({
    page,
    apiRequest,
  }) => {
    const filler = (id: string, y: number): WorkflowNode => ({
      id,
      type: "action",
      position: { x: 0, y },
      data: {
        label: "Discord",
        type: "action",
        config: {
          actionType: "discord/send-message",
          discordMessage: id,
        },
      },
    });

    const badNode = readContractNode(
      { functionArgs: "definitely-not-json-or-template" },
      "bad-4"
    );

    const nodes: WorkflowNode[] = [
      triggerNode(),
      filler("f-1", 120),
      filler("f-2", 240),
      filler("f-3", 360),
      badNode,
      filler("f-5", 600),
    ];

    const edges: Array<{ id: string; source: string; target: string }> = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({
        id: `e-${i}`,
        source: nodes[i].id,
        target: nodes[i + 1].id,
      });
    }

    // The workflow needs valid args to seed; we send the bad args via PATCH below.
    const seedNodes = [
      triggerNode(),
      filler("f-1", 120),
      filler("f-2", 240),
      filler("f-3", 360),
      readContractNode({}, "bad-4"),
      filler("f-5", 600),
    ];

    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `keep-571-large-bad-${Date.now()}`,
      triggerType: "manual",
      nodes: seedNodes,
      edges,
    });

    try {
      await page.goto(`/workflows/${workflow.id}`, {
        waitUntil: "domcontentloaded",
      });

      const response = await apiRequest.patch(`/api/workflows/${workflow.id}`, {
        data: { nodes, edges },
      });

      expect(response.status()).toBe(422);
      const responseBody = await response.json();
      expect(responseBody.error).toBe("INVALID_ACTION_CONFIG");
      expect(responseBody.invalidFields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "INVALID_FIELD_TYPE",
            path: "nodes[4].data.config.functionArgs",
            field: "functionArgs",
          }),
        ])
      );
    } finally {
      await deleteTestWorkflow(workflow.id);
    }
  });
});
