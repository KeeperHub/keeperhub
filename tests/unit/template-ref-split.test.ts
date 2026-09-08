import { describe, expect, it } from "vitest";
import { splitTemplateRef } from "@/lib/workflow/template-ref";

describe("splitTemplateRef", () => {
  it("keeps a dotted label intact and takes the field after it", () => {
    expect(
      splitTemplateRef(
        "check app.keeperhub.com.status",
        "check app.keeperhub.com"
      )
    ).toEqual({ label: "check app.keeperhub.com", fieldPath: "status" });
  });

  it("returns no field path when the ref is the dotted label alone", () => {
    expect(
      splitTemplateRef("check app.keeperhub.com", "check app.keeperhub.com")
    ).toEqual({ label: "check app.keeperhub.com", fieldPath: "" });
  });

  it("keeps nested field paths under a dotted label", () => {
    expect(
      splitTemplateRef("api.example.com.data.items[0].price", "api.example.com")
    ).toEqual({ label: "api.example.com", fieldPath: "data.items[0].price" });
  });

  it("splits on the first dot for an ordinary label", () => {
    expect(splitTemplateRef("HTTP Request.status", "HTTP Request")).toEqual({
      label: "HTTP Request",
      fieldPath: "status",
    });
  });

  it("falls back to the first dot when no label is known", () => {
    expect(splitTemplateRef("HTTP Request.data.value")).toEqual({
      label: "HTTP Request",
      fieldPath: "data.value",
    });
  });

  it("falls back to the first dot when the stored label is stale", () => {
    expect(splitTemplateRef("Old Name.status", "New Name")).toEqual({
      label: "Old Name",
      fieldPath: "status",
    });
  });

  it("returns an empty field path when there is no dot at all", () => {
    expect(splitTemplateRef("Trigger")).toEqual({
      label: "Trigger",
      fieldPath: "",
    });
  });

  it("does not treat a label that merely shares a prefix as a match", () => {
    expect(splitTemplateRef("HTTP Request.status", "HTTP")).toEqual({
      label: "HTTP Request",
      fieldPath: "status",
    });
  });
});
