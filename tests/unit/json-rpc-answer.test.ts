import { describe, expect, it } from "vitest";
import {
  classifyRpcError,
  parseJsonRpcAnswer,
} from "@/lib/web3/json-rpc-answer";

describe("parseJsonRpcAnswer", () => {
  it.each([
    ["non-JSON", "<html>"],
    ["an array", "[]"],
    ["a string", '"ok"'],
    ["null", "null"],
    ["empty text", ""],
  ])("reads %s as no answer", (_label, text) => {
    expect(parseJsonRpcAnswer(text)).toBeUndefined();
  });

  it("keeps the result and an object error", () => {
    expect(
      parseJsonRpcAnswer('{"jsonrpc":"2.0","id":1,"result":"0x1"}')
    ).toEqual({ result: "0x1" });
    expect(
      parseJsonRpcAnswer('{"error":{"code":-32602,"message":"Invalid params"}}')
    ).toEqual({
      result: undefined,
      error: { code: -32_602, message: "Invalid params" },
    });
  });

  it.each([
    ["null", "null", undefined],
    ["false", "false", undefined],
    ["zero", "0", undefined],
    ["an empty string", '""', undefined],
    ["a blank string", '"  "', undefined],
    ["a number", "7", undefined],
    ["true", "true", undefined],
    ["an array", "[1]", undefined],
    ["a string", '"boom"', { message: "boom" }],
    ["an object", '{"code":1}', { code: 1 }],
  ])("reads a %s error field", (_label, raw, expected) => {
    expect(parseJsonRpcAnswer(`{"error":${raw}}`)?.error).toEqual(expected);
  });

  it.each([
    ["0", "0"],
    ["an empty string", '""'],
    ["an array", "[1]"],
  ])("lets a valid result win over a %s error", (_label, raw) => {
    const hash = `0x${"a".repeat(64)}`;
    expect(parseJsonRpcAnswer(`{"error":${raw},"result":"${hash}"}`)).toEqual({
      result: hash,
    });
  });
});

describe("classifyRpcError", () => {
  it.each([
    [{ code: -32_603, message: "Invalid signature" }],
    [{ code: -32_000, message: "Internal Error" }],
    [{ message: "request timed out" }],
    [{ message: "upstream timeout" }],
    [{ message: "context deadline exceeded" }],
  ])("reads %j as unknown", (error) => {
    expect(classifyRpcError(error)).toBe("unknown");
  });

  it.each([
    [{ code: "-32603", message: "a string code" }],
    [{ code: " -32603 ", message: "a padded string code" }],
  ])("reads a string code like a number: %j is unknown", (error) => {
    expect(classifyRpcError(error)).toBe("unknown");
  });

  it.each([
    [{ code: -32_000, message: "bundle already known" }],
    [{ code: -32_000, message: "already known" }],
    [{ message: "AlreadyKnown" }],
    [{ message: "transaction already imported" }],
    [{ message: "duplicate bundle" }],
  ])("reads %j as accepted: the endpoint holds it", (error) => {
    expect(classifyRpcError(error)).toBe("accepted");
  });

  it.each([
    [{ code: -32_602, message: "Invalid params" }],
    [{ code: -32_000, message: "nonce too low" }],
    [{ code: -32_000, message: "unknown transaction type" }],
    [{ code: "", message: "an empty string code" }],
    [{ code: "abc", message: "a non-numeric code" }],
    [{}],
  ])("reads %j as refused", (error) => {
    expect(classifyRpcError(error)).toBe("refused");
  });
});
