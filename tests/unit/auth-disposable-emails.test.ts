import { describe, expect, it } from "vitest";
import {
  disposableEmailBlocklistSize,
  isDisposableEmailDomain,
  NEVER_BLOCKED_DOMAINS,
} from "@/lib/auth-disposable-emails";

describe("isDisposableEmailDomain", () => {
  it("blocks Mailinator", () => {
    expect(isDisposableEmailDomain("user@mailinator.com")).toBe(true);
  });

  it("blocks YOPmail", () => {
    expect(isDisposableEmailDomain("user@yopmail.com")).toBe(true);
  });

  it("blocks Guerrilla Mail variants", () => {
    expect(isDisposableEmailDomain("user@guerrillamail.com")).toBe(true);
    expect(isDisposableEmailDomain("user@sharklasers.com")).toBe(true);
  });

  it("blocks 10MinuteMail", () => {
    expect(isDisposableEmailDomain("user@10minutemail.com")).toBe(true);
  });

  it("blocks domains added in the refreshed vendored list", () => {
    expect(isDisposableEmailDomain("user@fldubai.com")).toBe(true);
    expect(isDisposableEmailDomain("user@euploading.com")).toBe(true);
  });

  it("blocks subdomains of a blocked domain", () => {
    expect(isDisposableEmailDomain("user@wfe.marchslurp.com")).toBe(true);
    expect(isDisposableEmailDomain("user@a.b.roomsranked.com")).toBe(true);
    expect(isDisposableEmailDomain("user@x1.arcadehearth.com")).toBe(true);
    expect(isDisposableEmailDomain("user@mx.mailinator.com")).toBe(true);
  });

  it("does not block a blocked domain's parent or a public suffix", () => {
    expect(isDisposableEmailDomain("user@com")).toBe(false);
    expect(isDisposableEmailDomain("user@mail.example.com")).toBe(false);
  });

  it("blocks catch-all burner domains served by temp-mail providers", () => {
    expect(isDisposableEmailDomain("user@9k3r.com")).toBe(true);
    expect(isDisposableEmailDomain("user@davopa.com")).toBe(true);
    expect(isDisposableEmailDomain("user@gonrr.net")).toBe(true);
  });

  it("never blocks mainstream providers", () => {
    for (const domain of NEVER_BLOCKED_DOMAINS) {
      expect(isDisposableEmailDomain(`user@${domain}`)).toBe(false);
    }
  });

  it("blocks aliasing services (privacy-proxy tier)", () => {
    expect(isDisposableEmailDomain("user@simplelogin.com")).toBe(true);
    expect(isDisposableEmailDomain("user@duck.com")).toBe(true);
    expect(isDisposableEmailDomain("user@mozmail.com")).toBe(true);
  });

  it("blocks regardless of casing in the email", () => {
    expect(isDisposableEmailDomain("USER@MAILINATOR.COM")).toBe(true);
    expect(isDisposableEmailDomain("User@Mailinator.Com")).toBe(true);
  });

  it("blocks domain regardless of +alias in local part", () => {
    expect(isDisposableEmailDomain("user+test@mailinator.com")).toBe(true);
    expect(isDisposableEmailDomain("user+anything@yopmail.com")).toBe(true);
  });

  it("allows legitimate provider domains", () => {
    expect(isDisposableEmailDomain("user@gmail.com")).toBe(false);
    expect(isDisposableEmailDomain("user@protonmail.com")).toBe(false);
    expect(isDisposableEmailDomain("user@keeperhub.com")).toBe(false);
    expect(isDisposableEmailDomain("user@techops.services")).toBe(false);
  });

  it("returns false for malformed inputs (no @, empty, leading/trailing @)", () => {
    expect(isDisposableEmailDomain("")).toBe(false);
    expect(isDisposableEmailDomain("not-an-email")).toBe(false);
    expect(isDisposableEmailDomain("@mailinator.com")).toBe(false);
    expect(isDisposableEmailDomain("user@")).toBe(false);
  });

  it("trims surrounding whitespace on the domain portion", () => {
    expect(isDisposableEmailDomain("user@ mailinator.com ")).toBe(true);
  });

  it("uses the last @ when the address contains multiple @ signs", () => {
    expect(isDisposableEmailDomain("weird@user@mailinator.com")).toBe(true);
  });

  it("does not block sibling domains that only share a substring", () => {
    expect(isDisposableEmailDomain("user@yopmail.com.example")).toBe(false);
    expect(isDisposableEmailDomain("user@keeperhub-mailinator.com")).toBe(
      false
    );
  });
});

describe("disposableEmailBlocklistSize", () => {
  it("loads the bundled fallback list and exceeds 1000 entries", () => {
    expect(disposableEmailBlocklistSize()).toBeGreaterThan(1000);
  });
});
