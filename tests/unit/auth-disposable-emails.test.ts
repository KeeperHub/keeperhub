import { describe, expect, it } from "vitest";
import {
  disposableEmailBlocklistSize,
  isDisposableEmailDomain,
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
