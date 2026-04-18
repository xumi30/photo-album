/**
 * 访客/用户鉴权（只用于“登录后可见”照片，不涉及后台管理权限）。
 *
 * - 登录：POST /api/photo-timeline/login { token }
 * - 会话：HttpOnly Cookie（默认 30 天），避免前端保存明文 token
 */
import crypto from "node:crypto";

const USER_SESSION_COOKIE = "pt_user_sess";
const USER_SESSION_TTL_SEC = 30 * 24 * 60 * 60;

function envTrim(name) {
  const v = process.env[name];
  return v != null ? String(v).trim() : "";
}

export function getUserSecret() {
  return envTrim("PHOTO_TIMELINE_USER_SECRET") || envTrim("USER_SECRET");
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function parseCookieHeader(header) {
  const out = {};
  const raw = String(header || "");
  if (!raw) return out;
  raw.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) return;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  });
  return out;
}

function base64UrlEncode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecodeToBuffer(s) {
  const str = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str + pad, "base64");
}

function hmacSha256B64Url(data, keyMaterial) {
  const key = crypto.createHash("sha256").update(String(keyMaterial), "utf8").digest();
  const mac = crypto.createHmac("sha256", key).update(data, "utf8").digest();
  return base64UrlEncode(mac);
}

function isSecureRequest(req) {
  const xf = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (xf === "https") return true;
  return Boolean(req.secure);
}

function appendSetCookie(res, cookieLine) {
  const prev = res.getHeader("Set-Cookie");
  if (!prev) {
    res.append("Set-Cookie", cookieLine);
    return;
  }
  const list = Array.isArray(prev) ? prev.slice() : [String(prev)];
  list.push(cookieLine);
  res.setHeader("Set-Cookie", list);
}

function buildUserSessionCookieValue(secret) {
  const exp = Math.floor(Date.now() / 1000) + USER_SESSION_TTL_SEC;
  const nonce = base64UrlEncode(crypto.randomBytes(16));
  const payload = JSON.stringify({ v: 1, exp, nonce });
  const payloadB64 = base64UrlEncode(Buffer.from(payload, "utf8"));
  const sig = hmacSha256B64Url(payloadB64, `${secret}\nuser-session-v1`);
  return `${payloadB64}.${sig}`;
}

function verifyUserSessionCookieValue(value, secret) {
  const raw = String(value || "").trim();
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return false;
  const payloadB64 = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expect = hmacSha256B64Url(payloadB64, `${secret}\nuser-session-v1`);
  try {
    if (!constantTimeEqual(sig, expect)) return false;
  } catch {
    return false;
  }
  let json = "";
  try {
    json = base64UrlDecodeToBuffer(payloadB64).toString("utf8");
  } catch {
    return false;
  }
  let obj = null;
  try {
    obj = JSON.parse(json);
  } catch {
    return false;
  }
  if (!obj || typeof obj !== "object") return false;
  const exp = Number(obj.exp);
  if (!Number.isFinite(exp)) return false;
  if (Math.floor(Date.now() / 1000) > exp) return false;
  return true;
}

export function isUserLoggedIn(req) {
  const secret = getUserSecret();
  if (!secret) return false;
  const cookies = parseCookieHeader(req.headers.cookie);
  return verifyUserSessionCookieValue(cookies[USER_SESSION_COOKIE], secret);
}

export function issueUserSessionCookie(req, res) {
  const secret = getUserSecret();
  if (!secret) {
    res.status(503).json({ ok: false, error: "未配置 PHOTO_TIMELINE_USER_SECRET" });
    return false;
  }
  const value = buildUserSessionCookieValue(secret);
  const secure = isSecureRequest(req) ? "; Secure" : "";
  appendSetCookie(
    res,
    `${USER_SESSION_COOKIE}=${value}; Path=/api/photo-timeline; HttpOnly; SameSite=Lax; Max-Age=${USER_SESSION_TTL_SEC}${secure}`
  );
  return true;
}

export function clearUserSessionCookie(req, res) {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  appendSetCookie(
    res,
    `${USER_SESSION_COOKIE}=; Path=/api/photo-timeline; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
  );
}

export function assertUserLoginToken(req, res, tokenRaw) {
  const secret = getUserSecret();
  if (!secret) {
    res.status(503).json({ ok: false, error: "未配置 PHOTO_TIMELINE_USER_SECRET" });
    return false;
  }
  const token = String(tokenRaw || "").trim();
  if (!token) {
    res.status(400).json({ ok: false, error: "缺少 token" });
    return false;
  }
  if (!constantTimeEqual(token, secret)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

