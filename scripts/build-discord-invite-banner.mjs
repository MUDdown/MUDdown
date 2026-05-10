// Builds the 1024x576 Discord Rich Presence "Invite Image" banner.
// Output: apps/desktop/src-tauri/icons/discord-invite-banner.png
//
// Uses the canonical MUDdown palette and logo mark from
// apps/website/src/layouts/Base.astro:
//   bg:           #0a0e14
//   accent:       #5ccfe6
//   text-bright:  #e8eef4
//   text-dim:     #6e7a88
//   logo box:     rounded square (rx=64 on 512), #Md text in JetBrains Mono Bold
//
// Font dependencies (referenced by the SVG <text> elements below):
//   - "JetBrains Mono" (mark "#Md") — falls back to Menlo / Courier New / monospace.
//   - "Inter" (wordmark + tagline) — falls back to Helvetica Neue / Helvetica /
//     Arial / system-ui / sans-serif.
// Sharp rasterizes the SVG with whatever fonts are installed on the host. For
// reproducible builds, install JetBrains Mono and Inter system-wide (or via a
// CI font-cache step). With only the fallbacks present the banner still renders
// but glyph metrics will drift slightly from the canonical output.
//
// Run: node scripts/build-discord-invite-banner.mjs
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = resolve(__dirname, "../apps/desktop/src-tauri/icons/discord-invite-banner.png");

const W = 1024;
const H = 576;

// Logo mark sits left of the wordmark. 280 px square, vertically centered,
// horizontal group centered within the canvas.
const MARK = 220;
const GAP = 32;
// "MUDdown" rendered in bold sans-serif. The font-size below is the source
// of truth; WORDMARK_W is just used for centering the lockup.
const FONT_SIZE = 130;
const WORDMARK_W = 500; // empirical at FONT_SIZE=130, system bold

const groupW = MARK + GAP + WORDMARK_W;
const groupX = Math.round((W - groupW) / 2);
// Pull the lockup up slightly to leave breathing room for the tagline below.
const LOCKUP_VERTICAL_NUDGE = 24;
const groupY = Math.round((H - MARK) / 2) - LOCKUP_VERTICAL_NUDGE;

const markX = groupX;
const markY = groupY;
const wordX = markX + MARK + GAP;
// SVG text y is the baseline. Center the cap-height visually with the mark:
// approximate cap-height ~ 0.72 * font-size; mark center is at markY + MARK/2.
const wordY = markY + MARK / 2 + Math.round(FONT_SIZE * 0.36);

// Vertical gap between the bottom of the logo mark and the tagline baseline.
const TAGLINE_SPACING = 56;
const taglineY = groupY + MARK + TAGLINE_SPACING;

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#0a0e14"/>

  <!-- Logo mark: rounded square with #Md -->
  <g transform="translate(${markX},${markY})">
    <rect width="${MARK}" height="${MARK}" rx="${Math.round(MARK * 64 / 512)}" fill="#5ccfe6"/>
    <text x="${MARK / 2}" y="${MARK / 2}"
          text-anchor="middle" dominant-baseline="central"
          font-family="'JetBrains Mono', 'Menlo', 'Courier New', monospace"
          font-weight="700"
          font-size="${Math.round(MARK * 280 / 512)}"
          fill="#0a0e14">#Md</text>
  </g>

  <!-- Wordmark: MUD (accent) + down (bright) -->
  <text x="${wordX}" y="${wordY}"
        font-family="'Inter', 'Helvetica Neue', 'Helvetica', 'Arial', system-ui, sans-serif"
        font-weight="700"
        font-size="${FONT_SIZE}"
        letter-spacing="-2">
    <tspan fill="#5ccfe6">MUD</tspan><tspan fill="#e8eef4">down</tspan>
  </text>

  <!-- Tagline, centered horizontally beneath the lockup -->
  <text x="${W / 2}" y="${taglineY}"
        text-anchor="middle"
        font-family="'Inter', 'Helvetica Neue', 'Helvetica', 'Arial', system-ui, sans-serif"
        font-weight="400"
        font-size="32"
        fill="#6e7a88"
        letter-spacing="2">open Markdown MUD platform</text>
</svg>`;

await mkdir(dirname(out), { recursive: true });
await sharp(Buffer.from(svg))
  .png({ compressionLevel: 9 })
  .toFile(out);

console.log(`wrote ${out}`);
