import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

interface PersistedTokens {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  scope?: string;
  updatedAt: number;
  /**
   * SHA-256 of the FORTNOX_REFRESH_TOKEN this chain of rotated tokens started from.
   * When the environment carries a different token (a new login), the environment wins:
   * otherwise a stale persisted token would silently override a fresh authorization,
   * possibly one for a different Fortnox company.
   */
  seedHash?: string;
}

/**
 * Where rotated tokens are persisted. Set FORTNOX_TOKEN_FILE to give each Fortnox
 * company (each MCP server entry) its own file; two servers sharing one file would
 * read each other's tokens and act on the wrong company.
 */
export function tokenFilePath(): string {
  const configured = process.env.FORTNOX_TOKEN_FILE?.trim();
  if (!configured) return join(homedir(), ".fortnox-mcp", "tokens.json");
  // Config files often write ~/...; Node does not expand it.
  if (configured === "~" || configured.startsWith("~/")) return join(homedir(), configured.slice(1));
  return configured;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function readPersistedTokens(): PersistedTokens | null {
  const file = tokenFilePath();
  try {
    if (!existsSync(file)) {
      return null;
    }
    return JSON.parse(readFileSync(file, "utf-8")) as PersistedTokens;
  } catch {
    return null;
  }
}

export function persistTokens(
  refreshToken: string,
  accessToken: string,
  expiresAt: number,
  scope: string,
  seedHash?: string
): void {
  const file = tokenFilePath();
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) {
      mkdirSync(dir, { mode: 0o700, recursive: true });
    }
    const data: PersistedTokens = {
      refreshToken,
      accessToken,
      expiresAt,
      scope,
      updatedAt: Date.now(),
      seedHash,
    };
    // Write to a temp file and rename, so a sibling process never reads a half-written file.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    console.error(
      `[FortnoxAuth] Warning: Could not persist refresh token to ${file}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
