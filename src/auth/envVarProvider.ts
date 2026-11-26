import axios, { AxiosError } from "axios";
import { FORTNOX_OAUTH_URL, TOKEN_REFRESH_BUFFER_MS } from "../constants.js";
import { ITokenProvider, TokenInfo, AuthRequiredError } from "./types.js";
import { getFortnoxCredentials } from "./credentials.js";
import { readPersistedTokens, persistTokens, hashToken, tokenFilePath } from "./fileTokenStore.js";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

// Local mode token provider
export class EnvVarTokenProvider implements ITokenProvider {
  private clientId: string;
  private clientSecret: string;
  private tokens: TokenInfo | null = null;
  private refreshPromise: Promise<string> | null = null;
  private seedHash: string | undefined;
  /** Env refresh token to fall back to when a legacy (pre-seedHash) persisted token fails. */
  private fallbackRefreshToken: string | undefined;
  /** When the in-memory tokens were written; a token file older than this is stale, not newer. */
  private tokensUpdatedAt = 0;

  constructor() {
    const { clientId, clientSecret } = getFortnoxCredentials();
    this.clientId = clientId;
    this.clientSecret = clientSecret;

    // Initialize tokens. The persisted file holds the latest rotated refresh token, but only
    // for the login it was seeded from: a FORTNOX_REFRESH_TOKEN from a newer login (its hash
    // differs from the file's seedHash) wins over the file. A legacy file written before
    // seedHash existed cannot be told apart: it is tried first (it is most likely the rotated
    // descendant of the env token, which is then long spent) and the env token is kept as a
    // fallback. The first successful refresh stamps the file with the env token's hash.
    const persisted = readPersistedTokens();
    const envRefreshToken = process.env.FORTNOX_REFRESH_TOKEN;
    const envSeedHash = envRefreshToken ? hashToken(envRefreshToken) : undefined;
    const legacyFile = !!persisted?.refreshToken && !!envSeedHash && persisted.seedHash === undefined;
    const persistedMatchesEnv =
      !!persisted?.refreshToken && (!envSeedHash || persisted.seedHash === envSeedHash || legacyFile);

    if (persisted?.refreshToken && persistedMatchesEnv) {
      this.seedHash = legacyFile ? envSeedHash : persisted.seedHash;
      if (legacyFile && envRefreshToken !== persisted.refreshToken) {
        this.fallbackRefreshToken = envRefreshToken;
      }
      if (legacyFile) {
        // The file cannot say which login it came from. If several server entries (several
        // Fortnox companies) share it, this one may adopt another company's token.
        console.error(
          `[FortnoxAuth] Using a token file written by an older version (${tokenFilePath()}). ` +
          `If you run more than one Fortnox server entry, give each its own FORTNOX_TOKEN_FILE.`
        );
      }
      this.tokensUpdatedAt = persisted.updatedAt || 0;
      this.tokens = {
        accessToken: persisted.accessToken || "",
        refreshToken: persisted.refreshToken,
        expiresAt: persisted.expiresAt || 0,
        scope: persisted.scope || process.env.FORTNOX_SCOPE || ""
      };
    } else if (envRefreshToken) {
      this.seedHash = envSeedHash;
      this.tokens = {
        accessToken: process.env.FORTNOX_ACCESS_TOKEN || "",
        refreshToken: envRefreshToken,
        expiresAt: process.env.FORTNOX_ACCESS_TOKEN ? Date.now() + 3600000 : 0,
        scope: process.env.FORTNOX_SCOPE || ""
      };
    }
  }

  /**
   * Adopt a newer token from the persisted file. Claude Desktop can run two processes per server
   * entry; Fortnox refresh tokens are single-use, so when one process rotates, the other's
   * in-memory refresh token is dead. Re-reading the file (same login, newer write) keeps both alive.
   * Returns true when the in-memory tokens changed.
   */
  private adoptNewerPersistedTokens(): boolean {
    const persisted = readPersistedTokens();
    if (!persisted?.refreshToken || persisted.seedHash !== this.seedHash) {
      return false;
    }
    if (this.tokens && persisted.refreshToken === this.tokens.refreshToken) {
      return false;
    }
    // Only a file written after our own tokens is newer. An older one (e.g. our last write
    // failed) holds a token that is already spent.
    if (this.tokens && (persisted.updatedAt || 0) < this.tokensUpdatedAt) {
      return false;
    }
    this.tokensUpdatedAt = persisted.updatedAt || 0;
    this.tokens = {
      accessToken: persisted.accessToken || "",
      refreshToken: persisted.refreshToken,
      expiresAt: persisted.expiresAt || 0,
      scope: persisted.scope || this.tokens?.scope || ""
    };
    return true;
  }

  async getAccessToken(_userId?: string): Promise<string> {
    if (!this.tokens) {
      this.adoptNewerPersistedTokens();
    }
    if (!this.tokens) {
      throw new AuthRequiredError();
    }

    const needsRefresh = Date.now() >= this.tokens.expiresAt - TOKEN_REFRESH_BUFFER_MS;

    if (needsRefresh || !this.tokens.accessToken) {
      // Another process may already have rotated the token and stored a fresh access token.
      if (this.adoptNewerPersistedTokens()) {
        const fresh = Date.now() < this.tokens.expiresAt - TOKEN_REFRESH_BUFFER_MS;
        if (fresh && this.tokens.accessToken) {
          return this.tokens.accessToken;
        }
      }
      if (!this.refreshPromise) {
        this.refreshPromise = this.refreshAccessToken().finally(() => {
          this.refreshPromise = null;
        });
      }
      return this.refreshPromise;
    }

    return this.tokens.accessToken;
  }

  isAuthenticated(_userId?: string): boolean {
    return this.tokens !== null && this.tokens.refreshToken !== "";
  }

  getTokenInfo(_userId?: string): TokenInfo | null {
    return this.tokens;
  }

  async exchangeAuthorizationCode(code: string, redirectUri: string): Promise<void> {
    const tokenUrl = `${FORTNOX_OAUTH_URL}/token`;
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");

    try {
      const response = await axios.post<TokenResponse>(
        tokenUrl,
        new URLSearchParams({
          grant_type: "authorization_code",
          code: code,
          redirect_uri: redirectUri
        }),
        {
          headers: {
            "Authorization": `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded"
          }
        }
      );

      this.storeTokens(response.data);
    } catch (error) {
      throw this.handleAuthError(error, "Failed to exchange authorization code");
    }
  }

  getAuthorizationUrl(redirectUri: string, scopes: string[], state?: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(" "),
      response_type: "code",
      access_type: "offline"
    });

    if (state) {
      params.set("state", state);
    }

    return `${FORTNOX_OAUTH_URL}/auth?${params.toString()}`;
  }

  private async refreshAccessToken(): Promise<string> {
    if (!this.tokens?.refreshToken) {
      throw new Error("No refresh token available");
    }

    try {
      const token = await this.refreshWith(this.tokens.refreshToken);
      this.fallbackRefreshToken = undefined;
      return token;
    } catch (error) {
      // A legacy persisted token failed: try the env token it could not be matched against.
      if (this.fallbackRefreshToken) {
        const fallback = this.fallbackRefreshToken;
        this.fallbackRefreshToken = undefined;
        try {
          return await this.refreshWith(fallback);
        } catch {
          // fall through to the sibling-process check and the original error
        }
      }
      // A sibling process may have rotated the token between our read and our refresh.
      if (this.adoptNewerPersistedTokens()) {
        // The sibling also stored its access token: use it while valid instead of rotating again.
        const adopted = this.tokens!;
        if (adopted.accessToken && Date.now() < adopted.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
          return adopted.accessToken;
        }
        try {
          return await this.refreshWith(adopted.refreshToken);
        } catch (retryError) {
          this.tokens = null;
          throw this.handleAuthError(retryError, "Failed to refresh access token");
        }
      }
      this.tokens = null;
      throw this.handleAuthError(error, "Failed to refresh access token");
    }
  }

  private async refreshWith(refreshToken: string): Promise<string> {
    const tokenUrl = `${FORTNOX_OAUTH_URL}/token`;
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const response = await axios.post<TokenResponse>(
      tokenUrl,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken
      }),
      {
        headers: {
          "Authorization": `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );
    this.storeTokens(response.data);
    return this.tokens!.accessToken;
  }

  private storeTokens(response: TokenResponse): void {
    const expiresAt = Date.now() + response.expires_in * 1000;
    this.tokensUpdatedAt = Date.now();
    this.tokens = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt,
      scope: response.scope
    };
    // Persist to file so new refresh token survives process restarts
    persistTokens(response.refresh_token, response.access_token, expiresAt, response.scope, this.seedHash);
  }

  private handleAuthError(error: unknown, context: string): Error {
    if (error instanceof AxiosError) {
      const status = error.response?.status;
      const data = error.response?.data;

      if (status === 401) {
        return new Error(
          `${context}: Invalid credentials. Check FORTNOX_CLIENT_ID and FORTNOX_CLIENT_SECRET.`
        );
      }
      if (status === 400) {
        const errorDesc = data?.error_description || data?.error || "Bad request";
        return new Error(
          `${context}: ${errorDesc}. The refresh token may be expired or revoked. ` +
          `Please re-authorize the application.`
        );
      }
      return new Error(
        `${context}: API error ${status} - ${JSON.stringify(data)}`
      );
    }

    return new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
