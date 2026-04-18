/**
 * 后台鉴权：
 * - Authorization: Bearer <token> 与 server/.env 的 ADMIN_SECRET 做字符串对比（常量时间）
 * - 或携带短期 HttpOnly Cookie（10 分钟），避免频繁粘贴密钥
 */
import crypto from "node:crypto";

const ADMIN_SESSION_COOKIE = "admin_pt_sess";
const ADMIN_SESSION_TTL_SEC = 10 * 60;

function envTrim(name) {
  const v = process.env[name];
  return v != null ? String(v).trim() : "";
}

export function getWriteSecret() {
  return envTrim("ADMIN_SECRET") || envTrim("PHOTO_TIMELINE_SYNC_SECRET");
}

export function isLegacySyncSecretOnly() {
  return !envTrim("ADMIN_SECRET") && !!envTrim("PHOTO_TIMELINE_SYNC_SECRET");
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

function buildAdminSessionCookieValue(secret) {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL_SEC;
  const nonce = base64UrlEncode(crypto.randomBytes(16));
  const payload = JSON.stringify({ v: 1, exp, nonce });
  const payloadB64 = base64UrlEncode(Buffer.from(payload, "utf8"));
  const sig = hmacSha256B64Url(payloadB64, `${secret}\nadmin-session-v1`);
  return `${payloadB64}.${sig}`;
}

function verifyAdminSessionCookieValue(value, secret) {
  const raw = String(value || "").trim();
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return false;
  const payloadB64 = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expect = hmacSha256B64Url(payloadB64, `${secret}\nadmin-session-v1`);
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

function issueAdminSessionCookie(req, res, secret) {
  const value = buildAdminSessionCookieValue(secret);
  const secure = isSecureRequest(req) ? "; Secure" : "";
  const line = `${ADMIN_SESSION_COOKIE}=${value}; Path=/api/admin; HttpOnly; SameSite=Lax; Max-Age=${ADMIN_SESSION_TTL_SEC}${secure}`;
  appendSetCookie(res, line);
}

function clearAdminSessionCookie(req, res) {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  appendSetCookie(res, `${ADMIN_SESSION_COOKIE}=; Path=/api/admin; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

export function assertAdminBearerAuth(req, res) {
  const secret = getWriteSecret();
  if (!secret) {
    res.status(503).json({ ok: false, error: "未配置 ADMIN_SECRET" });
    return false;
  }

  const raw = String(req.headers.authorization ?? "");
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  const token = m ? m[1].trim() : "";

  const cookies = parseCookieHeader(req.headers.cookie);
  const sessionOk = verifyAdminSessionCookieValue(cookies[ADMIN_SESSION_COOKIE], secret);

  if (m && constantTimeEqual(token, secret)) {
    issueAdminSessionCookie(req, res, secret);
    return true;
  }

  if (sessionOk) {
    issueAdminSessionCookie(req, res, secret);
    return true;
  }

  res.status(401).json({
    ok: false,
    error: "unauthorized",
    compare: {
      bearerTokenLength: token.length,
      envSecretLength: secret.length,
      lengthsEqual: token.length === secret.length,
      bytesEqual: token === secret,
    },
  });
  return false;
}

export function clearAdminAuthCookies(req, res) {
  clearAdminSessionCookie(req, res);
}

