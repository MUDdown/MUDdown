import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  isPublicDesktopTag,
  formatPublishedDate,
  fetchLatestPublicRelease,
  ERROR_NO_RELEASE_YET,
  __resetMemoForTesting,
} from "../src/lib/releases.ts";

describe("isPublicDesktopTag", () => {
  it("accepts desktop-v1.x and later", () => {
    expect(isPublicDesktopTag("desktop-v1.0.0")).toBe(true);
    expect(isPublicDesktopTag("desktop-v2.5.1")).toBe(true);
    expect(isPublicDesktopTag("desktop-v10.0.0")).toBe(true);
  });

  it("rejects desktop-v0.x (internal verification builds)", () => {
    expect(isPublicDesktopTag("desktop-v0.1.0")).toBe(false);
    expect(isPublicDesktopTag("desktop-v0.99.0")).toBe(false);
  });

  it("rejects pre-release tags (e.g. desktop-v1.0.0-beta.1)", () => {
    expect(isPublicDesktopTag("desktop-v1.0.0-beta.1")).toBe(false);
    expect(isPublicDesktopTag("desktop-v1.0.0-rc.1")).toBe(false);
    expect(isPublicDesktopTag("desktop-v1.0.0+build.1")).toBe(false);
  });

  it("rejects malformed semver shapes", () => {
    expect(isPublicDesktopTag("desktop-v1")).toBe(false);
    expect(isPublicDesktopTag("desktop-v1.0")).toBe(false);
    expect(isPublicDesktopTag("desktop-v1.0.0.0")).toBe(false);
  });

  it("rejects non-desktop tags and missing input", () => {
    expect(isPublicDesktopTag("v1.0.0")).toBe(false);
    expect(isPublicDesktopTag("server-v1.0.0")).toBe(false);
    expect(isPublicDesktopTag(undefined)).toBe(false);
    expect(isPublicDesktopTag("")).toBe(false);
  });
});

describe("formatPublishedDate", () => {
  it("formats an ISO timestamp to YYYY-MM-DD", () => {
    expect(formatPublishedDate("2026-05-02T18:36:21Z")).toBe("2026-05-02");
  });

  it("returns null for missing input", () => {
    expect(formatPublishedDate(null)).toBeNull();
    expect(formatPublishedDate(undefined)).toBeNull();
    expect(formatPublishedDate("")).toBeNull();
  });

  it("returns null for an unparseable timestamp", () => {
    expect(formatPublishedDate("not-a-date")).toBeNull();
  });
});

describe("fetchLatestPublicRelease", () => {
  const originalFetch = globalThis.fetch;
  // Suppress the helper's intentional console.error/warn output in test runs.
  // Spies are created in beforeEach and restored in afterEach so they don't
  // leak past this describe block and silence diagnostics in later suites.
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetMemoForTesting();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  const ok = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  // Helper for the minimum valid Release shape — fetchLatestPublicRelease
  // requires tag_name, html_url, and assets[] before it accepts a candidate.
  const release = (overrides: { tag_name: string; assets?: unknown[]; name?: string }) => ({
    tag_name: overrides.tag_name,
    name: overrides.name ?? overrides.tag_name,
    html_url: `https://github.com/MUDdown/MUDdown/releases/tag/${overrides.tag_name}`,
    published_at: "2026-05-02T18:36:21Z",
    body: "",
    assets: overrides.assets ?? [],
  });

  it("returns the first release whose tag passes isPublicDesktopTag", async () => {
    globalThis.fetch = vi.fn(async () =>
      ok([
        release({ tag_name: "desktop-v0.5.0", name: "internal" }),
        release({ tag_name: "desktop-v1.0.0", name: "public" }),
      ]),
    ) as typeof fetch;
    const result = await fetchLatestPublicRelease("test");
    expect(result.error).toBeNull();
    expect(result.release?.tag_name).toBe("desktop-v1.0.0");
  });

  it("returns the 'release pending' error when no v1+ tag is published", async () => {
    globalThis.fetch = vi.fn(async () =>
      ok([release({ tag_name: "desktop-v0.1.0", name: "internal" })]),
    ) as typeof fetch;
    const result = await fetchLatestPublicRelease("test");
    expect(result.release).toBeNull();
    expect(result.error).toBe(ERROR_NO_RELEASE_YET);
  });

  it("skips null entries in the API array without throwing", async () => {
    globalThis.fetch = vi.fn(async () =>
      ok([null, release({ tag_name: "desktop-v1.0.0" })]),
    ) as typeof fetch;
    const result = await fetchLatestPublicRelease("test");
    expect(result.error).toBeNull();
    expect(result.release?.tag_name).toBe("desktop-v1.0.0");
  });

  it("skips entries missing required fields (html_url, assets) without throwing", async () => {
    globalThis.fetch = vi.fn(async () =>
      ok([
        // Passes the tag-name predicate but lacks html_url / assets — must not be
        // returned, since download.astro would crash reading those fields.
        { tag_name: "desktop-v1.0.0", name: "malformed" },
        release({ tag_name: "desktop-v1.0.1", name: "valid" }),
      ]),
    ) as typeof fetch;
    const result = await fetchLatestPublicRelease("test");
    expect(result.error).toBeNull();
    expect(result.release?.tag_name).toBe("desktop-v1.0.1");
  });

  it("rejects entries where assets is not an array", async () => {
    globalThis.fetch = vi.fn(async () =>
      ok([
        {
          tag_name: "desktop-v1.0.0",
          html_url: "https://example/r",
          assets: "not-an-array",
        },
      ]),
    ) as typeof fetch;
    const result = await fetchLatestPublicRelease("test");
    expect(result.release).toBeNull();
    expect(result.error).toBe(ERROR_NO_RELEASE_YET);
  });

  it("surfaces a distinct error when the API returns non-OK", async () => {
    globalThis.fetch = vi.fn(async () => new Response("rate limited", { status: 403 })) as typeof fetch;
    const result = await fetchLatestPublicRelease("test");
    expect(result.release).toBeNull();
    expect(result.error).toMatch(/GitHub API returned 403/);
  });

  it("surfaces a distinct error when the API returns malformed JSON", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as typeof fetch;
    const result = await fetchLatestPublicRelease("test");
    expect(result.release).toBeNull();
    expect(result.error).toMatch(/unparseable/i);
  });

  it("surfaces a distinct error when the API returns a non-array body", async () => {
    globalThis.fetch = vi.fn(async () => ok({ message: "Not Found" })) as typeof fetch;
    const result = await fetchLatestPublicRelease("test");
    expect(result.release).toBeNull();
    expect(result.error).toMatch(/unexpected response format/i);
  });

  it("surfaces a 'could not reach' error on network failure", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    }) as typeof fetch;
    const result = await fetchLatestPublicRelease("test");
    expect(result.release).toBeNull();
    expect(result.error).toMatch(/Could not reach the GitHub API/);
  });

  it("surfaces a timeout-specific message on AbortError", async () => {
    globalThis.fetch = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as typeof fetch;
    const result = await fetchLatestPublicRelease("test");
    expect(result.release).toBeNull();
    expect(result.error).toMatch(/timed out/i);
  });

  it("memoizes the fetch so concurrent callers share a single request", async () => {
    const fetchSpy = vi.fn(async () => ok([release({ tag_name: "desktop-v1.0.0" })])) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    const [a, b, c] = await Promise.all([
      fetchLatestPublicRelease("a"),
      fetchLatestPublicRelease("b"),
      fetchLatestPublicRelease("c"),
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(a.release?.tag_name).toBe("desktop-v1.0.0");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("memoization is reset between tests via __resetMemoForTesting", async () => {
    const fetchSpy = vi.fn(async () => ok([release({ tag_name: "desktop-v1.0.0" })])) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    await fetchLatestPublicRelease("first");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    __resetMemoForTesting();
    await fetchLatestPublicRelease("second");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not poison the memo cache after a transient failure", async () => {
    let callCount = 0;
    const fetchSpy = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error("ENOTFOUND");
      return ok([release({ tag_name: "desktop-v1.0.0" })]);
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    const first = await fetchLatestPublicRelease("first");
    expect(first.release).toBeNull();
    // A second call after the failure should retry rather than reuse the
    // poisoned error result.
    const second = await fetchLatestPublicRelease("second");
    expect(second.release?.tag_name).toBe("desktop-v1.0.0");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not poison the memo cache after the 'release pending' result", async () => {
    let callCount = 0;
    const fetchSpy = vi.fn(async () => {
      callCount++;
      return callCount === 1
        ? ok([release({ tag_name: "desktop-v0.1.0" })])
        : ok([release({ tag_name: "desktop-v1.0.0" })]);
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    const first = await fetchLatestPublicRelease("first");
    expect(first.error).toBe(ERROR_NO_RELEASE_YET);
    const second = await fetchLatestPublicRelease("second");
    expect(second.release?.tag_name).toBe("desktop-v1.0.0");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
