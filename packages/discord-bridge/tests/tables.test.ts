import { describe, expect, it } from "vitest";

import { rewriteTables } from "../src/tables.js";

describe("rewriteTables", () => {
  it("flattens a 2-column table into a bullet list", () => {
    const input = [
      "# Commands",
      "",
      "| Command | Description |",
      "|---------|-------------|",
      "| look | Examine your surroundings. |",
      "| go | Move in a direction. |",
      "",
      "Pick one.",
    ].join("\n");
    const expected = [
      "# Commands",
      "",
      "- **look** — Examine your surroundings.",
      "- **go** — Move in a direction.",
      "",
      "Pick one.",
    ].join("\n");
    expect(rewriteTables(input)).toBe(expected);
  });

  it("renders 3+ column tables as a padded code block", () => {
    const input = [
      "| Name | Slot | Weight |",
      "| --- | --- | --- |",
      "| sword | weapon | 3 |",
      "| helm | armor | 2 |",
    ].join("\n");
    const output = rewriteTables(input);
    expect(output.startsWith("```\n")).toBe(true);
    expect(output.endsWith("\n```")).toBe(true);
    expect(output).toContain("Name   Slot    Weight");
    expect(output).toContain("sword  weapon  3");
    expect(output).toContain("helm   armor   2");
  });

  it("ignores alignment markers in the separator row", () => {
    const input = [
      "| A | B |",
      "|:--|--:|",
      "| 1 | 2 |",
    ].join("\n");
    expect(rewriteTables(input)).toBe("- **1** — 2");
  });

  it("leaves non-table pipe-like text untouched", () => {
    const input = "Choose | one | of these.";
    expect(rewriteTables(input)).toBe(input);
  });

  it("leaves a header+separator with no body rows untouched", () => {
    const input = ["| A | B |", "| --- | --- |"].join("\n");
    expect(rewriteTables(input)).toBe(input);
  });

  it("abandons rewrite when a body row has the wrong cell count", () => {
    const input = [
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "| only-one-cell |",
    ].join("\n");
    // First row is malformed → entire block left untouched.
    expect(rewriteTables(input)).toBe(input);
  });

  it("handles empty trailing cells in 2-column rows", () => {
    const input = [
      "| Key | Value |",
      "| --- | --- |",
      "| solo |  |",
    ].join("\n");
    expect(rewriteTables(input)).toBe("- **solo**");
  });

  it("processes multiple tables in the same body", () => {
    const input = [
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "Between.",
      "",
      "| X | Y |",
      "| --- | --- |",
      "| 3 | 4 |",
    ].join("\n");
    const expected = [
      "- **1** — 2",
      "",
      "Between.",
      "",
      "- **3** — 4",
    ].join("\n");
    expect(rewriteTables(input)).toBe(expected);
  });
});
