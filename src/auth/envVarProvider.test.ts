import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { EnvVarTokenProvider } from "./envVarProvider.js";
import { persistTokens, hashToken, readPersistedTokens, tokenFilePath } from "./fileTokenStore.js";

const saved = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fortnox-token-"));
  process.env.FORTNOX_TOKEN_FILE = join(dir, "tokens.json");
  process.env.FORTNOX_CLIENT_ID = "id";
  process.env.FORTNOX_CLIENT_SECRET = "secret";
  delete process.env.FORTNOX_ACCESS_TOKEN;
});

afterEach(() => {
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

describe("EnvVarTokenProvider token selection", () => {
  it("uses FORTNOX_TOKEN_FILE instead of the shared default", () => {
    persistTokens("rotated", "a", 1, "s", hashToken("seed"));
    const onDisk = JSON.parse(readFileSync(join(dir, "tokens.json"), "utf-8"));
    expect(onDisk.refreshToken).toBe("rotated");
    expect(readPersistedTokens()?.refreshToken).toBe("rotated");
  });

  it("keeps the rotated token when it descends from the env token", () => {
    process.env.FORTNOX_REFRESH_TOKEN = "seed";
    persistTokens("rotated", "a", 1, "s", hashToken("seed"));
    expect(new EnvVarTokenProvider().getTokenInfo()?.refreshToken).toBe("rotated");
  });

  it("prefers a new login in the env over a persisted token from an older one", () => {
    process.env.FORTNOX_REFRESH_TOKEN = "new-login";
    persistTokens("rotated", "a", 1, "s", hashToken("old-login"));
    expect(new EnvVarTokenProvider().getTokenInfo()?.refreshToken).toBe("new-login");
  });

  it("tries a legacy file without seedHash first, keeping the env token as fallback", () => {
    process.env.FORTNOX_REFRESH_TOKEN = "seed";
    persistTokens("legacy", "a", 1, "s");
    expect(new EnvVarTokenProvider().getTokenInfo()?.refreshToken).toBe("legacy");
  });

  it("falls back to the env token when the legacy token's refresh fails", async () => {
    process.env.FORTNOX_REFRESH_TOKEN = "seed";
    persistTokens("legacy", "", 0, "s");
    const provider = new EnvVarTokenProvider();
    const used: string[] = [];
    (provider as unknown as { refreshWith: (t: string) => Promise<string> }).refreshWith = async (t) => {
      used.push(t);
      if (t === "legacy") throw new Error("invalid_grant");
      return "access-from-env";
    };
    await expect(provider.getAccessToken()).resolves.toBe("access-from-env");
    expect(used).toEqual(["legacy", "seed"]);
  });

  it("falls back to the persisted token when no env token is set", () => {
    delete process.env.FORTNOX_REFRESH_TOKEN;
    persistTokens("legacy", "a", 1, "s");
    expect(new EnvVarTokenProvider().getTokenInfo()?.refreshToken).toBe("legacy");
  });
});

describe("FORTNOX_TOKEN_FILE", () => {
  it("expands ~ to the home directory", () => {
    process.env.FORTNOX_TOKEN_FILE = "~/fortnox/a.json";
    expect(tokenFilePath()).toBe(join(homedir(), "fortnox", "a.json"));
  });
});

describe("EnvVarTokenProvider with a sibling process", () => {
  it("adopts a fresh access token another process persisted instead of refreshing", async () => {
    process.env.FORTNOX_REFRESH_TOKEN = "seed";
    persistTokens("r1", "", 0, "s", hashToken("seed"));
    const provider = new EnvVarTokenProvider();
    // the sibling rotates r1 -> r2 and stores a valid access token
    persistTokens("r2", "access-2", Date.now() + 3600_000, "s", hashToken("seed"));
    await expect(provider.getAccessToken()).resolves.toBe("access-2");
    expect(provider.getTokenInfo()?.refreshToken).toBe("r2");
  });

  it("ignores a persisted token from a different login", async () => {
    process.env.FORTNOX_REFRESH_TOKEN = "seed";
    // Expired, so the provider re-reads the file before refreshing.
    persistTokens("r1", "", 0, "s", hashToken("seed"));
    const provider = new EnvVarTokenProvider();
    persistTokens("other", "access-other", Date.now() + 3600_000, "s", hashToken("other-login"));
    const used: string[] = [];
    (provider as unknown as { refreshWith: (t: string) => Promise<string> }).refreshWith = async (t) => {
      used.push(t);
      return "access-own";
    };
    await expect(provider.getAccessToken()).resolves.toBe("access-own");
    expect(used).toEqual(["r1"]);
  });

  it("uses a sibling's still-valid access token after a failed refresh instead of rotating again", async () => {
    process.env.FORTNOX_REFRESH_TOKEN = "seed";
    persistTokens("r1", "", 0, "s", hashToken("seed"));
    const provider = new EnvVarTokenProvider();
    const used: string[] = [];
    (provider as unknown as { refreshWith: (t: string) => Promise<string> }).refreshWith = async (t) => {
      used.push(t);
      // The sibling won the race: r1 is spent, and it stored r2 with a fresh access token.
      persistTokens("r2", "access-2", Date.now() + 3600_000, "s", hashToken("seed"));
      throw new Error("invalid_grant");
    };
    await expect(provider.getAccessToken()).resolves.toBe("access-2");
    expect(used).toEqual(["r1"]);
  });

  it("does not replace its own newer token with an older file (e.g. after a failed write)", async () => {
    process.env.FORTNOX_REFRESH_TOKEN = "seed";
    persistTokens("r0", "", 0, "s", hashToken("seed"));
    const provider = new EnvVarTokenProvider();
    const p = provider as unknown as { tokens: { accessToken: string; refreshToken: string; expiresAt: number; scope: string }; tokensUpdatedAt: number;
      refreshWith: (t: string) => Promise<string> };
    // Our refresh rotated r0 -> r1 in memory, but writing the file failed: it still holds r0.
    p.tokens = { accessToken: "", refreshToken: "r1", expiresAt: 0, scope: "s" };
    p.tokensUpdatedAt = Date.now() + 1000;
    const used: string[] = [];
    p.refreshWith = async (t) => { used.push(t); return "access-r1"; };
    await expect(provider.getAccessToken()).resolves.toBe("access-r1");
    expect(used).toEqual(["r1"]);
  });
});
