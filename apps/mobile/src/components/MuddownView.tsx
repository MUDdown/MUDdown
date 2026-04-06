import React, { useMemo } from "react";
import { View, Text, Linking, Alert, StyleSheet } from "react-native";
import type { ReactNode } from "react";
import { colors } from "../theme.js";

interface MuddownViewProps {
  muddown: string;
  onGameLink?: (scheme: string, target: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Inline formatting                                                 */
/* ------------------------------------------------------------------ */

/**
 * Combined regex that captures inline Markdown formatting tokens.
 *
 * Match groups:
 *   1 = bold text            **bold**
 *   2 = italic text          *italic*
 *   3 = code text            `code`
 *   4 = link display text    [text](...)
 *   5 = game scheme          cmd|go|item|npc|player|help
 *   6 = game target          the part after scheme:
 *   7 = link display text    [text](https://...)
 *   8 = external URL
 */
const INLINE_RE =
  /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\((cmd|go|item|npc|player|help):([^)]*)\)|\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;

function parseInline(
  text: string,
  onGameLink?: (scheme: string, target: string) => void,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  // Reset the regex state before each parse
  INLINE_RE.lastIndex = 0;

  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(
        <Text key={key++}>{text.slice(lastIndex, match.index)}</Text>,
      );
    }

    if (match[1] != null) {
      // Bold
      nodes.push(
        <Text key={key++} style={styles.bold}>
          {match[1]}
        </Text>,
      );
    } else if (match[2] != null) {
      // Italic
      nodes.push(
        <Text key={key++} style={styles.italic}>
          {match[2]}
        </Text>,
      );
    } else if (match[3] != null) {
      // Inline code
      nodes.push(
        <Text key={key++} style={styles.code}>
          {match[3]}
        </Text>,
      );
    } else if (match[4] != null && match[5] != null) {
      // Game link
      const scheme = match[5];
      const target = match[6] ?? "";
      nodes.push(
        <Text
          key={key++}
          style={styles.gameLink}
          onPress={() => onGameLink?.(scheme, target)}
          accessibilityRole="link"
          accessibilityLabel={match[4]}
        >
          {match[4]}
        </Text>,
      );
    } else if (match[7] != null && match[8] != null) {
      // External link
      const url = match[8];
      nodes.push(
        <Text
          key={key++}
          style={styles.externalLink}
          onPress={() => {
            Linking.openURL(url).catch((err) => {
              console.error("[MuddownView] Failed to open URL", url, err);
              Alert.alert("Error", "Could not open this link.");
            });
          }}
          accessibilityRole="link"
        >
          {match[7]}
        </Text>,
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(<Text key={key++}>{text.slice(lastIndex)}</Text>);
  }

  return nodes;
}

/* ------------------------------------------------------------------ */
/*  Block-level rendering                                             */
/* ------------------------------------------------------------------ */

/** Represents a parsed block from the MUDdown source. */
type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "list-item"; text: string }
  | { kind: "blockquote"; text: string }
  | { kind: "table-row"; cells: string[] }
  | { kind: "paragraph"; text: string }
  | { kind: "blank" };

function parseBlocks(muddown: string): Block[] {
  // Strip container block fences
  const stripped = muddown
    .replace(/^:::[\w-]+\{[^}]*\}\s*$/gm, "")
    .replace(/^:::[\w-]+\s*$/gm, "")
    .replace(/^:::\s*$/gm, "")
    .trim();

  const lines = stripped.split("\n");
  const blocks: Block[] = [];

  for (const raw of lines) {
    if (raw.trim() === "") {
      blocks.push({ kind: "blank" });
    } else if (raw.match(/^#{1,3} /)) {
      const level = raw.match(/^(#+)/)?.[1].length ?? 1;
      const text = raw.replace(/^#{1,3} /, "");
      blocks.push({ kind: "heading", level, text });
    } else if (raw.startsWith("- ")) {
      blocks.push({ kind: "list-item", text: raw.slice(2) });
    } else if (raw.startsWith("> ")) {
      blocks.push({ kind: "blockquote", text: raw.slice(2) });
    } else if (raw.trimStart().startsWith("|") && raw.trimEnd().endsWith("|")) {
      // Skip separator rows like |---|---|
      if (raw.match(/^\|[\s\-:|]+\|$/)) continue;
      const cells = raw
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      blocks.push({ kind: "table-row", cells });
    } else {
      blocks.push({ kind: "paragraph", text: raw });
    }
  }

  return blocks;
}

function renderBlock(
  block: Block,
  key: number,
  onGameLink?: (scheme: string, target: string) => void,
): ReactNode {
  switch (block.kind) {
    case "blank":
      return <View key={key} style={styles.spacer} />;

    case "heading":
      return (
        <Text
          key={key}
          style={[
            styles.heading,
            block.level === 1 && styles.h1,
            block.level === 2 && styles.h2,
            block.level === 3 && styles.h3,
          ]}
          accessibilityRole="header"
        >
          {parseInline(block.text, onGameLink)}
        </Text>
      );

    case "list-item":
      return (
        <View key={key} style={styles.listItem}>
          <Text style={styles.bullet}>•</Text>
          <Text style={styles.listText}>
            {parseInline(block.text, onGameLink)}
          </Text>
        </View>
      );

    case "blockquote":
      return (
        <View key={key} style={styles.blockquote}>
          <Text style={styles.blockquoteText}>
            {parseInline(block.text, onGameLink)}
          </Text>
        </View>
      );

    case "table-row":
      return (
        <View key={key} style={styles.tableRow}>
          {block.cells.map((cell, i) => (
            <Text key={i} style={styles.tableCell}>
              {parseInline(cell, onGameLink)}
            </Text>
          ))}
        </View>
      );

    case "paragraph":
      return (
        <Text key={key} style={styles.paragraph}>
          {parseInline(block.text, onGameLink)}
        </Text>
      );
  }
}

/* ------------------------------------------------------------------ */
/*  Public component                                                  */
/* ------------------------------------------------------------------ */

export function MuddownView({ muddown, onGameLink }: MuddownViewProps) {
  const blocks = useMemo(() => parseBlocks(muddown), [muddown]);

  return (
    <View style={styles.container}>
      {blocks.map((block, i) => renderBlock(block, i, onGameLink))}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                            */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  container: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  spacer: {
    height: 8,
  },

  // Headings
  heading: {
    color: colors.heading,
    fontWeight: "bold",
    marginTop: 8,
    marginBottom: 4,
  },
  h1: { fontSize: 20 },
  h2: { fontSize: 17 },
  h3: { fontSize: 15 },

  // Paragraphs
  paragraph: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
    marginVertical: 2,
  },

  // Lists
  listItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginVertical: 1,
    paddingLeft: 8,
  },
  bullet: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 22,
    marginRight: 6,
  },
  listText: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
    flex: 1,
  },

  // Blockquotes
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: colors.blockquoteBorder,
    paddingLeft: 10,
    marginVertical: 4,
  },
  blockquoteText: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 22,
    fontStyle: "italic",
  },

  // Tables
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingVertical: 4,
  },
  tableCell: {
    flex: 1,
    color: colors.text,
    fontSize: 14,
    paddingHorizontal: 4,
  },

  // Inline styles
  bold: {
    fontWeight: "bold",
    color: colors.bold,
  },
  italic: {
    fontStyle: "italic",
    color: colors.italic,
  },
  code: {
    fontFamily: "monospace",
    backgroundColor: colors.codeBg,
    color: colors.code,
    paddingHorizontal: 3,
    borderRadius: 3,
  },
  gameLink: {
    color: colors.link,
    textDecorationLine: "underline",
  },
  externalLink: {
    color: colors.link,
    textDecorationLine: "underline",
  },
});
