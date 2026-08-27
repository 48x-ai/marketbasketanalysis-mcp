import { afterEach, beforeEach, vi } from "vitest";

/**
 * Global test setup.
 *
 * The MCP server's behavior depends on three env vars: MBA_API_KEY,
 * MBA_API_BASE, ALLOW_LOCAL_API_BASE. Every test should start from a
 * clean slate — leaking the previous test's env into the next one
 * is the most common false-pass mode.
 *
 * Also: tests must never make real HTTP requests. A spy that aborts
 * any uncaught fetch is the loud-fail mode of choice.
 */

const ORIGINAL_ENV = { ...process.env };
const SCOPED_KEYS = ["MBA_API_KEY", "MBA_API_BASE", "ALLOW_LOCAL_API_BASE", "MBA_DEBUG_ERRORS"];

beforeEach(() => {
  // Reset env to whatever was set at process start, but explicitly
  // clear our own keys so a test that sets MBA_API_KEY doesn't
  // leak into the next.
  for (const k of SCOPED_KEYS) {
    delete process.env[k];
  }

  // Default: any test that hasn't installed its own fetch mock
  // should abort loudly rather than hit the network.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    throw new Error(
      `Unmocked fetch in test: ${input.toString()}. ` +
        "Install a per-test fetch mock with vi.spyOn(globalThis, 'fetch').",
    );
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  // Restore any env keys we cleared.
  for (const k of SCOPED_KEYS) {
    if (k in ORIGINAL_ENV) {
      process.env[k] = ORIGINAL_ENV[k];
    } else {
      delete process.env[k];
    }
  }
});
