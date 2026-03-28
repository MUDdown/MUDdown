import type {
  BlockAttributes,
  BlockType,
  GameLink,
  LinkScheme,
  MUDdownBlock,
} from "@muddown/shared";

// ─── Regex Patterns ──────────────────────────────────────────────────────────

const BLOCK_OPEN = /^:::(\w[\w-]*)\{([^}]*)\}\s*$/;
const BLOCK_OPEN_NO_ATTRS = /^:::(\w[\w-]*)\s*$/;
const BLOCK_CLOSE = /^:::\s*$/;
// \S+? (not \w+) is intentional: supports unquoted values containing
// hyphens, dots, colons, and slashes (e.g. timestamps, semver strings).
const ATTR_PAIR = /(\w[\w-]*)=(?:"([^"]*)"|(\S+?)(?=\s|$))/g;
const GAME_LINK = /\[([^\]]+)\]\((\w+):([^)]*)\)/g;
const H2_HEADING = /^## (.+)$/;

const VALID_SCHEMES = new Set<string>(["cmd", "go", "item", "npc", "player", "help", "url"]);

// ─── Attribute Parsing ───────────────────────────────────────────────────────

export function parseAttributes(raw: string): BlockAttributes {
  const attrs: BlockAttributes = {};
  let match: RegExpExecArray | null;

  ATTR_PAIR.lastIndex = 0;
  while ((match = ATTR_PAIR.exec(raw)) !== null) {
    const key = match[1];
    const value = match[2] ?? match[3];

    // Validate unquoted values — reject characters that indicate malformed input
    if (match[3] !== undefined && /[="{}]/.test(match[3])) {
      throw new Error(
        `Invalid unquoted attribute value for key "${key}" in: ${raw}`
      );
    }

    if (value === "true") attrs[key] = true;
    else if (value === "false") attrs[key] = false;
    else if (/^\d+(\.\d+)?$/.test(value)) attrs[key] = Number(value);
    else attrs[key] = value;
  }

  return attrs;
}

// ─── Link Extraction ─────────────────────────────────────────────────────────

export function extractLinks(content: string): GameLink[] {
  const links: GameLink[] = [];
  let match: RegExpExecArray | null;

  GAME_LINK.lastIndex = 0;
  while ((match = GAME_LINK.exec(content)) !== null) {
    const scheme = match[2];
    if (VALID_SCHEMES.has(scheme)) {
      links.push({
        displayText: match[1],
        scheme: scheme as LinkScheme,
        target: match[3],
      });
    }
  }

  return links;
}

// ─── Section Parsing ─────────────────────────────────────────────────────────

export function parseSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = content.split("\n");
  let currentSection: string | null = null;
  let sectionLines: string[] = [];

  for (const line of lines) {
    const heading = H2_HEADING.exec(line);
    if (heading) {
      if (currentSection !== null) {
        sections[currentSection] = sectionLines.join("\n").trim();
      }
      currentSection = heading[1];
      sectionLines = [];
    } else if (currentSection !== null) {
      sectionLines.push(line);
    }
  }

  if (currentSection !== null) {
    sections[currentSection] = sectionLines.join("\n").trim();
  }

  return sections;
}

// ─── Block Parser ────────────────────────────────────────────────────────────

export function parseBlocks(input: string): MUDdownBlock[] {
  const blocks: MUDdownBlock[] = [];
  const lines = input.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let openMatch = BLOCK_OPEN.exec(line);
    let blockType: string | null = null;
    let attrs: BlockAttributes = {};

    if (openMatch) {
      blockType = openMatch[1];
      attrs = parseAttributes(openMatch[2]);
    } else {
      const noAttrMatch = BLOCK_OPEN_NO_ATTRS.exec(line);
      if (noAttrMatch) {
        blockType = noAttrMatch[1];
      }
    }

    if (blockType) {
      const openLine = i;
      const contentLines: string[] = [];
      i++;
      while (i < lines.length && !BLOCK_CLOSE.test(lines[i])) {
        contentLines.push(lines[i]);
        i++;
      }
      if (i >= lines.length) {
        throw new Error(
          `Unclosed :::${blockType} block opened at line ${openLine + 1}`
        );
      }
      // skip the closing :::
      i++;

      const content = contentLines.join("\n");
      blocks.push({
        type: blockType as BlockType,
        attributes: attrs,
        content,
        sections: parseSections(content),
        links: extractLinks(content),
      });
    } else {
      i++;
    }
  }

  return blocks;
}

// ─── Full Document Parser ────────────────────────────────────────────────────

export interface MUDdownDocument {
  frontmatter: Record<string, string>;
  blocks: MUDdownBlock[];
  raw: string;
}

export function parse(input: string): MUDdownDocument {
  let frontmatter: Record<string, string> = {};
  let body = input;

  // Parse YAML frontmatter
  if (input.startsWith("---\n")) {
    const endIndex = input.indexOf("\n---\n", 4);
    if (endIndex !== -1) {
      const yamlBlock = input.slice(4, endIndex);
      frontmatter = parseYamlSimple(yamlBlock);
      body = input.slice(endIndex + 5);
    }
  }

  return {
    frontmatter,
    blocks: parseBlocks(body),
    raw: input,
  };
}

/**
 * Minimal line-by-line YAML parser. Uses the first colon as the
 * key/value separator. Returns all values as strings (no type
 * coercion). Does not support YAML lists or multiline values.
 */
function parseYamlSimple(yaml: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      result[key] = value;
    }
  }
  return result;
}
