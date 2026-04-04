import { describe, it, expect } from "vitest";
import { certificationFromResult, type ComplianceCheckResult } from "../src/compliance.js";

function makeResult(overrides: Partial<ComplianceCheckResult> = {}): ComplianceCheckResult {
  return {
    checkedAt: new Date().toISOString(),
    reachable: false,
    wireProtocol: false,
    containerBlocks: false,
    errors: [],
    ...overrides,
  };
}

describe("certificationFromResult", () => {
  it("returns verified when all checks pass", () => {
    const result = makeResult({ reachable: true, wireProtocol: true, containerBlocks: true });
    expect(certificationFromResult(result, "listed")).toBe("verified");
    expect(certificationFromResult(result, "self-certified")).toBe("verified");
    expect(certificationFromResult(result, "verified")).toBe("verified");
  });

  it("downgrades verified to self-certified when checks fail", () => {
    const result = makeResult({ reachable: true, wireProtocol: true, containerBlocks: false });
    expect(certificationFromResult(result, "verified")).toBe("self-certified");
  });

  it("keeps listed tier when unreachable", () => {
    const result = makeResult({ reachable: false });
    expect(certificationFromResult(result, "listed")).toBe("listed");
  });

  it("keeps self-certified tier when unreachable", () => {
    const result = makeResult({ reachable: false });
    expect(certificationFromResult(result, "self-certified")).toBe("self-certified");
  });

  it("keeps self-certified tier when only partially passing", () => {
    const result = makeResult({ reachable: true, wireProtocol: false });
    expect(certificationFromResult(result, "self-certified")).toBe("self-certified");
  });

  it("keeps listed when missing wire protocol", () => {
    const result = makeResult({ reachable: true, wireProtocol: false, containerBlocks: false });
    expect(certificationFromResult(result, "listed")).toBe("listed");
  });

  it("keeps listed when missing container blocks", () => {
    const result = makeResult({ reachable: true, wireProtocol: true, containerBlocks: false });
    expect(certificationFromResult(result, "listed")).toBe("listed");
  });

  it("downgrades verified to self-certified when server is unreachable", () => {
    const result = makeResult({ reachable: false });
    expect(certificationFromResult(result, "verified")).toBe("self-certified");
  });
});
