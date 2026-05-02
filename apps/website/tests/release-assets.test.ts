import { describe, it, expect } from "vitest";
import {
  classify,
  pickAsset,
  pickMacosPair,
  formatSize,
  formatDigestShort,
} from "../src/lib/release-assets.ts";
import type { ReleaseAsset } from "../src/lib/releases.ts";

const asset = (name: string, url = `https://example/${name}`): ReleaseAsset => ({
  name,
  browser_download_url: url,
  size: 0,
});

describe("classify", () => {
  it("recognises macOS DMGs and tags arch from aarch64/x64 tokens", () => {
    expect(classify("MUDdown_1.0.0_aarch64.dmg")).toEqual({
      platform: "macos",
      arch: "arm64 (Apple Silicon)",
      archToken: "arm64",
      kind: "DMG",
    });
    expect(classify("MUDdown_1.0.0_x64.dmg")).toEqual({
      platform: "macos",
      arch: "x64 (Intel)",
      archToken: "x64",
      kind: "DMG",
    });
  });

  it("treats the bare arm64 token as arm64", () => {
    expect(classify("MUDdown_1.0.0_arm64.dmg").archToken).toBe("arm64");
  });

  it("does not misclassify substrings like 'charm' as arm64", () => {
    expect(classify("charm-app_1.0.0_x64.dmg").archToken).toBe("x64");
  });

  it("tags Tauri updater archives separately from installers", () => {
    expect(classify("MUDdown_1.0.0_aarch64.app.tar.gz").kind).toBe("App archive (updater)");
    expect(classify("MUDdown_1.0.0_amd64.AppImage.tar.gz").kind).toBe(
      "AppImage archive (updater)",
    );
  });

  it(".AppImage installer is distinct from the .AppImage.tar.gz updater archive", () => {
    expect(classify("MUDdown_1.0.0_amd64.AppImage").kind).toBe("AppImage");
    expect(classify("MUDdown_1.0.0_amd64.AppImage.tar.gz").kind).toBe(
      "AppImage archive (updater)",
    );
  });

  it("tags signatures and the manifest as 'other' platform", () => {
    expect(classify("MUDdown_1.0.0_aarch64.dmg.sig")).toEqual({
      platform: "other",
      arch: "",
      archToken: null,
      kind: "signature",
    });
    expect(classify("latest.json")).toEqual({
      platform: "other",
      arch: "",
      archToken: null,
      kind: "manifest",
    });
  });

  it("recognises Windows MSI/EXE and Linux deb/rpm", () => {
    expect(classify("MUDdown_1.0.0_x64_en-US.msi").kind).toBe("MSI installer");
    expect(classify("MUDdown_1.0.0_x64-setup.exe").kind).toBe("EXE installer");
    expect(classify("muddown_1.0.0_amd64.deb").kind).toBe("Debian package");
    expect(classify("muddown-1.0.0-1.x86_64.rpm").kind).toBe("RPM package");
  });

  it("falls back to the file extension for unknown assets", () => {
    expect(classify("readme.txt")).toEqual({
      platform: "other",
      arch: "",
      archToken: null,
      kind: "txt",
    });
  });
});

describe("pickAsset", () => {
  const assets = [
    asset("MUDdown_1.0.0_aarch64.dmg"),
    asset("MUDdown_1.0.0_x64.dmg"),
    asset("MUDdown_1.0.0_x64_en-US.msi"),
    asset("MUDdown_1.0.0_amd64.AppImage"),
    asset("MUDdown_1.0.0_amd64.AppImage.tar.gz"),
    asset("MUDdown_1.0.0_amd64.deb"),
    asset("muddown-1.0.0-1.x86_64.rpm"),
  ];

  it("matches macos-arm64 only against arm DMGs", () => {
    expect(pickAsset(assets, "macos-arm64")?.name).toBe("MUDdown_1.0.0_aarch64.dmg");
  });

  it("matches macos-x64 against explicit x64/x86_64 DMGs first", () => {
    expect(pickAsset(assets, "macos-x64")?.name).toBe("MUDdown_1.0.0_x64.dmg");
  });

  it("falls back to non-arm DMGs for macos-x64 when no explicit token is present", () => {
    const sparse = [asset("MUDdown_1.0.0.dmg"), asset("MUDdown_1.0.0_aarch64.dmg")];
    expect(pickAsset(sparse, "macos-x64")?.name).toBe("MUDdown_1.0.0.dmg");
  });

  it("returns null when the requested platform is missing", () => {
    expect(pickAsset([asset("MUDdown_1.0.0_amd64.deb")], "macos-arm64")).toBeNull();
  });

  it("matches linux/linux-appimage against the .AppImage installer (not the updater archive)", () => {
    const picked = pickAsset(assets, "linux");
    expect(picked?.name).toBe("MUDdown_1.0.0_amd64.AppImage");
    expect(pickAsset(assets, "linux-appimage")?.name).toBe("MUDdown_1.0.0_amd64.AppImage");
  });

  it("matches windows against MSI first, EXE as fallback", () => {
    expect(pickAsset(assets, "windows")?.name).toBe("MUDdown_1.0.0_x64_en-US.msi");
    const exeOnly = [asset("MUDdown_1.0.0_x64-setup.exe")];
    expect(pickAsset(exeOnly, "windows")?.name).toBe("MUDdown_1.0.0_x64-setup.exe");
  });

  it("returns null for unknown slugs", () => {
    expect(pickAsset(assets, "freebsd")).toBeNull();
  });
});

describe("pickMacosPair", () => {
  it("returns both URLs when a complete release is published", () => {
    const pair = pickMacosPair([
      asset("MUDdown_1.0.0_aarch64.dmg", "https://example/arm.dmg"),
      asset("MUDdown_1.0.0_x64.dmg", "https://example/x64.dmg"),
    ]);
    expect(pair.arm64).toBe("https://example/arm.dmg");
    expect(pair.x64).toBe("https://example/x64.dmg");
  });

  it("returns null on the missing side when only one matrix leg succeeded", () => {
    const armOnly = pickMacosPair([asset("MUDdown_1.0.0_aarch64.dmg")]);
    expect(armOnly.arm64).not.toBeNull();
    expect(armOnly.x64).toBeNull();

    const x64Only = pickMacosPair([asset("MUDdown_1.0.0_x64.dmg")]);
    expect(x64Only.x64).not.toBeNull();
    expect(x64Only.arm64).toBeNull();
  });

  it("mirrors pickAsset('macos-x64') by falling back to non-arm DMGs", () => {
    const pair = pickMacosPair([
      asset("MUDdown_1.0.0_aarch64.dmg"),
      asset("MUDdown_1.0.0.dmg", "https://example/generic.dmg"),
    ]);
    expect(pair.x64).toBe("https://example/generic.dmg");
  });

  it("returns null for both sides when no DMG is present", () => {
    expect(pickMacosPair([asset("MUDdown_1.0.0_x64_en-US.msi")])).toEqual({
      arm64: null,
      x64: null,
    });
  });
});

describe("formatSize", () => {
  it("formats zero as '0 B'", () => {
    expect(formatSize(0)).toBe("0 B");
  });

  it("formats sub-KB byte counts without a suffix conversion", () => {
    expect(formatSize(1)).toBe("1 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("transitions from B to KB at exactly 1024", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1025)).toBe("1.0 KB");
    expect(formatSize(1500)).toBe("1.5 KB");
  });

  it("transitions from KB to MB at exactly 1024 * 1024", () => {
    // The KB branch covers up to (but not including) 1024 * 1024,
    // so 1048575 still renders as KB and 1048576 flips to MB.
    expect(formatSize(1024 * 1024 - 1)).toBe("1024.0 KB");
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
  });

  it("formats MB-range sizes", () => {
    expect(formatSize(2_500_000)).toBe("2.4 MB");
    expect(formatSize(50 * 1024 * 1024)).toBe("50.0 MB");
  });

  it("does not introduce a GB tier — very large values stay in MB", () => {
    // Desktop installers are MB-scale; the helper intentionally caps at MB
    // so unexpectedly large inputs surface as a plainly large MB number.
    expect(formatSize(3_000_000_000)).toBe("2861.0 MB");
  });
});

describe("formatDigestShort", () => {
  it("returns null for missing input", () => {
    expect(formatDigestShort(null)).toBeNull();
    expect(formatDigestShort(undefined)).toBeNull();
    expect(formatDigestShort("")).toBeNull();
  });

  it("renders the short form for sha256:... digests", () => {
    expect(formatDigestShort("sha256:abcdef0123456789deadbeef")).toBe("sha256:abcdef012345…");
  });

  it("returns the input unchanged when no algorithm prefix is present", () => {
    expect(formatDigestShort("abcdef")).toBe("abcdef");
    expect(formatDigestShort("sha256:")).toBe("sha256:");
  });
});
