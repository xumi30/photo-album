const AUTH_STORAGE_KEY = "admin_photo_timeline_auth_v1";
const AUTH_TTL_MS = 10 * 60 * 1000;

function apiUrl(p) {
  const path = String(p || "");
  const base = window.location.pathname.startsWith("/photo-album/") ? "/photo-album" : "";
  return base + path;
}

const safeLocalStorage = {
  get(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_) {
      /* ignore */
    }
  },
  remove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (_) {
      /* ignore */
    }
  },
};

function readAuthRecord() {
  const raw = safeLocalStorage.get(AUTH_STORAGE_KEY);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.token !== "string" || !obj.token.trim()) return null;
    const exp = Number(obj.exp);
    if (!Number.isFinite(exp)) return null;
    return { token: obj.token.trim(), exp };
  } catch (_) {
    return null;
  }
}

function getToken() {
  const rec = readAuthRecord();
  if (!rec) return "";
  if (Date.now() > rec.exp) {
    safeLocalStorage.remove(AUTH_STORAGE_KEY);
    return "";
  }
  return rec.token;
}

function setToken(t) {
  const s = t != null ? String(t).trim() : "";
  if (!s) {
    safeLocalStorage.remove(AUTH_STORAGE_KEY);
    return;
  }
  safeLocalStorage.set(AUTH_STORAGE_KEY, JSON.stringify({ token: s, exp: Date.now() + AUTH_TTL_MS }));
}

function authHeaders() {
  const headers = { "Content-Type": "application/json" };
  const t = getToken();
  if (t) headers.Authorization = "Bearer " + t;
  return headers;
}

async function tryResumeWithCookieSession() {
  const r = await fetch(apiUrl("/api/admin/photo-timeline/entries"), {
    method: "GET",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
  });
  return r.ok;
}

async function logoutServer() {
  try {
    await fetch(apiUrl("/api/admin/logout"), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch (_) {
    /* ignore */
  }
}

const authOverlay = document.getElementById("authOverlay");
const authGateForm = document.getElementById("authGateForm");
const authSecretInput = document.getElementById("authSecretInput");
const authVerifyBtn = document.getElementById("authVerifyBtn");
const authOverlayMsg = document.getElementById("authOverlayMsg");
const mainSheet = document.querySelector("main.sheet");

function setAuthOverlayMsg(text, isErr) {
  if (!authOverlayMsg) return;
  authOverlayMsg.textContent = text || "";
  authOverlayMsg.classList.toggle("is-err", !!isErr);
}

function showAuthGate(hint) {
  if (!authOverlay) return;
  authOverlay.hidden = false;
  setAuthOverlayMsg(hint || "", !!hint);
  if (mainSheet) mainSheet.setAttribute("inert", "");
  requestAnimationFrame(() => {
    try {
      authSecretInput?.focus();
    } catch (_) {
      /* ignore */
    }
  });
}

function hideAuthGate() {
  if (!authOverlay) return;
  authOverlay.hidden = true;
  setAuthOverlayMsg("", false);
  if (mainSheet) mainSheet.removeAttribute("inert");
}

async function refreshAuthGate() {
  if (getToken()) {
    hideAuthGate();
    return;
  }
  const cookieOk = await tryResumeWithCookieSession();
  if (cookieOk) {
    hideAuthGate();
    return;
  }
  showAuthGate();
}

async function submitAuthVerify() {
  setAuthOverlayMsg("");
  const t = authSecretInput ? String(authSecretInput.value || "").trim() : "";
  if (!t) {
    setAuthOverlayMsg("请输入密钥", true);
    return;
  }
  setToken(t);
  if (authVerifyBtn) authVerifyBtn.disabled = true;
  try {
    const r = await fetch(apiUrl("/api/admin/photo-timeline/entries"), {
      method: "GET",
      credentials: "same-origin",
      headers: authHeaders(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      setToken("");
      await logoutServer();
      if (r.status === 401) {
        setAuthOverlayMsg("密钥不正确或未授权", true);
      } else {
        const err =
          typeof data.error === "string"
            ? data.error
            : data.error && typeof data.error === "object"
              ? String(data.error.message || "")
              : "";
        setAuthOverlayMsg(err || r.statusText || String(r.status), true);
      }
      return;
    }
    if (authSecretInput) authSecretInput.value = "";
    hideAuthGate();
  } catch (e) {
    setToken("");
    await logoutServer();
    setAuthOverlayMsg(String((e && e.message) || e), true);
  } finally {
    if (authVerifyBtn) authVerifyBtn.disabled = false;
  }
}

function setGeoStatus(el, text, isErr) {
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("is-err", !!isErr);
}

const form = document.getElementById("uploadForm");
const fileInput = document.getElementById("fileInput");
const preview = document.getElementById("preview");
const fieldLat = document.getElementById("fieldLat");
const fieldLng = document.getElementById("fieldLng");
const btnGeo = document.getElementById("btnGeo");
const geoStatus = document.getElementById("geoStatus");
const btnSubmit = document.getElementById("btnSubmit");
const formMsg = document.getElementById("formMsg");
const fieldPrivate = document.getElementById("fieldPrivate");

function setFormMsg(text, kind) {
  if (!formMsg) return;
  formMsg.textContent = text || "";
  formMsg.classList.remove("is-ok", "is-err");
  if (kind === "ok") formMsg.classList.add("is-ok");
  if (kind === "err") formMsg.classList.add("is-err");
}

function renderPreview(files) {
  if (!preview || !fileInput) return;
  preview.innerHTML = "";
  if (!files || !files.length) {
    preview.hidden = true;
    return;
  }
  preview.hidden = false;
  const list = Array.from(files).slice(0, 24);
  for (const f of list) {
    const wrap = document.createElement("div");
    wrap.className = "preview__item";
    const img = document.createElement("img");
    img.alt = f.name || "";
    wrap.appendChild(img);
    preview.appendChild(wrap);
    const url = URL.createObjectURL(f);
    img.onload = () => URL.revokeObjectURL(url);
    img.src = url;
  }
}

if (fileInput) {
  fileInput.addEventListener("change", () => renderPreview(fileInput.files));
}

if (btnGeo) {
  btnGeo.addEventListener("click", () => {
    setGeoStatus(geoStatus, "");
    if (!navigator.geolocation) {
      setGeoStatus(geoStatus, "当前环境不支持定位", true);
      return;
    }
    btnGeo.disabled = true;
    setGeoStatus(geoStatus, "定位中…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btnGeo.disabled = false;
        const la = pos.coords.latitude;
        const ln = pos.coords.longitude;
        if (fieldLat) fieldLat.value = la.toFixed(6);
        if (fieldLng) fieldLng.value = ln.toFixed(6);
        setGeoStatus(geoStatus, "已填入 WGS84 坐标");
      },
      (err) => {
        btnGeo.disabled = false;
        setGeoStatus(geoStatus, String(err && err.message ? err.message : "无法获取定位"), true);
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 }
    );
  });
}

if (authGateForm) {
  authGateForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    await submitAuthVerify();
  });
}

void refreshAuthGate();

if (form) {
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    setFormMsg("");

    if (!getToken()) {
      const cookieOk = await tryResumeWithCookieSession();
      if (!cookieOk) {
        showAuthGate("请先完成后台验证再上传。");
        setFormMsg("需要验证：请在弹出卡片中输入密钥。", "err");
        return;
      }
    }

    const t = getToken();
    const files = fileInput && fileInput.files ? fileInput.files : null;
    if (!files || !files.length) {
      setFormMsg("请选择图片文件", "err");
      return;
    }

    const fd = new FormData(form);
    fd.delete("files");
    for (let i = 0; i < files.length; i++) {
      fd.append("files", files[i]);
    }

    if (fieldPrivate && fieldPrivate.checked) {
      fd.set("visibility", "private");
    } else {
      fd.set("visibility", "public");
    }

    const headers = {};
    if (t) headers.Authorization = "Bearer " + t;

    btnSubmit.disabled = true;
    setFormMsg("上传中…");

    try {
      const res = await fetch(apiUrl("/api/admin/photo-timeline/upload"), {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          setToken("");
          await logoutServer();
          showAuthGate("会话已失效，请重新输入密钥。");
          throw new Error("unauthorized");
        }
        const errRaw = data.error;
        const errStr =
          typeof errRaw === "string"
            ? errRaw
            : errRaw && typeof errRaw === "object" && errRaw.message
              ? String(errRaw.message)
              : res.statusText || String(res.status);
        throw new Error(errStr);
      }
      if (!data.ok) throw new Error(typeof data.error === "string" ? data.error : "上传失败");
      setFormMsg("已上传并写入时间轴。", "ok");
      form.reset();
      renderPreview(null);
      if (data.entry && data.entry.id) {
        const go = window.confirm("条目已创建，是否打开时间轴查看？");
        if (go) {
          window.location.href = "./photo-timeline.html#entry=" + encodeURIComponent(String(data.entry.id));
        }
      }
    } catch (e) {
      let msg = String(e && e.message ? e.message : e);
      if (msg === "unauthorized" || /401/.test(msg)) {
        msg = "未授权：请验证密钥后再上传。";
      }
      setFormMsg(msg, "err");
    } finally {
      btnSubmit.disabled = false;
    }
  });
}
