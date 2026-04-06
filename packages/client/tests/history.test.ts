import { describe, it, expect } from "vitest";
import { CommandHistory } from "../src/history.js";

describe("CommandHistory", () => {
  it("starts with an empty history", () => {
    const h = new CommandHistory();
    expect(h.all()).toEqual([]);
    expect(h.cursor).toBe(-1);
  });

  it("up returns null when history is empty", () => {
    const h = new CommandHistory();
    expect(h.up()).toBeNull();
    expect(h.cursor).toBe(-1);
  });

  it("push adds commands to the front", () => {
    const h = new CommandHistory();
    h.push("first");
    h.push("second");
    expect(h.all()).toEqual(["second", "first"]);
  });

  it("up moves through older entries", () => {
    const h = new CommandHistory();
    h.push("a");
    h.push("b");
    h.push("c");
    expect(h.up()).toBe("c");
    expect(h.up()).toBe("b");
    expect(h.up()).toBe("a");
    expect(h.up()).toBeNull(); // past the oldest
  });

  it("down moves toward newer entries", () => {
    const h = new CommandHistory();
    h.push("a");
    h.push("b");
    h.up(); // → "b"
    h.up(); // → "a"
    expect(h.down()).toBe("b");
  });

  it("down returns null when past the newest entry", () => {
    const h = new CommandHistory();
    h.push("a");
    h.up(); // → "a"
    expect(h.down()).toBeNull(); // index was 0 → reset to -1
  });

  it("down returns null when already at no selection", () => {
    const h = new CommandHistory();
    h.push("a");
    expect(h.down()).toBeNull(); // cursor already -1
  });

  it("push resets the cursor", () => {
    const h = new CommandHistory();
    h.push("a");
    h.push("b");
    h.up(); // → "b"
    h.push("c"); // resets cursor
    expect(h.cursor).toBe(-1);
    expect(h.up()).toBe("c");
  });

  it("reset clears cursor without clearing entries", () => {
    const h = new CommandHistory();
    h.push("a");
    h.up();
    expect(h.cursor).toBe(0);
    h.reset();
    expect(h.cursor).toBe(-1);
    expect(h.all()).toEqual(["a"]);
  });

  it("ignores empty and whitespace-only commands", () => {
    const h = new CommandHistory();
    h.push("");
    h.push("   ");
    h.push("\t\n");
    expect(h.all()).toEqual([]);
  });

  it("skips consecutive duplicate commands", () => {
    const h = new CommandHistory();
    h.push("go north");
    h.push("go north");
    h.push("go north");
    expect(h.all()).toEqual(["go north"]);
  });

  it("allows non-consecutive duplicates", () => {
    const h = new CommandHistory();
    h.push("go north");
    h.push("look");
    h.push("go north");
    expect(h.all()).toEqual(["go north", "look", "go north"]);
  });

  it("caps history at 200 entries", () => {
    const h = new CommandHistory();
    for (let i = 0; i < 250; i++) h.push(`cmd-${i}`);
    expect(h.all().length).toBe(200);
    expect(h.all()[0]).toBe("cmd-249");
    expect(h.all()[199]).toBe("cmd-50");
  });
});
