import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { sendJson } from "./http-utils.mjs";

function hashPassword(password, salt = randomBytes(16).toString("base64url"), iterations = 210000) {
  const passwordHash = pbkdf2Sync(String(password), salt, iterations, 32, "sha256").toString("base64url");
  return { passwordHash, salt, iterations };
}

function hashSessionToken(token) {
  return createHash("sha256").update(String(token)).digest("base64url");
}

function parseCookies(request) {
  const cookies = new Map();
  for (const part of String(request.headers.cookie || "").split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) continue;
    cookies.set(rawName, decodeURIComponent(rawValue.join("=") || ""));
  }
  return cookies;
}

function safeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function wantsHtml(request) {
  return String(request.headers.accept || "").includes("text/html");
}

export function safeNextPath(value) {
  const next = String(value || "/");
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\") || next.includes("\n") || next.includes("\r")) return "/";
  return next;
}

export function createAuthController({
  cookieName = "ldb_session",
  escapeHtml,
  passwordFilePath,
  sessionMaxAgeSeconds = 7 * 24 * 60 * 60,
  statements,
  username = "admin",
}) {
  const sessions = new Map();
  let state = null;

  async function resolveBootstrapPassword() {
    if (process.env.APP_PASSWORD) return String(process.env.APP_PASSWORD);

    try {
      const savedPassword = (await readFile(passwordFilePath, "utf8")).trim();
      if (savedPassword) return savedPassword;
    } catch {
      // No saved password yet; generate one below.
    }

    const generatedPassword = randomBytes(18).toString("base64url");
    await writeFile(passwordFilePath, generatedPassword, { mode: 0o600 });
    return generatedPassword;
  }

  async function initialize() {
    const configuredPassword = process.env.APP_PASSWORD ? String(process.env.APP_PASSWORD) : "";
    const existingUser = statements.authUserByUsername.get(username);

    if (existingUser && !configuredPassword) {
      state = {
        source: "sqlite",
        username: existingUser.username,
        user: existingUser,
      };
      return state;
    }

    const password = configuredPassword || (await resolveBootstrapPassword());
    const hashed = hashPassword(password);
    statements.upsertAuthUser.run({
      username,
      password_hash: hashed.passwordHash,
      password_salt: hashed.salt,
      password_iterations: hashed.iterations,
      updated_at: Date.now(),
    });

    state = {
      source: configuredPassword ? "APP_PASSWORD migrated to sqlite" : existingUser ? "password file migrated to sqlite" : "generated password migrated to sqlite",
      username,
      user: statements.authUserByUsername.get(username),
    };
    return state;
  }

  function loginPage(error = "", next = "/") {
    const safeNext = safeNextPath(next);
    return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · 可米 KomiOS</title>
<style>
  :root { color-scheme: light; --bg:#f6f7f9; --panel:#fff; --text:#1d252f; --muted:#687483; --line:#d9e0e7; --accent:#0f766e; }
  * { box-sizing: border-box; }
  body { display:grid; place-items:center; min-height:100vh; margin:0; background:var(--bg); color:var(--text); font-family:"Segoe UI","Microsoft YaHei",Arial,sans-serif; }
  main { width:min(380px, calc(100vw - 32px)); padding:28px; border:1px solid var(--line); border-radius:8px; background:var(--panel); box-shadow:0 18px 45px rgba(30,41,59,.12); }
  h1 { margin:0 0 6px; font-size:24px; }
  p { margin:0 0 18px; color:var(--muted); font-size:14px; }
  label { display:grid; gap:8px; color:var(--muted); font-size:13px; }
  input { min-height:42px; padding:0 12px; border:1px solid var(--line); border-radius:8px; font:inherit; }
  button { width:100%; min-height:42px; margin-top:14px; border:1px solid var(--accent); border-radius:8px; background:var(--accent); color:#fff; font:inherit; cursor:pointer; }
  .error { margin:0 0 12px; color:#b42318; }
</style>
<main>
  <h1>可米 KomiOS</h1>
  <p>请输入访问账号。</p>
  ${error ? `<p class="error">${error}</p>` : ""}
  <form method="post" action="/api/login">
    <input name="next" type="hidden" value="${escapeHtml(safeNext)}">
    <label>用户名
      <input name="username" type="text" value="${escapeHtml(state?.username || username)}" autofocus autocomplete="username">
    </label>
    <label>密码
      <input name="password" type="password" autocomplete="current-password">
    </label>
    <button type="submit">登录</button>
  </form>
</main>`;
  }

  function verifyLogin(candidateUsername, password) {
    if (!state?.user) return false;
    if (!safeEqualText(candidateUsername, state.user.username)) return false;
    const actualPassword = hashPassword(password, state.user.password_salt, state.user.password_iterations);
    return safeEqualText(actualPassword.passwordHash, state.user.password_hash);
  }

  function isEnabled() {
    return Boolean(state?.user);
  }

  function isAuthenticated(request) {
    if (!isEnabled()) return true;
    const token = parseCookies(request).get(cookieName);
    if (!token) return false;
    const now = Date.now();
    const tokenHash = hashSessionToken(token);
    let session = sessions.get(tokenHash);
    if (!session) {
      const persistedSession = statements.authSessionByTokenHash.get(tokenHash);
      if (persistedSession && persistedSession.expires_at > now) {
        session = { expiresAt: persistedSession.expires_at, username: persistedSession.username };
        sessions.set(tokenHash, session);
      }
    }
    if (!session || session.expiresAt <= Date.now() || session.username !== state.username) {
      sessions.delete(tokenHash);
      statements.deleteAuthSession.run(tokenHash);
      return false;
    }
    statements.touchAuthSession.run({ token_hash: tokenHash, last_seen_at: now });
    return true;
  }

  function createSession(response) {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashSessionToken(token);
    const now = Date.now();
    const expiresAt = now + sessionMaxAgeSeconds * 1000;
    sessions.set(tokenHash, { expiresAt, username: state.username });
    statements.upsertAuthSession.run({
      token_hash: tokenHash,
      username: state.username,
      expires_at: expiresAt,
      created_at: now,
      last_seen_at: now,
    });
    response.setHeader("set-cookie", `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionMaxAgeSeconds}`);
  }

  function clearSession(request, response) {
    const token = parseCookies(request).get(cookieName);
    if (token) {
      const tokenHash = hashSessionToken(token);
      sessions.delete(tokenHash);
      statements.deleteAuthSession.run(tokenHash);
    }
    response.setHeader("set-cookie", `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  function rejectUnauthenticated(request, response, url) {
    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 401, { error: "未登录" });
    } else if (wantsHtml(request)) {
      response.writeHead(302, { location: `/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}` });
      response.end();
    } else {
      response.writeHead(401, { "content-type": "text/plain;charset=utf-8" });
      response.end("Unauthorized");
    }
  }

  return {
    clearSession,
    createSession,
    initialize,
    isAuthenticated,
    isEnabled,
    loginPage,
    rejectUnauthenticated,
    safeNextPath,
    state: () => state,
    verifyLogin,
  };
}
