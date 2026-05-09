import { describe, expect, it } from "vitest";
import { formatUserTag, wsToHttpBase } from "../src/bridge.js";

describe("formatUserTag", () => {
  it("returns username only for pomelo accounts", () => {
    expect(formatUserTag({ username: "rhea", discriminator: "0" })).toBe("rhea");
  });

  it("preserves special characters for pomelo usernames", () => {
    expect(formatUserTag({ username: "user_name-123", discriminator: "0" })).toBe(
      "user_name-123",
    );
  });

  it("returns username#discriminator for legacy tags", () => {
    expect(formatUserTag({ username: "rhea", discriminator: "0420" })).toBe("rhea#0420");
  });

  it("treats discriminator 0000 as legacy", () => {
    expect(formatUserTag({ username: "rhea", discriminator: "0000" })).toBe("rhea#0000");
  });

  it("supports single-digit legacy discriminators", () => {
    expect(formatUserTag({ username: "rhea", discriminator: "1" })).toBe("rhea#1");
  });
});

describe("wsToHttpBase", () => {
  it("converts wss host ws path", () => {
    expect(wsToHttpBase("wss://muddown.example/ws")).toBe("https://muddown.example");
  });

  it("converts ws host ws trailing slash", () => {
    expect(wsToHttpBase("ws://muddown.example/ws/")).toBe("http://muddown.example");
  });

  it("converts nested api ws path", () => {
    expect(wsToHttpBase("wss://muddown.example/api/ws")).toBe("https://muddown.example/api");
  });

  it("preserves port when converting ws suffix", () => {
    expect(wsToHttpBase("wss://muddown.example:8080/ws")).toBe("https://muddown.example:8080");
  });

  it("does not rewrite /ws when it is not a suffix", () => {
    expect(wsToHttpBase("wss://muddown.example/ws/api")).toBe("https://muddown.example/ws/api");
  });

  it("passes through host without ws suffix", () => {
    expect(wsToHttpBase("wss://muddown.example")).toBe("https://muddown.example");
  });

  it("converts ws host with no path", () => {
    expect(wsToHttpBase("ws://muddown.example")).toBe("http://muddown.example");
  });

  it("does not rewrite non-ws suffix", () => {
    expect(wsToHttpBase("wss://muddown.example/websocket")).toBe("https://muddown.example/websocket");
  });
});
