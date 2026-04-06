import { describe, it, expect } from "vitest";
import { buildWsUrl } from "../src/connection.js";

describe("buildWsUrl", () => {
  it("converts http to ws", () => {
    expect(buildWsUrl("http://localhost:3300")).toBe("ws://localhost:3300/ws");
  });

  it("converts https to wss", () => {
    expect(buildWsUrl("https://example.com")).toBe("wss://example.com/ws");
  });

  it("accepts a custom path", () => {
    expect(buildWsUrl("http://localhost:3300", "/game")).toBe("ws://localhost:3300/game");
  });

  it("preserves port in the URL", () => {
    expect(buildWsUrl("http://localhost:8080")).toBe("ws://localhost:8080/ws");
  });

  it("ignores input path and uses only host", () => {
    expect(buildWsUrl("http://localhost:3300/api")).toBe("ws://localhost:3300/ws");
  });

  it("ignores trailing slash on input", () => {
    expect(buildWsUrl("http://localhost:8080/")).toBe("ws://localhost:8080/ws");
  });

  it("throws on invalid URL input", () => {
    expect(() => buildWsUrl("not-a-url")).toThrow();
  });
});
