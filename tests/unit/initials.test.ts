import { describe, expect, it } from "vitest";
import {
  getInitials,
  getOrganizationLabel,
  getPersonInitials,
} from "@/lib/initials";

describe("getInitials", () => {
  it("takes the first letter of the first two words", () => {
    expect(getInitials("Acme Labs")).toBe("AL");
    expect(getInitials("Sandbox for TechOps")).toBe("SF");
  });

  it("uses one letter for a one-word name", () => {
    expect(getInitials("Personal")).toBe("P");
  });

  it("upper-cases and ignores extra spaces", () => {
    expect(getInitials("  defi   ops ")).toBe("DO");
  });

  it("keeps a character made of two code units whole", () => {
    expect(getInitials("𝔸cme labs")).toBe("𝔸L");
  });

  it("keeps a flag or an emoji sequence whole", () => {
    expect(getInitials("🇺🇸 Team")).toBe("🇺🇸T");
    expect(getInitials("👩‍💻 Devs")).toBe("👩‍💻D");
  });

  it("keeps an accent typed as a separate mark on its letter", () => {
    expect(getInitials("e\u0301cole Labs")).toBe("E\u0301L");
  });

  it("leaves a letter whose upper case is two letters as it is", () => {
    expect(getInitials("ßeta Labs")).toBe("ßL");
  });

  it("falls back to a question mark for an empty name", () => {
    expect(getInitials("   ")).toBe("?");
  });
});

describe("getOrganizationLabel", () => {
  it("adds the initials to a name of several words", () => {
    expect(getOrganizationLabel("Acme Labs")).toBe("Acme Labs (AL)");
  });

  it("adds them even when the name starts with the same letters", () => {
    // The button shows "AL"; voice control matches words, not letters.
    expect(getOrganizationLabel("Alpha Labs")).toBe("Alpha Labs (AL)");
    expect(getOrganizationLabel("Ethan Test")).toBe("Ethan Test (ET)");
  });

  it("leaves a one-word name as it is", () => {
    expect(getOrganizationLabel("Personal")).toBe("Personal");
    expect(getOrganizationLabel("AB")).toBe("AB");
  });

  it("trims the name", () => {
    expect(getOrganizationLabel("  Personal ")).toBe("Personal");
    expect(getOrganizationLabel(" Acme  Labs ")).toBe("Acme  Labs (AL)");
  });

  it("falls back to the initials' question mark for an empty name", () => {
    expect(getOrganizationLabel("   ")).toBe("?");
  });
});

describe("getPersonInitials", () => {
  it("uses the name's initials, as everywhere else", () => {
    expect(getPersonInitials({ name: "Mary Jane Smith" })).toBe("MJ");
  });

  it("falls back to the email's first character", () => {
    expect(getPersonInitials({ name: "  ", email: "jo@example.com" })).toBe(
      "J"
    );
    expect(getPersonInitials({ email: "jo@example.com" })).toBe("J");
  });

  it("is a question mark with neither", () => {
    expect(getPersonInitials(null)).toBe("?");
    expect(getPersonInitials({ name: null, email: "" })).toBe("?");
  });
});
