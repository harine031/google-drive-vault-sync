import { Platform, requestUrl } from "obsidian";

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

interface OAuthErrorResponse {
  error?: string;
  error_description?: string;
}

interface AccessToken {
  value: string;
  expiresAt: number;
}

interface DesktopAuthResult {
  refreshToken: string;
  accessToken: string;
  expiresIn: number;
}

interface NodeResponseLike {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body: string): void;
}

interface NodeServerLike {
  listen(port: number, host: string, callback: () => void): void;
  address(): { port: number } | string | null;
  close(): void;
}

type NodeHttpModule = {
  createServer(callback: (request: { url?: string }, response: NodeResponseLike) => void): NodeServerLike;
};

declare global {
  interface Window {
    require?: (moduleName: string) => unknown;
  }
}

export class GoogleAuth {
  private accessToken: AccessToken | null = null;

  constructor(
    private readonly getClientId: () => string,
    private readonly getClientSecret: () => string,
    private readonly getRefreshToken: () => string,
    private readonly onRefreshToken: (token: string) => Promise<void>
  ) {}

  async getValidAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) {
      return this.accessToken.value;
    }
    const clientId = this.getClientId().trim();
    const clientSecret = this.getClientSecret().trim();
    const refreshToken = this.getRefreshToken().trim();
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error("Google OAuthのクライアントID、クライアントシークレット、リフレッシュトークンが必要です");
    }
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    }).toString();
    const response = await requestUrl({
      url: "https://oauth2.googleapis.com/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Google OAuth更新に失敗しました (${response.status})`);
    }
    const token = response.json as TokenResponse;
    this.accessToken = {
      value: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000
    };
    return this.accessToken.value;
  }

  async connectDesktop(): Promise<void> {
    if (!Platform.isDesktopApp) {
      throw new Error("iPhoneではWindowsで作成した暗号化ペアリングコードを読み込んでください");
    }
    const clientId = this.getClientId().trim();
    const clientSecret = this.getClientSecret().trim();
    if (!clientId || !clientSecret) {
      throw new Error("先にGoogle OAuthクライアントIDとクライアントシークレットを入力してください");
    }
    const http = window.require?.("http") as NodeHttpModule | undefined;
    if (!http) throw new Error("デスクトップのHTTPリスナーを開始できません");

    const verifier = randomUrlSafeString(64);
    const challenge = await sha256Base64Url(verifier);
    const state = randomUrlSafeString(32);
    const result = await new Promise<DesktopAuthResult>((resolve, reject) => {
      let redirectUri = "";
      const server = http.createServer((request, response) => {
        void (async () => {
          try {
            const callbackUrl = new URL(request.url ?? "/", redirectUri);
            if (callbackUrl.pathname !== "/oauth2callback") {
              response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
              response.end("Not found");
              return;
            }
            if (callbackUrl.searchParams.get("state") !== state) {
              throw new Error("OAuth stateが一致しません");
            }
            const code = callbackUrl.searchParams.get("code");
            if (!code) throw new Error(callbackUrl.searchParams.get("error") ?? "認証コードがありません");
            const token = await exchangeCode(clientId, clientSecret, code, verifier, redirectUri);
            if (!token.refresh_token) throw new Error("リフレッシュトークンを取得できませんでした");
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end("<h1>Google Drive Vault Sync</h1><p>認証が完了しました。この画面を閉じてObsidianへ戻ってください。</p>");
            resolve({
              refreshToken: token.refresh_token,
              accessToken: token.access_token,
              expiresIn: token.expires_in
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : "不明なOAuthエラー";
            response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            response.end(
              `<h1>Google Drive Vault Sync</h1><p>OAuth認証に失敗しました。</p>` +
              `<pre>${escapeHtml(message)}</pre><p>この内容を確認してObsidianへ戻ってください。</p>`
            );
            reject(new Error(message));
          } finally {
            server.close();
          }
        })();
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("OAuthコールバック用ポートを取得できません"));
          return;
        }
        redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
        const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        authorizeUrl.search = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "https://www.googleapis.com/auth/drive.file",
          access_type: "offline",
          prompt: "consent",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state
        }).toString();
        window.open(authorizeUrl.toString(), "_blank", "noopener,noreferrer");
      });
      window.setTimeout(() => {
        server.close();
        reject(new Error("Google OAuthが3分以内に完了しませんでした"));
      }, 180_000);
    });

    await this.onRefreshToken(result.refreshToken);
    this.accessToken = {
      value: result.accessToken,
      expiresAt: Date.now() + result.expiresIn * 1000
    };
  }

  disconnect(): void {
    this.accessToken = null;
  }
}

async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  verifier: string,
  redirectUri: string
): Promise<TokenResponse> {
  const response = await requestUrl({
    url: "https://oauth2.googleapis.com/token",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    }).toString(),
    throw: false
  });
  if (response.status < 200 || response.status >= 300) {
    const details = response.json as OAuthErrorResponse | undefined;
    const errorName = safeOAuthText(details?.error) || "unknown_error";
    const description = safeOAuthText(details?.error_description);
    throw new Error(
      `認証コードの交換に失敗しました (${response.status}: ${errorName})` +
      (description ? ` — ${description}` : "")
    );
  }
  return response.json as TokenResponse;
}

function randomUrlSafeString(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeOAuthText(value: string | undefined): string {
  if (!value) return "";
  return value.replace(/[^\p{L}\p{N} .,:;_\-()/'@]/gu, "").slice(0, 300);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
