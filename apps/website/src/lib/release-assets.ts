// Pure helpers for classifying GitHub Release assets into per-platform
// installer rows, picking the right asset for a /download/[platform] slug,
// and formatting installer metadata. Extracted from download.astro and
// download/[platform].astro so the logic can be unit-tested without
// running the full Astro build.

import type { ReleaseAsset } from "./releases.ts";

export type Platform = "macos" | "windows" | "linux";
export type ArchToken = "arm64" | "x64";

export type AssetClassification = {
  platform: Platform | "other";
  arch: string;
  archToken: ArchToken | null;
  kind: string;
};

// Classify a release asset by filename. The bare /arm/ check is intentionally
// omitted: substrings like "charm" or "warm" would misclassify, and Tauri
// always emits aarch64/arm64. Order matters: more specific suffixes
// (.AppImage.tar.gz, .app.tar.gz) must come before their generic counterparts
// (.AppImage) so updater archives don't leak into the installer list.
export function classify(name: string): AssetClassification {
  const lower = name.toLowerCase();
  const detectArch = (): ArchToken =>
    lower.includes("aarch64") || lower.includes("arm64") || lower.includes("armv8")
      ? "arm64"
      : "x64";
  if (lower.endsWith(".sig")) return { platform: "other", arch: "", archToken: null, kind: "signature" };
  if (lower === "latest.json") return { platform: "other", arch: "", archToken: null, kind: "manifest" };
  if (lower.endsWith(".dmg")) {
    const archToken = detectArch();
    const arch = archToken === "arm64" ? "arm64 (Apple Silicon)" : "x64 (Intel)";
    return { platform: "macos", arch, archToken, kind: "DMG" };
  }
  if (lower.endsWith(".app.tar.gz")) {
    const archToken = detectArch();
    return { platform: "macos", arch: archToken, archToken, kind: "App archive (updater)" };
  }
  if (lower.endsWith(".appimage.tar.gz")) {
    const archToken = detectArch();
    return { platform: "linux", arch: archToken, archToken, kind: "AppImage archive (updater)" };
  }
  if (lower.endsWith(".msi")) {
    const archToken = detectArch();
    return { platform: "windows", arch: archToken, archToken, kind: "MSI installer" };
  }
  if (lower.endsWith(".exe")) {
    const archToken = detectArch();
    return { platform: "windows", arch: archToken, archToken, kind: "EXE installer" };
  }
  if (lower.endsWith(".appimage")) {
    const archToken = detectArch();
    return { platform: "linux", arch: archToken, archToken, kind: "AppImage" };
  }
  if (lower.endsWith(".deb")) {
    const archToken = detectArch();
    return { platform: "linux", arch: archToken, archToken, kind: "Debian package" };
  }
  if (lower.endsWith(".rpm")) {
    const archToken = detectArch();
    return { platform: "linux", arch: archToken, archToken, kind: "RPM package" };
  }
  return { platform: "other", arch: "", archToken: null, kind: name.split(".").pop() ?? "" };
}

// Pick the asset that matches the /download/[platform] slug. Returns null
// when no asset matches (e.g. partial release where one matrix leg failed).
export function pickAsset(assets: ReleaseAsset[], plat: string): ReleaseAsset | null {
  const by = (pred: (n: string) => boolean): ReleaseAsset | null =>
    assets.find((a) => pred(a.name.toLowerCase())) ?? null;

  switch (plat) {
    case "macos-arm64":
      return by((n) => n.endsWith(".dmg") && (n.includes("aarch64") || n.includes("arm64")));
    case "macos-x64":
      return (
        by((n) => n.endsWith(".dmg") && (n.includes("x64") || n.includes("x86_64"))) ??
        by((n) => n.endsWith(".dmg") && !n.includes("aarch64") && !n.includes("arm64"))
      );
    case "windows":
      return by((n) => n.endsWith(".msi")) ?? by((n) => n.endsWith(".exe"));
    case "linux":
    case "linux-appimage":
      return by((n) => n.endsWith(".appimage"));
    case "linux-deb":
      return by((n) => n.endsWith(".deb"));
    case "linux-rpm":
      return by((n) => n.endsWith(".rpm"));
    default:
      return null;
  }
}

// Pick the (arm64, x64) macOS DMG pair for the generic /download/macos slug.
// Either side may be null if the corresponding matrix leg failed. Mirrors
// pickAsset's macos-x64 logic so /download/macos and /download/macos-x64
// stay consistent.
export function pickMacosPair(assets: ReleaseAsset[]): { arm64: string | null; x64: string | null } {
  const by = (pred: (n: string) => boolean) =>
    assets.find((a) => pred(a.name.toLowerCase())) ?? null;
  const arm = by((n) => n.endsWith(".dmg") && (n.includes("aarch64") || n.includes("arm64")));
  const x64 =
    by((n) => n.endsWith(".dmg") && (n.includes("x64") || n.includes("x86_64"))) ??
    by((n) => n.endsWith(".dmg") && !n.includes("aarch64") && !n.includes("arm64"));
  return {
    arm64: arm?.browser_download_url ?? null,
    x64: x64?.browser_download_url ?? null,
  };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// GitHub returns digests like "sha256:abcdef..." — render a short form for
// inline display. Callers expose the full digest separately so users can
// actually run sha256sum -c against it.
export function formatDigestShort(digest: string | null | undefined): string | null {
  if (!digest) return null;
  const idx = digest.indexOf(":");
  if (idx <= 0 || idx === digest.length - 1) return digest;
  const algorithm = digest.slice(0, idx);
  const hash = digest.slice(idx + 1);
  return `${algorithm}:${hash.slice(0, 12)}…`;
}
