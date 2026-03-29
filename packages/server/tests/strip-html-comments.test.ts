import { describe, it, expect } from "vitest";
import { stripHtmlComments } from "../src/helpers.js";

describe("stripHtmlComments", () => {
  it("removes a single-line HTML comment", () => {
    expect(stripHtmlComments("before <!-- comment --> after")).toBe(
      "before  after",
    );
  });

  it("removes a multi-line HTML comment", () => {
    const input = "start\n<!-- multi\nline\ncomment -->\nend";
    expect(stripHtmlComments(input)).toBe("start\nend");
  });

  it("removes multiple comments", () => {
    const input = "a <!-- one --> b <!-- two --> c";
    expect(stripHtmlComments(input)).toBe("a  b  c");
  });

  it("removes comment followed by a newline", () => {
    const input = "## Exits\n\n<!-- Static note -->\n## Present";
    expect(stripHtmlComments(input)).toBe("## Exits\n\n## Present");
  });

  it("removes comment followed by CRLF", () => {
    const input = "## Exits\r\n\r\n<!-- Static note -->\r\n## Present";
    expect(stripHtmlComments(input)).toBe("## Exits\r\n\r\n## Present");
  });

  it("returns text unchanged when no comments present", () => {
    const input = "# Room\nNo comments here.";
    expect(stripHtmlComments(input)).toBe(input);
  });

  it("returns empty string for empty input", () => {
    expect(stripHtmlComments("")).toBe("");
  });

  it("removes comment at the very start", () => {
    expect(stripHtmlComments("<!--start-->text")).toBe("text");
  });

  it("removes comment at the very end", () => {
    expect(stripHtmlComments("text<!--end-->")).toBe("text");
  });

  it("leaves unclosed comment intact", () => {
    const input = "text <!-- unclosed";
    expect(stripHtmlComments(input)).toBe(input);
  });

  it("does not remove angle brackets that are not comments", () => {
    const input = "a < b and c > d";
    expect(stripHtmlComments(input)).toBe(input);
  });
});
