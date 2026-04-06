import { describe, it, expect } from "vitest";
import { extractNarrativeDescription } from "../src/helpers.js";

describe("extractNarrativeDescription", () => {
  it("extracts the narrative paragraph between title and first section", () => {
    const muddown = `:::room{id="test" region="test" lighting="bright"}
# Town Square

A bustling cobblestone square at the heart of Northkeep.

## Exits
- [North](go:north) — The Iron Gate
:::`;

    const result = extractNarrativeDescription(muddown);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("A bustling cobblestone square at the heart of Northkeep.");
    expect(muddown.substring(result!.startIdx, result!.endIdx).trim()).toBe(result!.text);
  });

  it("handles multi-line descriptions", () => {
    const muddown = `:::room{id="test" region="test" lighting="bright"}
# Deep Forest

Ancient trees tower overhead, their branches intertwining to form
a dense canopy that blocks most of the sunlight. The air is thick
with the scent of moss and decay.

## Exits
- [South](go:south)
:::`;

    const result = extractNarrativeDescription(muddown);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Ancient trees tower overhead");
    expect(result!.text).toContain("moss and decay");
  });

  it("returns null when there is no title", () => {
    const muddown = `No title here, just text.

## Exits
- [North](go:north)`;

    expect(extractNarrativeDescription(muddown)).toBeNull();
  });

  it("returns null when there is no section header after title", () => {
    const muddown = `# Room Title

Just a description with no sections.`;

    expect(extractNarrativeDescription(muddown)).toBeNull();
  });

  it("returns null when there is no text between title and first section", () => {
    const muddown = `# Room Title
## Exits
- [North](go:north)`;

    expect(extractNarrativeDescription(muddown)).toBeNull();
  });

  it("preserves indices for accurate replacement", () => {
    const muddown = `:::room{id="test" region="test" lighting="bright"}
# Test Room

Description here.

## Exits
- Links
:::`;

    const result = extractNarrativeDescription(muddown);
    expect(result).not.toBeNull();

    // Verify we can splice the description out and back in
    const replaced = muddown.substring(0, result!.startIdx)
      + "\n\nNew description.\n"
      + muddown.substring(result!.endIdx);
    expect(replaced).toContain("New description.");
    expect(replaced).not.toContain("Description here.");
    expect(replaced).toContain("# Test Room");
    expect(replaced).toContain("## Exits");
  });

  it("handles CRLF line endings", () => {
    const muddown = ":::room{id=\"test\" region=\"test\" lighting=\"bright\"}\r\n# Town Square\r\n\r\nA bustling square.\r\n\r\n## Exits\r\n- [North](go:north)\r\n:::";

    const result = extractNarrativeDescription(muddown);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("A bustling square.");
  });
});
