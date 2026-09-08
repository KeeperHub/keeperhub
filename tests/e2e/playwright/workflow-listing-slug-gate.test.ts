import { expect, test } from "./fixtures";
import {
  createTestWorkflow,
  deleteTestWorkflow,
  PERSISTENT_TEST_USER_EMAIL,
} from "./utils/db";

// Full HTTP-path verification of the marketplace slug gate. A listed workflow
// must always carry a slug — external agents invoke it by slug at
// /api/mcp/workflows/<slug>/call, so a listed-but-slugless row is discoverable
// in the catalog yet uncallable. Driven through the real PATCH route with an
// authenticated session (apiRequest fixture), the same way the editor's
// listing overlay saves: a body carrying isListed + listedSlug.
test.describe("marketplace slug gate (full HTTP path)", () => {
  test("PATCH isListed without a slug is refused; with a slug it lists; editing while listed still saves", async ({
    apiRequest,
  }) => {
    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `keep-494-slug-gate-${Date.now()}`,
      triggerType: "manual",
    });

    try {
      // 1. List with no slug -> 422 SLUG_REQUIRED. This is the orphaned-row bug:
      //    previously this PATCH would have produced a listed row with a null
      //    slug (discoverable but uncallable).
      const noSlug = await apiRequest.patch(`/api/workflows/${workflow.id}`, {
        data: { isListed: true, inputSchema: { type: "object" } },
      });
      const noSlugBody = await noSlug.text();
      expect(
        noSlug.status(),
        `expected 422 SLUG_REQUIRED, got body: ${noSlugBody}`
      ).toBe(422);
      expect(JSON.parse(noSlugBody).error).toBe("SLUG_REQUIRED");

      // 2. List with a slug -> 200, isListed=true, slug persisted.
      const slug = `keep-494-e2e-${Date.now()}`;
      const withSlug = await apiRequest.patch(`/api/workflows/${workflow.id}`, {
        data: {
          isListed: true,
          listedSlug: slug,
          inputSchema: { type: "object" },
        },
      });
      const withSlugBody = await withSlug.text();
      expect(withSlug.status(), `expected 200, got body: ${withSlugBody}`).toBe(
        200
      );
      const listed = JSON.parse(withSlugBody);
      expect(listed.isListed).toBe(true);
      expect(listed.listedSlug).toBe(slug);

      // 3. Edit the now-listed workflow without re-sending the slug -> still
      //    200. The sticky slug carries through, proving the gate does not
      //    falsely reject normal edits of an already-listed workflow.
      const reEdit = await apiRequest.patch(`/api/workflows/${workflow.id}`, {
        data: { description: "edited while listed" },
      });
      const reEditBody = await reEdit.text();
      expect(
        reEdit.status(),
        `expected 200 on edit-while-listed, got body: ${reEditBody}`
      ).toBe(200);
      const edited = JSON.parse(reEditBody);
      expect(edited.isListed).toBe(true);
      expect(edited.listedSlug).toBe(slug);
    } finally {
      await deleteTestWorkflow(workflow.id);
    }
  });
});
