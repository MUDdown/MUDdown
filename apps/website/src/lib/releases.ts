// Shared GitHub Releases helpers for /download and /download/[platform].
// Centralising the fetch + filter logic prevents the two pages from drifting
// (e.g. main page surfacing a release that the permalinks won't redirect to).

export type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
  digest?: string | null;
};

export type Release = {
  tag_name: string;
  name: string;
  published_at: string;
  html_url: string;
  body: string;
  assets: ReleaseAsset[];
};

export const DESKTOP_REPO = "MUDdown/MUDdown";
export const DESKTOP_TAG_PREFIX = "desktop-v";

// Only releases at v1.0.0 or later are surfaced publicly. The desktop-v0.x
// track is reserved for internal verification builds (signed-build smoke
// tests, notarization dry-runs) and must never reach end users via the
// /download page or /download/[platform] permalinks.
export function isPublicDesktopTag(tag: string | undefined): boolean {
  return !!tag && /^desktop-v[1-9]\d*\./.test(tag);
}

export type FetchReleaseResult =
  | { release: Release; error: null }
  | { release: null; error: string };

const FETCH_TIMEOUT_MS = 10_000;

// Memoize the fetch for the duration of a single Astro build. Without this,
// /download plus the 8 generated /download/[platform] pages each trigger an
// independent /releases call — 9 identical requests per build, which on an
// unauthenticated runner burns through the 60 req/hr GitHub limit quickly.
let inflight: Promise<FetchReleaseResult> | null = null;

// Fetches the most recent public desktop release. Returns a discriminated
// result so callers can distinguish "release pending" (error: "No desktop
// release published yet.") from "build environment can't reach GitHub".
export async function fetchLatestPublicRelease(context: string): Promise<FetchReleaseResult> {
  if (inflight) return inflight;
  inflight = doFetch(context);
  return inflight;
}

async function doFetch req/hr GitHub limit quickly.
let inflight: Promise<FetchReleaseResult> | null = null;

// Fetches the most recent public desktop release. Returns a discriminated
// result so callers can distinguish "release pending" (error: "No desktop
// release published yet.") from "build environment can't reach GitHub".
export async function fetchLatestPublicRelease(context: string): Promise<FetchReleaseResult> {
  if (inflight) return inflight;
  inflight = doFetch(context);
  return inflight;
}

async function doFetch(context: string): Promise<FetchReleaseResult> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn(`[${context}] GITHUB_TOKEN not set; using unauthenticated API (60 req/hr limit).`);
  }
  if (token) headers.Authorization = `Bearer ${token}`;

  // Abort after 10s so a hung GitHub TCP connection can't stall the whole build.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://api.github.com/repos/${DESKTOP_REPO}/releases?per_page=100`,
      { headers, signal: controller.signal },
    );
    if (!res.ok) {
      const errorBody = await res.text().catch(() => "(unreadable)");
      console.error(`[${context}] GitHub API returned ${res.status}:`, errorBody.slice(0, 500));
      return { release: null, error: `GitHub API returned ${res.status}.` };
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch (err) {
      console.error(`[${context}] Could not parse GitHub API response as JSON:`, err);
      return {
        release: null,
        error: "GitHub API returned an unparseable response.",
      };
    }
    if (!Array.isArray(data)) {
      console.error(
        `[${context}] GitHub API returned non-array body:`,
        typeof data,
        JSON.stringify(data).slice(0, 200),
      );
      return {
        release: null,
        error: "GitHub API returned an unexpected response format.",
      };
    }
    const release = (data as Release[]).find((r) => isPublicDesktopTag(r.tag_name));
    if (!release) {
      return { release: null, error: "No desktop release published yet." };
    }
    return { release, error: null };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error(`[${context}] GitHub API fetch timed out after ${FETCH_TIMEOUT_MS}ms.`);
      return {
        release: null,
        error:
          "GitHub API request timed out. Release information will appear once the build environment can connect to GitHub.",
      };
    }
    console.error(`[${context}] Exception fetching GitHub releases:`, err);
    return {
      release: null,
      error:
        "Could not reach the GitHub API. Release information will appear once the build environment can connect to GitHub.",
    };
  } finally {
    clearTimeout(timer);
  }
}

// Safely format an ISO timestamp from the API to a YYYY-MM-DD string.
// Returns null when the input is missing or unparseable so a malformed
// `published_at` value can never crash the page build.
export function formatPublishedDate(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const iso = new Date(value).toISOString();
    return iso.slice(0, 10);
  } catch (err) {
    console.error("[releases] Unparseable published_at value:", value, err);
    return null;
  }
}
