import { describe, it, expect, vi } from "vitest";
import { makeTicketRefresh } from "../src/ticket.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("makeTicketRefresh", () => {
  it("fetches /auth/ws-ticket and returns the ticket string", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ticket: "abc123" }));
    const refresh = makeTicketRefresh({ apiBase: "https://muddown.com", fetchImpl });
    const ticket = await refresh();
    expect(ticket).toBe("abc123");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://muddown.com/auth/ws-ticket",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("strips trailing slash from apiBase", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ticket: "t" }));
    const refresh = makeTicketRefresh({ apiBase: "https://muddown.com/", fetchImpl });
    await refresh();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://muddown.com/auth/ws-ticket",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("sends Authorization header when sessionToken is provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ticket: "t" }));
    const refresh = makeTicketRefresh({
      apiBase: "https://muddown.com",
      sessionToken: "sess-abc",
      fetchImpl,
    });
    await refresh();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://muddown.com/auth/ws-ticket",
      expect.objectContaining({ headers: { Authorization: "Bearer sess-abc" } }),
    );
  });

  it("calls sessionToken getter on every refresh so rotated tokens are picked up", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ticket: "t" }));
    let current: string | undefined = "first";
    const refresh = makeTicketRefresh({
      apiBase: "https://muddown.com",
      sessionToken: () => current,
      fetchImpl,
    });
    await refresh();
    current = "second";
    await refresh();
    current = undefined;
    await refresh();
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://muddown.com/auth/ws-ticket",
      expect.objectContaining({ headers: { Authorization: "Bearer first" } }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://muddown.com/auth/ws-ticket",
      expect.objectContaining({ headers: { Authorization: "Bearer second" } }),
    );
    // Third call: getter returned undefined, so no Authorization header.
    const thirdInit = fetchImpl.mock.calls[2][1] as RequestInit | undefined;
    expect(thirdInit?.headers).toBeUndefined();
  });

  it("sends credentials=include when withCredentials is true", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ticket: "t" }));
    const refresh = makeTicketRefresh({
      apiBase: "https://muddown.com",
      withCredentials: true,
      fetchImpl,
    });
    await refresh();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://muddown.com/auth/ws-ticket",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("returns undefined and stays silent on 401 (guest/expired)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const refresh = makeTicketRefresh({ apiBase: "https://muddown.com", fetchImpl });
    expect(await refresh()).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("warns on 5xx so a misconfigured server is visible", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    const refresh = makeTicketRefresh({ apiBase: "https://muddown.com", fetchImpl });
    expect(await refresh()).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("500"));
    warnSpy.mockRestore();
  });

  it("returns undefined on network error (guest fallback) and logs at error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const refresh = makeTicketRefresh({ apiBase: "https://muddown.com", fetchImpl });
    expect(await refresh()).toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("aborts after timeoutMs and warns about the timeout", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // fetchImpl resolves with whatever the abort signal does — simulate the
    // standard fetch behaviour by rejecting with AbortError when aborted.
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const refresh = makeTicketRefresh({
      apiBase: "https://muddown.com",
      fetchImpl,
      timeoutMs: 1000,
    });
    const promise = refresh();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await promise).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("timed out"));
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("returns undefined when JSON body has no ticket field", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "no character" }));
    const refresh = makeTicketRefresh({ apiBase: "https://muddown.com", fetchImpl });
    expect(await refresh()).toBeUndefined();
  });

  it("returns undefined when 200 response body is not valid JSON", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("not json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const refresh = makeTicketRefresh({ apiBase: "https://muddown.com", fetchImpl });
    expect(await refresh()).toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
