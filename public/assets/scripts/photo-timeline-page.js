(function () {
  const boot = window.PHOTO_TIMELINE_CONFIG;
  const hasInline = boot && Array.isArray(boot.entries) && boot.entries.length > 0;
  const hasRemote = boot && typeof boot.dataUrl === "string" && boot.dataUrl.trim() !== "";
  const hasApi =
    boot &&
    boot.dataSource === "api" &&
    typeof boot.entriesUrl === "string" &&
    boot.entriesUrl.trim() !== "";
  if (!boot || (!hasInline && !hasRemote && !hasApi)) {
    return;
  }

  let allEntries = hasInline ? boot.entries.slice() : [];
  let nextChunkUrl = null;
  let pageSize = typeof boot.pageSize === "number" && boot.pageSize > 0 ? boot.pageSize : 5;
  let chunkLoading = false;
  let remoteTotal = allEntries.length;
  let availableTags = [];
  let availablePlaces = [];
  let availablePlaceGroups = [];
  let apiRequestSeq = 0;
  let remoteMinDate = "";
  let remoteMaxDate = "";

  const $ = (id) => document.getElementById(id);

  const state = {
    query: "",
    tags: new Set(),
    sortDesc: true,
    pageIndex: 0,
    expanded: new Set(),
    lightbox: { entryId: null, index: 0, merged: null, videoMuted: true, liveCleanup: null }
  };

  const searchInput = $("searchInput");
  const sortSelect = $("sortSelect");
  const jumpDateInput = $("jumpDateInput");
  const jumpDateBtn = $("jumpDateBtn");
  const yearJumpWrap = $("yearJumpWrap");
  const timeRail = $("timeRail");
  const timeRailToggle = $("timeRailToggle");
  const timeRailPanel = $("timeRailPanel");
  const tagWrap = $("tagWrap");
  const countText = $("countText");
  const userAuthBtn = $("userAuthBtn");
  const clearBtn = $("clearBtn");
  const timeline = $("timeline");
  const loadMore = $("loadMore");
  const emptyState = $("emptyState");
  const lightbox = $("lightbox");
  const lightboxImage = $("lightboxImage");
  const lightboxMeta = $("lightboxMeta");
  const lightboxCaption = $("lightboxCaption");
  const prevBtn = $("prevBtn");
  const nextBtn = $("nextBtn");
  const lightboxClose = $("lightboxClose");
  const lightboxVideo = $("lightboxVideo");
  const lightboxPhoto = $("lightboxPhoto");
  const lightboxMuteBtn = $("lightboxMuteBtn");
  const lightboxMuteIcon = $("lightboxMuteIcon");

  let cardObserver;
  let imageObserver;
  let mediaUnloadObserver;
  const VIEW_STATE_KEY = "photo-timeline:view-state:v1";
  const HASH_PREFIX = "#entry=";

  const normText = (value) => String(value || "").toLowerCase();
  const hasActiveQuery = () => String(state.query || "").trim() !== "";

  const appendHighlightedText = (parent, text, query = state.query) => {
    const source = String(text || "");
    const needle = String(query || "").trim();
    if (!needle) {
      parent.appendChild(document.createTextNode(source));
      return;
    }
    const lowerSource = source.toLowerCase();
    const lowerNeedle = needle.toLowerCase();
    let start = 0;
    let index = lowerSource.indexOf(lowerNeedle, start);
    if (index < 0) {
      parent.appendChild(document.createTextNode(source));
      return;
    }
    while (index >= 0) {
      if (index > start) {
        parent.appendChild(document.createTextNode(source.slice(start, index)));
      }
      const mark = document.createElement("mark");
      mark.className = "search-hit";
      mark.textContent = source.slice(index, index + needle.length);
      parent.appendChild(mark);
      start = index + needle.length;
      index = lowerSource.indexOf(lowerNeedle, start);
    }
    if (start < source.length) {
      parent.appendChild(document.createTextNode(source.slice(start)));
    }
  };

  const debounce = (fn, wait) => {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  };

  const safeSessionStorage = {
    get(key) {
      try {
        return window.sessionStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        window.sessionStorage.setItem(key, value);
      } catch {
        /* ignore */
      }
    },
  };

  const parseHashEntryId = () => {
    const raw = String(window.location.hash || "");
    if (!raw.startsWith(HASH_PREFIX)) return "";
    try {
      return decodeURIComponent(raw.slice(HASH_PREFIX.length));
    } catch {
      return raw.slice(HASH_PREFIX.length);
    }
  };

  const replaceHashEntryId = (entryId) => {
    const nextHash = entryId ? `${HASH_PREFIX}${encodeURIComponent(entryId)}` : "";
    if (window.location.hash === nextHash) return;
    const url = new URL(window.location.href);
    url.hash = nextHash;
    history.replaceState(null, "", url.toString());
  };

  const readSavedViewState = () => {
    const raw = safeSessionStorage.get(VIEW_STATE_KEY);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      return data && typeof data === "object" ? data : null;
    } catch {
      return null;
    }
  };

  const escapeHtml = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const resolveUrl = (u) => {
    try {
      return new URL(u, window.location.href).href;
    } catch {
      return u;
    }
  };

  const fetchJson = async (url) => {
    const res = await fetch(resolveUrl(url), { credentials: "same-origin" });
    if (!res.ok) throw new Error(res.statusText || String(res.status));
    return res.json();
  };

  const postJson = async (url, bodyObj) => {
    const res = await fetch(resolveUrl(url), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyObj != null ? bodyObj : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || String(res.status));
    return data;
  };

  let userSession = { hasSecret: false, loggedIn: false };

  const updateUserAuthBtnUi = () => {
    if (!userAuthBtn) return;
    if (!hasApi) {
      userAuthBtn.style.display = "none";
      return;
    }
    if (!userSession.hasSecret) {
      userAuthBtn.textContent = "登录（未配置）";
      userAuthBtn.title = "服务端未配置 PHOTO_TIMELINE_USER_SECRET";
      userAuthBtn.disabled = true;
      return;
    }
    userAuthBtn.disabled = false;
    userAuthBtn.textContent = userSession.loggedIn ? "退出" : "登录";
    userAuthBtn.title = userSession.loggedIn ? "退出登录" : "登录后可查看“需登录”的照片";
  };

  const refreshUserSession = async () => {
    if (!hasApi || !userAuthBtn) return;
    try {
      const data = await fetchJson("/api/photo-timeline/session");
      userSession = {
        hasSecret: !!(data && data.hasSecret),
        loggedIn: !!(data && data.loggedIn),
      };
    } catch {
      userSession = { hasSecret: false, loggedIn: false };
    }
    updateUserAuthBtnUi();
  };

  const buildApiEntriesUrl = (options = {}) => {
    const url = new URL(resolveUrl(boot.entriesUrl), window.location.href);
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
    const limit = Math.max(1, Math.floor(Number(options.limit) || pageSize));
    url.searchParams.set("sort", state.sortDesc ? "desc" : "asc");
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", String(limit));
    const q = String(state.query || "").trim();
    if (q) url.searchParams.set("q", q);
    if (options.anchorDate) url.searchParams.set("anchorDate", String(options.anchorDate));
    Array.from(state.tags)
      .sort()
      .forEach((tag) => url.searchParams.append("tag", tag));
    return url.toString();
  };

  const applyApiPayload = (data, options = {}) => {
    if (typeof data.pageSize === "number" && data.pageSize > 0) {
      pageSize = data.pageSize;
    }
    const list = Array.isArray(data.entries) ? data.entries.slice() : [];
    allEntries = options.append ? allEntries.concat(list) : list;
    remoteTotal =
      typeof data.total === "number" && data.total >= 0 ? Math.floor(data.total) : allEntries.length;
    availableTags = Array.isArray(data.availableTags) ? data.availableTags.slice() : [];
    availablePlaces = Array.isArray(data.availablePlaces) ? data.availablePlaces.slice() : [];
    availablePlaceGroups = Array.isArray(data.availablePlaceGroups)
      ? data.availablePlaceGroups.slice()
      : [];
    remoteMinDate = typeof data.minDate === "string" ? data.minDate : "";
    remoteMaxDate = typeof data.maxDate === "string" ? data.maxDate : "";
    const nextOffset =
      typeof data.nextOffset === "number" && data.nextOffset >= 0 ? Math.floor(data.nextOffset) : null;
    nextChunkUrl = nextOffset != null ? buildApiEntriesUrl({ offset: nextOffset, limit: pageSize }) : null;
    state.pageIndex = Math.max(0, Math.ceil(allEntries.length / pageSize) - 1);
  };

  const fetchApiEntries = async (options = {}) => {
    const requestId = ++apiRequestSeq;
    const data = await fetchJson(
      buildApiEntriesUrl({
        offset: options.offset || 0,
        limit: options.limit || pageSize,
        anchorDate: options.anchorDate || "",
      })
    );
    if (requestId !== apiRequestSeq) return null;
    applyApiPayload(data, options);
    return data;
  };

  const reloadEntriesFromApi = async () => {
    if (!hasApi) return;
    await fetchApiEntries({
      offset: 0,
      limit: Math.max(pageSize, allEntries.length || pageSize),
      append: false,
    });
  };

  if (userAuthBtn) {
    updateUserAuthBtnUi();
    refreshUserSession();
    userAuthBtn.addEventListener("click", async function () {
      if (!hasApi) return;
      try {
        if (userSession.loggedIn) {
          await postJson("/api/photo-timeline/logout", {});
          await refreshUserSession();
          await reloadEntriesFromApi();
          render();
          return;
        }

        if (!userSession.hasSecret) {
          throw new Error("服务端未配置 PHOTO_TIMELINE_USER_SECRET");
        }

        var token = window.prompt("输入访问口令（登录后可查看“需登录”的照片）");
        if (!String(token || "").trim()) return;
        await postJson("/api/photo-timeline/login", { token: String(token || "").trim() });
        await refreshUserSession();
        await reloadEntriesFromApi();
        render();
      } catch (e) {
        window.alert(String((e && e.message) || e));
      }
    });
  }

  const resolveGpsLabelRemote = async (entryId, alsoEntryIds) => {
    const url = resolveUrl(
      `/api/photo-timeline/entry/${encodeURIComponent(entryId)}/resolve-location`
    );
    const res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alsoEntryIds: alsoEntryIds || [] }),
    });
    let j = {};
    try {
      j = await res.json();
    } catch {
      j = {};
    }
    if (!res.ok) throw new Error(j.error || j.message || res.statusText || String(res.status));
    return j;
  };

  const runResolveGpsLabel = async (entry, alsoEntryIds) => {
    if (!hasApi) return;
    delete entry._locationError;
    entry._locationLoading = true;
    render();
    try {
      await resolveGpsLabelRemote(entry.id, alsoEntryIds);
      await reloadEntriesFromApi();
    } catch (e) {
      entry._locationError = String((e && e.message) || e).slice(0, 120);
    } finally {
      delete entry._locationLoading;
      render();
    }
  };

  const mergeChunk = (chunk) => {
    if (!chunk || typeof chunk !== "object") return;
    if (typeof chunk.pageSize === "number" && chunk.pageSize > 0) {
      pageSize = chunk.pageSize;
    }
    const list = chunk.entries;
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) {
        allEntries.push(list[i]);
      }
    }
    const nu = chunk.nextUrl != null ? chunk.nextUrl : chunk.next_url;
    nextChunkUrl = nu != null && String(nu).trim() !== "" ? String(nu).trim() : null;
  };

  const listImageSrc = (photo) => (photo.thumb && String(photo.thumb).trim()) || photo.src;

  const ensureCardVideoSource = (video) => {
    if (!video) return;
    const src = String(video.dataset.videoSrc || "").trim();
    if (!src) return;
    if (video.dataset.videoLoaded === "1" && video.getAttribute("src") === src) return;
    video.src = src;
    video.dataset.videoLoaded = "1";
    video.load();
  };

  const unloadCardVideoSource = (video) => {
    if (!video || video.dataset.videoLoaded !== "1") return;
    video.pause();
    video.removeAttribute("src");
    video.load();
    delete video.dataset.videoLoaded;
  };

  const toDateText = (str) => {
    const d = new Date(str + "T00:00:00");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${month}-${day}`;
  };

  const toWeekText = (str) =>
    ["日", "一", "二", "三", "四", "五", "六"][new Date(str + "T00:00:00").getDay()];

  /** 本地日历日 YYYY-MM-DD，与日期栏展示一致；用于合并「同一天」多条记录 */
  const calendarDayKey = (str) => {
    const s = String(str || "").trim();
    if (!s) return "";
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return toDateText(m[1]);
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return "";
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${month}-${day}`;
  };

  /**
   * 按日历日合并条目，保持当前列表顺序（同一天内顺序不变）。
   */
  const groupEntriesByCalendarDay = (entries) => {
    const order = [];
    const seen = new Set();
    const map = new Map();
    for (const e of entries) {
      let k = calendarDayKey(e.date);
      if (!k) k = `__${e.id || "entry"}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(e);
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    }
    return order.map((k) => ({ dayKey: k, entries: map.get(k) || [] }));
  };

  const getGpsCoords = (gps) => {
    if (!gps || typeof gps !== "object") return null;
    const lat = gps.latitude != null ? gps.latitude : gps.lat;
    const lng =
      gps.longitude != null ? gps.longitude : gps.lng != null ? gps.lng : gps.lon;
    if (lat == null || lng == null) return null;
    const la = Number(lat);
    const ln = Number(lng);
    if (Number.isNaN(la) || Number.isNaN(ln)) return null;
    return { lat: la, lng: ln };
  };

  /**
   * 照片 EXIF 多为 WGS84；高德、国内图商底图为 GCJ-02。直接混用会偏几百米。
   * 打开高德 Web URI 前需转换；OpenStreetMap 使用 WGS84，无需转换。
   */
  const wgs84ToGcj02 = (lat, lng) => {
    const PI = Math.PI;
    const outOfChina = (la, ln) => ln < 72.004 || ln > 137.8347 || la < 0.8293 || la > 55.8271;
    if (outOfChina(lat, lng)) return { lat, lng };

    const transformLat = (ln, la) => {
      let ret =
        -100.0 +
        2.0 * ln +
        3.0 * la +
        0.2 * la * la +
        0.1 * ln * la +
        0.2 * Math.sqrt(Math.abs(ln));
      ret += ((20.0 * Math.sin(6.0 * ln * PI) + 20.0 * Math.sin(2.0 * ln * PI)) * 2.0) / 3.0;
      ret += ((20.0 * Math.sin(la * PI) + 40.0 * Math.sin((la / 3.0) * PI)) * 2.0) / 3.0;
      ret +=
        ((160.0 * Math.sin((la / 12.0) * PI) + 320 * Math.sin((la * PI) / 30.0)) * 2.0) / 3.0;
      return ret;
    };
    const transformLng = (ln, la) => {
      let ret =
        300.0 +
        ln +
        2.0 * la +
        0.1 * ln * ln +
        0.1 * ln * la +
        0.1 * Math.sqrt(Math.abs(ln));
      ret += ((20.0 * Math.sin(6.0 * ln * PI) + 20.0 * Math.sin(2.0 * ln * PI)) * 2.0) / 3.0;
      ret += ((20.0 * Math.sin(ln * PI) + 40.0 * Math.sin((ln / 3.0) * PI)) * 2.0) / 3.0;
      ret +=
        ((150.0 * Math.sin((ln / 12.0) * PI) + 300.0 * Math.sin((ln / 30.0) * PI)) * 2.0) / 3.0;
      return ret;
    };
    const a = 6378245.0;
    const ee = 0.00669342162296594323;
    let dLat = transformLat(lng - 105.0, lat - 35.0);
    let dLng = transformLng(lng - 105.0, lat - 35.0);
    const radLat = (lat / 180.0) * PI;
    let magic = Math.sin(radLat);
    magic = 1 - ee * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * PI);
    dLng = (dLng * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * PI);
    return { lat: lat + dLat, lng: lng + dLng };
  };

  /** 约百米级网格，相近坐标归为同一「地点」（与 server 一致：向零截断，非四舍五入） */
  const GEO_BUCKET_DECIMALS = 3;

  const truncateCoordToDecimals = (value, decimals) => {
    const f = 10 ** decimals;
    return Math.trunc(Number(value) * f) / f;
  };

  const locationBucketKey = (entry) => {
    const c = getGpsCoords(entry.gps);
    if (!c) return `__noloc__${entry.id || "entry"}`;
    const t = truncateCoordToDecimals(c.lat, GEO_BUCKET_DECIMALS);
    const u = truncateCoordToDecimals(c.lng, GEO_BUCKET_DECIMALS);
    const lat = t.toFixed(GEO_BUCKET_DECIMALS);
    const lng = u.toFixed(GEO_BUCKET_DECIMALS);
    return `geo_${lat}_${lng}`;
  };

  /**
   * 同一天内按地理位置分桶（顺序：先出现的桶序），无 GPS 的每条单独成桶。
   */
  const groupEntriesByLocation = (entries) => {
    const order = [];
    const seen = new Set();
    const map = new Map();
    for (const e of entries) {
      const k = locationBucketKey(e);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(e);
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    }
    return order.map((k) => ({ locationKey: k, entries: map.get(k) || [] }));
  };

  const ADMIN_TIMELINE_HREF_BASE = "/admin-photo-timeline.html";
  const ADMIN_CARD_ICON_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.07.63-.07.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>';

  /** 新标签打开后台并带上 entry，便于编辑该条元数据 */
  const appendAdminCornerLinks = (card, entryIds) => {
    const ids = Array.isArray(entryIds) ? entryIds.filter(Boolean) : [entryIds].filter(Boolean);
    if (!ids.length) return;
    const wrap = document.createElement("div");
    wrap.className = "day-card__admin-wrap";
    ids.forEach((id, idx) => {
      const a = document.createElement("a");
      a.className = "day-card__admin";
      const u = new URL(ADMIN_TIMELINE_HREF_BASE, window.location.origin);
      u.searchParams.set("entry", id);
      a.href = u.pathname + u.search;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title =
        ids.length > 1
          ? `后台编辑（${idx + 1}/${ids.length}）· ${id}`
          : "后台编辑此条";
      a.setAttribute("aria-label", "后台编辑 " + id);
      a.innerHTML = ADMIN_CARD_ICON_SVG;
      wrap.appendChild(a);
    });
    card.classList.add("day-card--has-admin");
    card.appendChild(wrap);
  };

  /** 同一天、同一地理桶（与分组逻辑一致），用于合并写回天气与地名 */
  const getLocationClusterPeers = (entry) => {
    const dk = calendarDayKey(entry.date);
    const lk = locationBucketKey(entry);
    return allEntries.filter(
      (e) => calendarDayKey(e.date) === dk && locationBucketKey(e) === lk
    );
  };

  const hasWeatherData = (entry) => {
    const w = entry.weather;
    if (!w || typeof w !== "object") return false;
    if (w.summary != null && String(w.summary).trim() !== "") return true;
    if (w.temp_high_c != null || w.temp_low_c != null) return true;
    return false;
  };

  const showWeatherRow = (entry) => hasWeatherData(entry) || getGpsCoords(entry.gps) != null;

  /** 天气经服务端请求 Open-Meteo；API 模式下由 POST …/fetch-weather 一并写库，无需浏览器 sync secret */
  const fetchWeatherAmap = async (entry) => {
    const c = getGpsCoords(entry.gps);
    if (!c || !entry.date) {
      entry._weatherError = "需要拍摄日与 GPS";
      delete entry._weatherLoading;
      render();
      return;
    }
    entry._weatherError = "";
    entry._weatherLoading = true;
    render();

    try {
      if (hasApi) {
        const url = resolveUrl(
          `/api/photo-timeline/entry/${encodeURIComponent(entry.id)}/fetch-weather`
        );
        const res = await fetch(url, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.statusText || String(res.status));
        if (!data.ok || !data.weather || typeof data.weather !== "object") {
          throw new Error(data.error || "无天气数据");
        }
        await reloadEntriesFromApi();
        delete entry._weatherLoading;
        delete entry._weatherError;
        delete entry._weatherPersistError;
        render();
        return;
      }

      const url = new URL(resolveUrl("/api/photo-timeline/weather"), window.location.href);
      url.searchParams.set("lat", String(c.lat));
      url.searchParams.set("lng", String(c.lng));
      url.searchParams.set("date", String(entry.date));
      const res = await fetch(url.toString(), { credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText || String(res.status));
      if (!data.ok || !data.weather || typeof data.weather !== "object") {
        throw new Error(data.error || "无天气数据");
      }

      if (!entry.weather || typeof entry.weather !== "object") entry.weather = {};
      Object.assign(entry.weather, data.weather);
      const w = { ...entry.weather };
      const peers = getLocationClusterPeers(entry);
      for (const e of peers) {
        if (!e.weather || typeof e.weather !== "object") e.weather = {};
        Object.assign(e.weather, w);
      }
      delete entry._weatherLoading;
      delete entry._weatherError;
      delete entry._weatherPersistError;
      render();
    } catch (err) {
      delete entry._weatherLoading;
      entry._weatherError = String((err && err.message) || err).slice(0, 120);
      render();
    }
  };

  const buildGpsRow = (entry, options = {}) => {
    const { resolveAlsoIds = [] } = options;
    const gps = entry.gps;
    if (!gps || typeof gps !== "object") return null;
    const coords = getGpsCoords(gps);
    const label = (gps.label && String(gps.label).trim()) || "";
    if (!coords && !label) return null;
    const wrap = document.createElement("p");
    wrap.className = "card-gps";
    if (label) {
      appendHighlightedText(wrap, label);
      if (coords) wrap.appendChild(document.createTextNode(" · "));
    }
    if (coords) {
      wrap.appendChild(
        document.createTextNode(`${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`)
      );
      const gcj = wgs84ToGcj02(coords.lat, coords.lng);
      const amapUrl = `https://uri.amap.com/marker?position=${encodeURIComponent(`${gcj.lng},${gcj.lat}`)}&name=${encodeURIComponent("拍摄位置")}`;
      const osmUrl = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(coords.lat)}&mlon=${encodeURIComponent(coords.lng)}#map=16/${coords.lat}/${coords.lng}`;

      const a = document.createElement("a");
      a.href = amapUrl;
      a.className = "card-gps__map";
      a.rel = "noopener noreferrer";
      a.target = "_blank";
      a.textContent = "高德";
      a.title =
        "高德地图（已把 WGS84 转为 GCJ-02，与国内底图对齐）。若无地名，点此会同时逆地理并保存";
      if (hasApi && !label) {
        a.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          window.open(amapUrl, "_blank", "noopener,noreferrer");
          if (!entry._locationLoading) runResolveGpsLabel(entry, resolveAlsoIds);
        });
      }
      wrap.appendChild(document.createTextNode(" "));
      wrap.appendChild(a);

      wrap.appendChild(document.createTextNode(" · "));
      const osm = document.createElement("a");
      osm.href = osmUrl;
      osm.className = "card-gps__map card-gps__map--osm";
      osm.rel = "noopener noreferrer";
      osm.target = "_blank";
      osm.textContent = "OSM";
      osm.title = "OpenStreetMap：使用原始 WGS84 坐标，无偏移（与国外/标准 GPS 一致）";
      wrap.appendChild(osm);
      if (entry._locationError) {
        const err = document.createElement("span");
        err.className = "card-gps__err";
        err.textContent = ` （${entry._locationError}）`;
        wrap.appendChild(err);
      }
    }
    return wrap;
  };

  const buildWeatherRow = (entry) => {
    if (!showWeatherRow(entry)) return null;
    const wrap = document.createElement("p");
    wrap.className = "card-weather";
    if (hasWeatherData(entry)) {
      const w = entry.weather;
      const parts = [];
      if (w.summary) parts.push(w.summary);
      if (w.temp_low_c != null || w.temp_high_c != null) {
        const lo = w.temp_low_c != null ? `${w.temp_low_c}°` : "—";
        const hi = w.temp_high_c != null ? `${w.temp_high_c}°` : "—";
        parts.push(`${lo}～${hi}`);
      }
      if (parts.length) {
        appendHighlightedText(wrap, `天气 · ${parts.join(" · ")}`);
      }
      const meta = [w.provider, w.fetched_at].filter(Boolean);
      if (w.provider === "open-meteo") {
        meta.push("数据来源：Open-Meteo Historical（旧版缓存）");
      } else if (w.provider === "amap") {
        meta.push("数据来源：高德开放平台");
        if (w.amap_detail) meta.push(String(w.amap_detail));
      }
      if (meta.length) wrap.title = meta.join(" · ");
      if (entry._weatherPersistError) {
        const err = document.createElement("span");
        err.className = "card-weather__err";
        err.textContent = ` （写回失败：${entry._weatherPersistError}）`;
        wrap.appendChild(err);
      }
    } else {
      wrap.classList.add("card-weather--pending");
      if (entry._weatherLoading) {
        wrap.classList.add("card-weather--loading");
        wrap.textContent = "天气 · 查询中…";
      } else {
        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "card-weather__trigger";
        trigger.textContent = "天气";
        trigger.title =
          "按拍摄日与 GPS 查询天气（高德开放平台，需在 server/.env 配置 AMAP_WEB_KEY）";
        trigger.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          fetchWeatherAmap(entry);
        });
        wrap.appendChild(trigger);
        wrap.appendChild(document.createTextNode(" · 点击查询当日天气"));
        if (entry._weatherError) {
          const err = document.createElement("span");
          err.className = "card-weather__err";
          err.textContent = ` （${entry._weatherError}）`;
          wrap.appendChild(err);
        }
      }
    }
    return wrap;
  };

  const getEntries = () => {
    if (hasApi) return allEntries.slice();
    const q = normText(state.query);
    const sorted = allEntries.slice().sort((a, b) =>
      state.sortDesc ? new Date(b.date) - new Date(a.date) : new Date(a.date) - new Date(b.date)
    );
    return sorted.filter((entry) => {
      if (state.tags.size > 0 && !(entry.tags || []).some((t) => state.tags.has(t))) return false;
      if (!q) return true;
      const w = entry.weather;
      const gpsBits = [];
      const g = entry.gps;
      if (g && typeof g === "object") {
        if (g.label) gpsBits.push(g.label);
        const c = getGpsCoords(g);
        if (c) gpsBits.push(String(c.lat), String(c.lng));
      }
      const wxBits = [];
      if (w && typeof w === "object") {
        if (w.summary) wxBits.push(w.summary);
        if (w.provider) wxBits.push(w.provider);
      }
      const text = [
        entry.title,
        entry.place,
        entry.note,
        ...(entry.tags || []),
        ...(entry.photos || []).map((p) => p.caption || ""),
        ...gpsBits,
        ...wxBits
      ].join(" ");
      return normText(text).indexOf(q) > -1;
    });
  };

  const getLightboxEntry = (entryId) => allEntries.find((item) => item.id === entryId);

  const findRenderedCardByEntryId = (entryId) => {
    if (!entryId) return null;
    const cards = timeline.querySelectorAll(".day-card[data-entry-ids]");
    for (const card of cards) {
      const ids = String(card.dataset.entryIds || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      if (ids.includes(entryId)) return card;
    }
    return null;
  };

  const getCurrentAnchorEntryId = () => {
    const cards = Array.from(timeline.querySelectorAll(".day-card[data-anchor-entry-id]"));
    if (!cards.length) return "";
    const topOffset = 140;
    let best = null;
    let bestTop = -Infinity;
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (rect.bottom <= topOffset) continue;
      if (rect.top <= topOffset && rect.top > bestTop) {
        best = card;
        bestTop = rect.top;
      }
    }
    if (!best) {
      best = cards.find((card) => card.getBoundingClientRect().bottom > topOffset) || cards[0];
    }
    return best ? String(best.dataset.anchorEntryId || "") : "";
  };

  const persistViewState = () => {
    const anchorEntryId = getCurrentAnchorEntryId();
    const payload = {
      query: state.query,
      tags: Array.from(state.tags),
      sortDesc: state.sortDesc,
      pageIndex: state.pageIndex,
      expanded: Array.from(state.expanded),
      anchorEntryId,
      scrollY: Math.max(0, Math.round(window.scrollY || 0)),
    };
    safeSessionStorage.set(VIEW_STATE_KEY, JSON.stringify(payload));
    if (anchorEntryId) replaceHashEntryId(anchorEntryId);
  };

  const persistViewStateSoon = debounce(persistViewState, 120);

  const applySavedUiState = (saved) => {
    if (!saved || typeof saved !== "object") return;
    if (typeof saved.query === "string") state.query = saved.query;
    if (typeof saved.sortDesc === "boolean") state.sortDesc = saved.sortDesc;
    if (typeof saved.pageIndex === "number" && saved.pageIndex >= 0) {
      state.pageIndex = Math.floor(saved.pageIndex);
    }
    if (Array.isArray(saved.tags)) {
      state.tags = new Set(saved.tags.filter((tag) => typeof tag === "string" && tag.trim()));
    }
    if (Array.isArray(saved.expanded)) {
      state.expanded = new Set(saved.expanded.filter((id) => typeof id === "string" && id.trim()));
    }
    searchInput.value = state.query;
    sortSelect.value = state.sortDesc ? "desc" : "asc";
  };

  const syncTagChipSelection = () => {
    Array.from(tagWrap.querySelectorAll(".chip")).forEach((chip) => {
      chip.classList.toggle("active", state.tags.has(chip.textContent || ""));
    });
  };

  const syncJumpDateControl = () => {
    if (!jumpDateInput) return;
    jumpDateInput.min = remoteMinDate || "";
    jumpDateInput.max = remoteMaxDate || "";
    const disabled = !hasApi || remoteTotal <= 0;
    jumpDateInput.disabled = disabled;
    if (jumpDateBtn) jumpDateBtn.disabled = disabled;
  };

  const getAvailableYears = () => {
    const years = [];
    const pushYear = (value) => {
      const year = Number(String(value || "").slice(0, 4));
      if (!Number.isInteger(year) || year < 1000 || year > 9999) return;
      if (!years.includes(year)) years.push(year);
    };
    if (hasApi) {
      pushYear(remoteMinDate);
      pushYear(remoteMaxDate);
      if (years.length === 2) {
        const minYear = Math.min(years[0], years[1]);
        const maxYear = Math.max(years[0], years[1]);
        const filled = [];
        for (let year = minYear; year <= maxYear; year++) filled.push(year);
        return state.sortDesc ? filled.reverse() : filled;
      }
      return years;
    }
    allEntries.forEach((entry) => pushYear(calendarDayKey(entry.date)));
    return years.sort((a, b) => (state.sortDesc ? b - a : a - b));
  };

  const buildYearAnchorDate = (year) => {
    const y = String(year);
    return state.sortDesc ? `${y}-12-31` : `${y}-01-01`;
  };

  const buildMonthAnchorDate = (year, month) => {
    const y = String(year);
    const m = String(month).padStart(2, "0");
    if (!state.sortDesc) return `${y}-${m}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    return `${y}-${m}-${String(lastDay).padStart(2, "0")}`;
  };

  const getAvailableMonths = () => {
    if (hasApi && remoteMinDate && remoteMaxDate) {
      const minYear = Number(remoteMinDate.slice(0, 4));
      const minMonth = Number(remoteMinDate.slice(5, 7));
      const maxYear = Number(remoteMaxDate.slice(0, 4));
      const maxMonth = Number(remoteMaxDate.slice(5, 7));
      if ([minYear, minMonth, maxYear, maxMonth].every(Number.isInteger)) {
        const list = [];
        let year = minYear;
        let month = minMonth;
        while (year < maxYear || (year === maxYear && month <= maxMonth)) {
          list.push({ year, month, key: `${year}-${String(month).padStart(2, "0")}` });
          month += 1;
          if (month > 12) {
            month = 1;
            year += 1;
          }
        }
        return state.sortDesc ? list.reverse() : list;
      }
    }
    const map = new Map();
    allEntries.forEach((entry) => {
      const day = calendarDayKey(entry.date);
      const match = String(day).match(/^(\d{4})-(\d{2})/);
      if (!match) return;
      const key = `${match[1]}-${match[2]}`;
      if (!map.has(key)) {
        map.set(key, {
          year: Number(match[1]),
          month: Number(match[2]),
          key,
        });
      }
    });
    return Array.from(map.values()).sort((a, b) =>
      state.sortDesc ? b.key.localeCompare(a.key) : a.key.localeCompare(b.key)
    );
  };

  const getCurrentRenderedMonthKey = () => {
    const anchorEntryId = getCurrentAnchorEntryId();
    const entry = anchorEntryId ? getLightboxEntry(anchorEntryId) : null;
    const dateText = entry ? calendarDayKey(entry.date) : "";
    const match = String(dateText).match(/^(\d{4}-\d{2})/);
    return match ? match[1] : "";
  };

  const getCurrentRenderedPlaceLabel = () => {
    const anchorEntryId = getCurrentAnchorEntryId();
    const entry = anchorEntryId ? getLightboxEntry(anchorEntryId) : null;
    if (!entry) return "";
    const gpsLabel =
      entry.gps && entry.gps.label != null ? String(entry.gps.label).trim() : "";
    const placeText = entry.place != null ? String(entry.place).trim() : "";
    return simplifyPlaceLabel(gpsLabel || placeText || "");
  };

  const getAvailablePlaceItems = () => {
    if (hasApi) {
      return availablePlaces.slice(0, 18);
    }
    const map = new Map();
    allEntries.forEach((entry) => {
      const gpsLabel =
        entry.gps && entry.gps.label != null ? String(entry.gps.label).trim() : "";
      const placeText = entry.place != null ? String(entry.place).trim() : "";
      const label = gpsLabel || placeText;
      if (!label || isNonGeographicPlaceNoise(label)) return;
      if (!map.has(label)) {
        map.set(label, {
          label: simplifyPlaceLabel(label) || label,
          queryLabel: label,
          count: 0,
          anchorDate: calendarDayKey(entry.date),
          anchorEntryId: entry.id || "",
        });
      }
      map.get(label).count += 1;
    });
    return Array.from(map.values())
      .sort((a, b) => b.count - a.count || String(b.anchorDate).localeCompare(String(a.anchorDate)))
      .slice(0, 18);
  };

  const groupAvailablePlaceItems = (items) => {
    const map = new Map();
    items.forEach((item) => {
      const parts = String(item.label || "")
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean);
      const parentLabel = parts.length > 1 ? parts[parts.length - 1] : String(item.label || "").trim();
      const childLabel = parts.length > 1 ? parts[0] : "";
      const key = parentLabel || String(item.label || "").trim();
      if (!key) return;
      if (!map.has(key)) {
        map.set(key, {
          label: key,
          count: 0,
          anchorDate: item.anchorDate,
          anchorEntryId: item.anchorEntryId,
          queryLabel: item.queryLabel || item.label,
          children: [],
        });
      }
      const group = map.get(key);
      group.count += Number(item.count) || 0;
      if (!group.anchorDate || String(item.anchorDate || "").localeCompare(String(group.anchorDate || "")) > 0) {
        group.anchorDate = item.anchorDate;
        group.anchorEntryId = item.anchorEntryId;
        group.queryLabel = item.queryLabel || item.label;
      }
      if (childLabel && childLabel !== key) {
        group.children.push({
          label: childLabel,
          queryLabel: item.queryLabel || item.label,
          count: item.count,
          anchorDate: item.anchorDate,
          anchorEntryId: item.anchorEntryId,
        });
      }
    });
    return Array.from(map.values())
      .map((group) => ({
        ...group,
        children: group.children
          .sort((a, b) => (b.count || 0) - (a.count || 0) || String(a.label).localeCompare(String(b.label)))
          .slice(0, 6),
      }))
      .sort((a, b) => (b.count || 0) - (a.count || 0) || String(a.label).localeCompare(String(b.label)))
      .slice(0, 8);
  };

  const getAvailablePlaceGroups = () => {
    if (hasApi && availablePlaceGroups.length) return availablePlaceGroups.slice(0, 8);
    return groupAvailablePlaceItems(getAvailablePlaceItems());
  };

  const getCurrentProgressInfo = () => {
    const data = getEntries();
    const anchorEntryId = getCurrentAnchorEntryId();
    const index = anchorEntryId ? data.findIndex((entry) => entry.id === anchorEntryId) : -1;
    const total = hasApi ? remoteTotal : data.length;
    const safeIndex = index >= 0 ? index : 0;
    const ratio = total > 0 ? Math.min(1, Math.max(0, (safeIndex + 1) / total)) : 0;
    return {
      index: safeIndex,
      total,
      ratio,
      percentText: total > 0 ? `${Math.round(ratio * 100)}%` : "0%",
    };
  };

  const syncTimeRailCurrent = () => {
    if (!timeRailPanel || !timeRailToggle) return;
    const monthKey = getCurrentRenderedMonthKey();
    const buttons = Array.from(timeRailPanel.querySelectorAll(".time-rail__month"));
    buttons.forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.monthKey === monthKey);
    });
    const progress = getCurrentProgressInfo();
    timeRailToggle.textContent = monthKey ? `${monthKey} · ${progress.percentText}` : "时间索引";
    const summaryValue = timeRailPanel.querySelector(".time-rail__summary-value");
    const summaryMeta = timeRailPanel.querySelector(".time-rail__summary-meta");
    const summaryPlace = timeRailPanel.querySelector(".time-rail__summary-place");
    const progressBar = timeRailPanel.querySelector(".time-rail__progress-bar");
    const currentPlace = getCurrentRenderedPlaceLabel();
    if (summaryValue) summaryValue.textContent = monthKey || "当前位置";
    if (summaryMeta) {
      summaryMeta.textContent =
        progress.total > 0
          ? `第 ${progress.index + 1} / ${progress.total} 条 · 已浏览约 ${progress.percentText}`
          : "暂无时间轴数据";
    }
    if (summaryPlace) summaryPlace.textContent = currentPlace ? `地点 · ${currentPlace}` : "";
    if (progressBar) progressBar.style.width = `${Math.round(progress.ratio * 100)}%`;
  };

  const setTimeRailOpen = (open) => {
    if (!timeRailPanel || !timeRailToggle) return;
    timeRailPanel.hidden = !open;
    timeRailToggle.setAttribute("aria-expanded", open ? "true" : "false");
  };

  const buildYearJump = () => {
    if (!yearJumpWrap) return;
    yearJumpWrap.innerHTML = "";
    const years = getAvailableYears();
    years.forEach((year) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "year-jump__btn";
      btn.textContent = `${year} 年`;
      btn.addEventListener("click", () => {
        if (jumpDateInput) jumpDateInput.value = buildYearAnchorDate(year);
        jumpToDate().catch((error) => {
          console.error(error);
          countText.textContent = "年份跳转失败";
        });
      });
      yearJumpWrap.appendChild(btn);
    });
  };

  const buildTimeRail = () => {
    if (!timeRailPanel || !timeRail) return;
    timeRailPanel.innerHTML = "";
    const months = getAvailableMonths();
    if (!months.length) {
      timeRail.style.display = "none";
      return;
    }
    timeRail.style.display = "";
    const summary = document.createElement("div");
    summary.className = "time-rail__summary";
    summary.innerHTML =
      '<div class="time-rail__summary-title">当前浏览</div><div class="time-rail__summary-value">当前位置</div><div class="time-rail__summary-meta"></div><div class="time-rail__summary-place"></div><div class="time-rail__progress"><div class="time-rail__progress-bar"></div></div>';
    timeRailPanel.appendChild(summary);
    const runPlaceJump = async (item) => {
      const queryLabel = item.queryLabel || item.label;
      state.query = queryLabel;
      state.pageIndex = 0;
      if (searchInput) searchInput.value = queryLabel;
      setTimeRailOpen(false);
      if (!hasApi) {
        render();
        persistViewStateSoon();
        return;
      }
      countText.textContent = "地点跳转中…";
      const data = await fetchApiEntries({
        offset: 0,
        limit: pageSize,
        anchorDate: item.anchorDate || "",
        append: false,
      });
      if (data == null) return;
      buildTags();
      render();
      requestAnimationFrame(() => {
        if (scrollToRenderedEntry(item.anchorEntryId || data.anchorEntryId || "")) return;
        persistViewStateSoon();
      });
    };
    const placeGroups = getAvailablePlaceGroups();
    if (placeGroups.length) {
      const placeSection = document.createElement("section");
      placeSection.className = "time-rail__places";
      const title = document.createElement("div");
      title.className = "time-rail__places-title";
      title.textContent = "地点速览";
      const list = document.createElement("div");
      list.className = "time-rail__place-list";
      placeGroups.forEach((group) => {
        const card = document.createElement("div");
        card.className = "time-rail__place-group";
        const head = document.createElement("div");
        head.className = "time-rail__place-group-head";
        const labelBtn = document.createElement("button");
        labelBtn.type = "button";
        labelBtn.className = "time-rail__place-group-label";
        labelBtn.textContent = group.label;
        labelBtn.title = `${group.queryLabel || group.label} · ${group.count} 条`;
        labelBtn.addEventListener("click", () => {
          runPlaceJump(group).catch((error) => {
            console.error(error);
            countText.textContent = "地点跳转失败";
          });
        });
        const meta = document.createElement("div");
        meta.className = "time-rail__place-group-meta";
        meta.textContent = `${group.count} 条`;
        head.appendChild(labelBtn);
        head.appendChild(meta);
        card.appendChild(head);
        if (Array.isArray(group.children) && group.children.length) {
          const children = document.createElement("div");
          children.className = "time-rail__place-children";
          group.children.forEach((child) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "time-rail__place";
            btn.title = `${child.queryLabel || child.label} · ${child.count} 条`;
            btn.textContent = `${child.label}${child.count > 1 ? ` (${child.count})` : ""}`;
            btn.addEventListener("click", () => {
              runPlaceJump(child).catch((error) => {
                console.error(error);
                countText.textContent = "地点跳转失败";
              });
            });
            children.appendChild(btn);
          });
          card.appendChild(children);
        }
        list.appendChild(card);
      });
      placeSection.appendChild(title);
      placeSection.appendChild(list);
      timeRailPanel.appendChild(placeSection);
    }
    const groups = new Map();
    months.forEach((item) => {
      if (!groups.has(item.year)) groups.set(item.year, []);
      groups.get(item.year).push(item);
    });
    Array.from(groups.entries()).forEach(([year, items]) => {
      const group = document.createElement("section");
      group.className = "time-rail__year-group";
      const label = document.createElement("div");
      label.className = "time-rail__year-label";
      label.textContent = `${year} 年`;
      const wrap = document.createElement("div");
      wrap.className = "time-rail__months";
      items.forEach((item) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "time-rail__month";
        btn.dataset.monthKey = item.key;
        btn.textContent = `${String(item.month).padStart(2, "0")} 月`;
        btn.addEventListener("click", () => {
          if (jumpDateInput) jumpDateInput.value = buildMonthAnchorDate(item.year, item.month);
          setTimeRailOpen(false);
          jumpToDate().catch((error) => {
            console.error(error);
            countText.textContent = "月份跳转失败";
          });
        });
        wrap.appendChild(btn);
      });
      group.appendChild(label);
      group.appendChild(wrap);
      timeRailPanel.appendChild(group);
    });
    syncTimeRailCurrent();
  };

  const scrollToRenderedEntry = (entryId) => {
    if (!entryId) return false;
    const card = findRenderedCardByEntryId(entryId);
    if (!card) return false;
    card.scrollIntoView({ block: "start", inline: "nearest" });
    persistViewStateSoon();
    return true;
  };

  const fetchNextChunk = async () => {
    if (!nextChunkUrl || chunkLoading) return false;
    chunkLoading = true;
    try {
      if (hasApi) {
        const data = await fetchJson(nextChunkUrl);
        applyApiPayload(data, { append: true });
      } else {
        const chunk = await fetchJson(nextChunkUrl);
        mergeChunk(chunk);
      }
      buildTags();
      syncTagChipSelection();
      return true;
    } finally {
      chunkLoading = false;
    }
  };

  const ensureEntryLoaded = async (entryId) => {
    if (!entryId) return;
    while (!allEntries.some((entry) => entry.id === entryId) && nextChunkUrl) {
      const loaded = await fetchNextChunk();
      if (!loaded) break;
    }
  };

  const ensurePageLoaded = async (targetPageIndex) => {
    while ((targetPageIndex + 1) * pageSize > allEntries.length && nextChunkUrl) {
      const loaded = await fetchNextChunk();
      if (!loaded) break;
    }
  };

  const restoreViewPosition = async (saved) => {
    const hashEntryId = parseHashEntryId();
    const targetEntryId = hashEntryId || (saved && saved.anchorEntryId) || "";
    if (targetEntryId) {
      await ensureEntryLoaded(targetEntryId);
      const data = getEntries();
      const targetIndex = data.findIndex((entry) => entry.id === targetEntryId);
      if (targetIndex >= 0) {
        state.pageIndex = Math.max(state.pageIndex, Math.floor(targetIndex / pageSize));
      }
    }
    await ensurePageLoaded(state.pageIndex);
    render();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (targetEntryId) {
          const card = findRenderedCardByEntryId(targetEntryId);
          if (card) {
            card.scrollIntoView({ block: "start", inline: "nearest" });
            persistViewStateSoon();
            return;
          }
        }
        if (saved && typeof saved.scrollY === "number" && saved.scrollY > 0) {
          window.scrollTo({ top: saved.scrollY, left: 0, behavior: "auto" });
        }
        persistViewStateSoon();
      });
    });
  };

  const buildTags = () => {
    tagWrap.innerHTML = "";
    const tagSet = new Set();
    const source = hasApi ? availableTags : allEntries.flatMap((entry) => entry.tags || []);
    source.forEach((tag) => tagSet.add(tag));
    tagSet.forEach((tag) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = tag;
      chip.addEventListener("click", async () => {
        if (state.tags.has(tag)) {
          state.tags.delete(tag);
          chip.classList.remove("active");
        } else {
          state.tags.add(tag);
          chip.classList.add("active");
        }
        state.pageIndex = 0;
        if (hasApi) {
          countText.textContent = "加载中…";
          const data = await fetchApiEntries({ offset: 0, limit: pageSize, append: false }).catch(
            (error) => {
              console.error(error);
              countText.textContent = "时间轴接口加载失败";
              return null;
            }
          );
          if (data == null) return;
          buildTags();
        }
        render();
        syncJumpDateControl();
        buildYearJump();
        buildTimeRail();
        persistViewStateSoon();
      });
      tagWrap.appendChild(chip);
    });
  };

  const LIVE_MUTE_ICON_SVG = `<svg class="photo-item__mute-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`;

  const appendPhotoCell = (grid, photo, entry, photoIndex, mergedSlots) => {
    const item = document.createElement("figure");
    item.className = `photo-item ${photo.ratio || "wide"}`;
    const isLive = !!photo.video;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", photo.caption || "打开图片");
    btn.addEventListener("click", () =>
      mergedSlots
        ? openLightbox(entry.id, photoIndex, mergedSlots)
        : openLightbox(entry.id, photoIndex)
    );

    const img = document.createElement("img");
    img.loading = "lazy";
    img.dataset.src = listImageSrc(photo);
    img.alt = photo.caption || entry.title;

    const cap = document.createElement("figcaption");
    appendHighlightedText(cap, photo.caption || "");
    btn.appendChild(img);

    if (isLive) {
      const vid = document.createElement("video");
      vid.loop = false;
      vid.muted = true;
      vid.defaultMuted = true;
      vid.playsInline = true;
      vid.setAttribute("playsinline", "");
      vid.setAttribute("webkit-playsinline", "");
      /* 默认先不占用视频缓冲，悬停预览时再挂载 src 并播放 */
      vid.preload = "none";
      vid.poster = listImageSrc(photo);
      vid.dataset.videoSrc = photo.video;
      btn.appendChild(vid);
      vid.addEventListener("ended", () => {
        vid.pause();
        item.classList.remove("live-playing");
      });

      const badge = document.createElement("span");
      badge.className = "live-badge";
      badge.textContent = "LIVE";
      item.appendChild(badge);

      const muteHint = document.createElement("span");
      muteHint.className = "photo-item__mute";
      muteHint.title = "悬停播放一次（静音），移开恢复静图";
      muteHint.setAttribute("aria-hidden", "true");
      muteHint.innerHTML = LIVE_MUTE_ICON_SVG;
      item.appendChild(muteHint);

      let previewGen = 0;
      let onPlayingMark = null;
      let waitRetry = null;

      const clearPreviewListeners = () => {
        if (onPlayingMark) {
          vid.removeEventListener("playing", onPlayingMark);
          onPlayingMark = null;
        }
        if (waitRetry) {
          vid.removeEventListener("canplay", waitRetry);
          vid.removeEventListener("loadeddata", waitRetry);
          waitRetry = null;
        }
      };

      const runPreviewPlay = () => {
        clearPreviewListeners();
        const gen = previewGen;
        ensureCardVideoSource(vid);
        vid.preload = "auto";
        vid.muted = true;
        vid.defaultMuted = true;
        vid.playsInline = true;
        try {
          vid.currentTime = 0;
        } catch (e) {
          /* ignore */
        }

        onPlayingMark = () => {
          if (gen !== previewGen) return;
          item.classList.add("live-playing");
        };
        vid.addEventListener("playing", onPlayingMark);

        const attemptPlay = () => {
          const p = vid.play();
          if (p === undefined) return;
          p
            .then(() => {
              if (gen !== previewGen) return;
              item.classList.add("live-playing");
            })
            .catch(() => {
              if (gen !== previewGen) return;
              if (onPlayingMark) {
                vid.removeEventListener("playing", onPlayingMark);
                onPlayingMark = null;
              }
              const retryWhenReady = () => {
                if (gen !== previewGen) return;
                onPlayingMark = () => {
                  if (gen !== previewGen) return;
                  item.classList.add("live-playing");
                };
                vid.addEventListener("playing", onPlayingMark);
                vid.play().catch(() => {
                  if (gen === previewGen) item.classList.remove("live-playing");
                });
              };
              /* 已有缓冲时立刻再试；否则等 canplay/loadeddata（避免只等 canplay 但事件早已发过） */
              if (vid.readyState >= 2) {
                queueMicrotask(retryWhenReady);
              } else {
                let fired = false;
                waitRetry = () => {
                  if (fired || gen !== previewGen) return;
                  fired = true;
                  vid.removeEventListener("canplay", waitRetry);
                  vid.removeEventListener("loadeddata", waitRetry);
                  waitRetry = null;
                  retryWhenReady();
                };
                vid.addEventListener("canplay", waitRetry);
                vid.addEventListener("loadeddata", waitRetry);
              }
            });
        };
        attemptPlay();
      };

      let hoverTimer = null;
      let touchTimer = null;

      const stopPlay = () => {
        clearTimeout(hoverTimer);
        clearTimeout(touchTimer);
        previewGen++;
        clearPreviewListeners();
        vid.pause();
        try {
          vid.currentTime = 0;
        } catch (e) {
          /* ignore */
        }
        item.classList.remove("live-playing");
      };

      const startPlay = () => {
        hoverTimer = setTimeout(() => runPreviewPlay(), 300);
      };

      btn.addEventListener("mouseenter", startPlay);
      btn.addEventListener("mouseleave", stopPlay);

      btn.addEventListener(
        "touchstart",
        (e) => {
          touchTimer = setTimeout(() => {
            e.preventDefault();
            clearTimeout(hoverTimer);
            previewGen++;
            clearPreviewListeners();
            runPreviewPlay();
          }, 400);
        },
        { passive: false }
      );
      btn.addEventListener("touchend", () => {
        clearTimeout(touchTimer);
        stopPlay();
      });
    }

    btn.appendChild(cap);
    item.appendChild(btn);
    grid.appendChild(item);
  };

  const renderPhotos = (entry) => {
    const expanded = state.expanded.has(entry.id);
    const max = expanded ? entry.photos.length : Math.min(3, entry.photos.length);
    const visiblePhotos = entry.photos.slice(0, max);
    const fragment = document.createDocumentFragment();
    const grid = document.createElement("div");
    grid.className = "photo-grid";

    visiblePhotos.forEach((photo, idx) => {
      appendPhotoCell(grid, photo, entry, idx, null);
    });

    if (entry.photos.length > 3) {
      const toggleWrap = document.createElement("div");
      toggleWrap.className = "toggle-photos";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.textContent = expanded ? "收起" : `展开全部 ${entry.photos.length} 张`;
      toggle.addEventListener("click", () => {
        state.expanded.has(entry.id) ? state.expanded.delete(entry.id) : state.expanded.add(entry.id);
        render();
      });
      toggleWrap.appendChild(toggle);
      grid.appendChild(toggleWrap);
    }

    fragment.prepend(grid);
    return fragment;
  };

  /** 同日、同地理桶多条合并：一个网格内展示全部照片，灯箱内可按序切换 */
  const renderPhotosMerged = (entries, mergedKey) => {
    const slots = [];
    entries.forEach((entry) => {
      (entry.photos || []).forEach((photo, photoIndex) => {
        slots.push({ entryId: entry.id, photoIndex });
      });
    });
    const total = slots.length;
    const expanded = state.expanded.has(mergedKey);
    const max = expanded ? total : Math.min(3, total);
    const fragment = document.createDocumentFragment();
    const grid = document.createElement("div");
    grid.className = "photo-grid";

    for (let i = 0; i < max; i++) {
      const s = slots[i];
      const entry = getLightboxEntry(s.entryId);
      if (!entry) continue;
      const photo = entry.photos[s.photoIndex];
      if (!photo) continue;
      appendPhotoCell(grid, photo, entry, s.photoIndex, slots);
    }

    if (total > 3) {
      const toggleWrap = document.createElement("div");
      toggleWrap.className = "toggle-photos";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.textContent = expanded ? "收起" : `展开全部 ${total} 张`;
      toggle.addEventListener("click", () => {
        state.expanded.has(mergedKey)
          ? state.expanded.delete(mergedKey)
          : state.expanded.add(mergedKey);
        render();
      });
      toggleWrap.appendChild(toggle);
      grid.appendChild(toggleWrap);
    }

    fragment.prepend(grid);
    return fragment;
  };

  /** 地点文案里的相对时间/占位词，不宜作为合并卡片主标题（易与「条目标题」混淆） */
  const isNonGeographicPlaceNoise = (s) => {
    if (!s || typeof s !== "string") return true;
    const t = s.trim();
    if (!t) return true;
    if (/^(刚刚|刚才|昨天|今天|前天|近期|此刻|现在|刚刚发布)$/.test(t)) return true;
    if (/^\d+[分秒小时天周月年]前$/.test(t)) return true;
    return false;
  };

  const simplifyPlaceLabel = (value) => {
    const raw = String(value || "").trim();
    if (!raw || isNonGeographicPlaceNoise(raw)) return "";
    const trimmed = raw
      .replace(/^中国/, "")
      .replace(/^浙江省/, "")
      .replace(/^杭州市/, "")
      .replace(/^浙江省杭州市/, "")
      .replace(/^(西湖区|余杭区|拱墅区|上城区|滨江区|萧山区|临平区|钱塘区)/, "")
      .trim();
    const source = trimmed || raw;
    const scenic =
      source.match(/([^省市区县]{1,24}(?:风景名胜区|景区|公园|山庄|寺|园|湖|山|馆|大学|学校))/g) || [];
    const streets =
      source.match(/([^省市区县]{1,12}(?:街道|镇|乡|村))/g) || [];
    const normalizedScenic = scenic.map((item) =>
      item.replace(/^[^省市区县]{1,12}(?:街道|镇|乡|村)/, "").trim()
    );
    const picked = [...new Set([...normalizedScenic, ...streets])]
      .filter(Boolean)
      .sort((a, b) => a.length - b.length)
      .slice(-2)
      .join(" / ");
    const shortLabel = (picked || source || raw).replace(/[，,]+/g, " · ").trim();
    return shortLabel.length > 28 ? shortLabel.slice(0, 28) : shortLabel;
  };

  const createMergedLocationCard = (entries, rep, animIndex) => {
    const mergedKey = entries.map((e) => e.id).join("¦");
    const card = document.createElement("div");
    card.className = "day-card day-card--merged";
    if (hasActiveQuery()) card.classList.add("day-card--search-hit");
    card.style.transitionDelay = `${animIndex * 0.08}s`;
    card.dataset.anchorEntryId = rep.id || entries[0].id || "";
    card.dataset.entryIds = entries.map((e) => e.id).filter(Boolean).join(",");

    const header = document.createElement("div");
    header.className = "card-header";

    const left = document.createElement("div");
    const title = document.createElement("h2");
    title.className = "card-title";
    const placeStr = (rep.place && String(rep.place).trim()) || "";
    const titleFromEntry =
      (rep.title && String(rep.title).trim()) ||
      (entries[0] && String(entries[0].title || "").trim()) ||
      "";
    const placeOk = placeStr && !isNonGeographicPlaceNoise(placeStr);
    const noteFallback = entries
      .map((e) => e.note)
      .find((n) => n && String(n).trim());
    const noteHead = noteFallback ? String(noteFallback).trim().slice(0, 120) : "";
    const placeIsNoise = isNonGeographicPlaceNoise(placeStr);
    /** 导入默认标题如「2026-02-14 143741」，可读性不如首段备注 */
    const titleLooksLikeImportSlug =
      titleFromEntry &&
      /^\d{4}-\d{1,2}-\d{1,2}/.test(titleFromEntry) &&
      titleFromEntry.length < 72;
    appendHighlightedText(
      title,
      placeIsNoise && noteHead && titleLooksLikeImportSlug
        ? noteHead
        : titleFromEntry ||
            (placeOk ? placeStr : "") ||
            (placeIsNoise && noteHead ? noteHead : "") ||
            placeStr ||
            ""
    );
    left.appendChild(title);

    const right = document.createElement("div");
    right.className = "tag-list";
    const tagSet = new Set();
    entries.forEach((e) => (e.tags || []).forEach((t) => tagSet.add(t)));
    tagSet.forEach((tag) => {
      const span = document.createElement("span");
      span.className = "day-card__tag";
      span.textContent = tag;
      right.appendChild(span);
    });

    const note = document.createElement("p");
    note.className = "card-note";
    const notes = entries.map((e) => e.note).filter((n) => n && String(n).trim());
    appendHighlightedText(note, notes.join("\n\n"));

    const photoWrap = document.createElement("div");
    photoWrap.appendChild(renderPhotosMerged(entries, mergedKey));

    header.appendChild(left);
    header.appendChild(right);
    card.appendChild(header);
    card.appendChild(note);
    card.appendChild(photoWrap);
    /* 合并卡片只给一个管理入口（rep），避免多条 entry 时出现多个齿轮；其余条目在后台列表里选 */
    appendAdminCornerLinks(card, rep.id);
    return card;
  };

  const createDayCard = (entry, animIndex) => {
    const card = document.createElement("div");
    card.className = "day-card";
    if (hasActiveQuery()) card.classList.add("day-card--search-hit");
    card.style.transitionDelay = `${animIndex * 0.08}s`;
    card.dataset.anchorEntryId = entry.id || "";
    card.dataset.entryIds = entry.id || "";

    const header = document.createElement("div");
    header.className = "card-header";

    const left = document.createElement("div");
    const title = document.createElement("h2");
    title.className = "card-title";
    appendHighlightedText(title, entry.title);
    const place = document.createElement("p");
    place.className = "card-place";
    appendHighlightedText(place, entry.place);
    left.appendChild(title);
    left.appendChild(place);
    const gpsRow = buildGpsRow(entry, {
      resolveAlsoIds: getLocationClusterPeers(entry)
        .filter((e) => e.id !== entry.id)
        .map((e) => e.id),
    });
    if (gpsRow) left.appendChild(gpsRow);
    const weatherRow = buildWeatherRow(entry);
    if (weatherRow) left.appendChild(weatherRow);

    const right = document.createElement("div");
    right.className = "tag-list";
    (entry.tags || []).forEach((tag) => {
      const span = document.createElement("span");
      span.className = "day-card__tag";
      span.textContent = tag;
      right.appendChild(span);
    });

    const note = document.createElement("p");
    note.className = "card-note";
    appendHighlightedText(note, entry.note || "");

    const photoWrap = document.createElement("div");
    photoWrap.appendChild(renderPhotos(entry));

    header.appendChild(left);
    header.appendChild(right);
    card.appendChild(header);
    card.appendChild(note);
    card.appendChild(photoWrap);
    appendAdminCornerLinks(card, entry.id);
    return card;
  };

  const observeCards = () => {
    if (cardObserver) cardObserver.disconnect();
    cardObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("show");
            cardObserver.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -60px 0px" }
    );
    timeline.querySelectorAll(".day-card").forEach((el) => cardObserver.observe(el));
  };

  const observeImages = () => {
    if (imageObserver) imageObserver.disconnect();
    imageObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const img = entry.target;
          const src = img.getAttribute("data-src");
          if (src) {
            img.src = src;
            img.removeAttribute("data-src");
          }
          imageObserver.unobserve(img);
        });
      },
      { rootMargin: "300px 0px" }
    );
    timeline.querySelectorAll("img[data-src]").forEach((img) => imageObserver.observe(img));
  };

  const observeFarMediaRelease = () => {
    if (mediaUnloadObserver) mediaUnloadObserver.disconnect();
    mediaUnloadObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) return;
          const el = entry.target;
          if (el.tagName === "IMG") {
            const img = el;
            if (!img.getAttribute("src")) return;
            img.dataset.src = img.getAttribute("src");
            img.removeAttribute("src");
            if (imageObserver) imageObserver.observe(img);
            return;
          }
          if (el.tagName === "VIDEO") {
            const video = el;
            if (video.matches(":hover")) return;
            unloadCardVideoSource(video);
          }
        });
      },
      { rootMargin: "2500px 0px" }
    );
    timeline
      .querySelectorAll("img, .photo-grid video[data-video-src]")
      .forEach((el) => mediaUnloadObserver.observe(el));
  };

  const openLightbox = (entryId, photoIndex, mergedSlots = null) => {
    const entry = getLightboxEntry(entryId);
    if (!entry) return;
    state.lightbox.entryId = entryId;
    state.lightbox.index = photoIndex;
    if (mergedSlots && mergedSlots.length > 1) {
      const cursor = mergedSlots.findIndex(
        (s) => s.entryId === entryId && s.photoIndex === photoIndex
      );
      state.lightbox.merged = {
        slots: mergedSlots,
        cursor: cursor >= 0 ? cursor : 0
      };
    } else {
      state.lightbox.merged = null;
    }
    updateLightbox();
    lightbox.classList.add("open");
    document.body.classList.add("gallery-open");
  };

  const getLightboxSlot = () => {
    const m = state.lightbox.merged;
    if (m && m.slots && m.slots.length) {
      const s = m.slots[m.cursor];
      const entry = getLightboxEntry(s.entryId);
      if (!entry) return null;
      return { entry, photoIndex: s.photoIndex };
    }
    const entry = getLightboxEntry(state.lightbox.entryId);
    if (!entry) return null;
    return { entry, photoIndex: state.lightbox.index };
  };

  const LB_SVG_VOL_OFF = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`;
  const LB_SVG_VOL_ON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.49-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;

  const syncLightboxMuteButton = () => {
    if (!lightboxMuteBtn || !lightboxMuteIcon) return;
    const m = state.lightbox.videoMuted;
    lightboxMuteIcon.innerHTML = m ? LB_SVG_VOL_OFF : LB_SVG_VOL_ON;
    lightboxMuteBtn.setAttribute("aria-label", m ? "取消静音" : "静音");
    lightboxMuteBtn.title = m ? "当前为静音，点击取消静音" : "当前有声，点击静音";
    lightboxMuteBtn.classList.toggle("is-muted", m);
  };

  if (lightboxMuteBtn && !lightboxMuteBtn.dataset.wired) {
    lightboxMuteBtn.dataset.wired = "1";
    lightboxMuteBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      state.lightbox.videoMuted = !state.lightbox.videoMuted;
      if (lightboxVideo) lightboxVideo.muted = state.lightbox.videoMuted;
      syncLightboxMuteButton();
    });
  }

  const updateLightbox = () => {
    const slot = getLightboxSlot();
    if (!slot) return;
    const { entry } = slot;
    let index = Math.min(Math.max(0, slot.photoIndex), entry.photos.length - 1);
    state.lightbox.entryId = entry.id;
    state.lightbox.index = index;
    const photo = entry.photos[index];
    const isLive = !!photo.video;

    if (typeof state.lightbox.liveCleanup === "function") {
      state.lightbox.liveCleanup();
      state.lightbox.liveCleanup = null;
    }

    lightboxVideo.pause();

    if (isLive) {
      /*
       * Live 灯箱：1）打开后先自动播完一段视频；2）结束后只显示静图（JPG）；
       * 3）仅在静图状态下，鼠标悬停再播一次，移出则暂停并回到静图；4）再次移入可再播。
       */
      lightboxVideo.loop = false;
      lightboxVideo.playsInline = true;
      lightboxVideo.setAttribute("playsinline", "");
      lightboxVideo.setAttribute("webkit-playsinline", "");
      lightboxVideo.preload = "auto";
      lightboxVideo.muted = state.lightbox.videoMuted;
      lightboxVideo.defaultMuted = state.lightbox.videoMuted;
      lightboxVideo.src = photo.video;
      lightboxVideo.poster = photo.src;

      let liveAtPoster = false;
      let liveEndedHandler = null;
      let liveHoverEnter = null;
      let liveHoverLeave = null;

      const clearLiveEndedListener = () => {
        if (liveEndedHandler) {
          lightboxVideo.removeEventListener("ended", liveEndedHandler);
          liveEndedHandler = null;
        }
      };

      const unbindLiveHover = () => {
        if (lightboxPhoto && liveHoverEnter) {
          lightboxPhoto.removeEventListener("mouseenter", liveHoverEnter);
          lightboxPhoto.removeEventListener("mouseleave", liveHoverLeave);
          liveHoverEnter = null;
          liveHoverLeave = null;
        }
      };

      const teardownLiveUi = () => {
        clearLiveEndedListener();
        unbindLiveHover();
      };

      state.lightbox.liveCleanup = teardownLiveUi;

      const showLivePoster = () => {
        liveAtPoster = true;
        lightboxImage.src = photo.src;
        lightboxImage.alt = photo.caption || entry.title;
        lightboxImage.style.display = "";
        lightboxVideo.style.display = "none";
        lightboxVideo.pause();
        try {
          lightboxVideo.currentTime = 0;
        } catch (e) {
          /* ignore */
        }
        if (lightboxMuteBtn) {
          lightboxMuteBtn.style.display = "flex";
          syncLightboxMuteButton();
        }
      };

      const startLivePlayback = (afterEnded) => {
        clearLiveEndedListener();
        liveAtPoster = false;
        lightboxVideo.muted = state.lightbox.videoMuted;
        lightboxImage.style.display = "none";
        lightboxVideo.style.display = "";
        lightboxVideo.loop = false;
        try {
          lightboxVideo.currentTime = 0;
        } catch (e) {
          /* ignore */
        }

        const finish = () => {
          showLivePoster();
          if (typeof afterEnded === "function") afterEnded();
        };

        liveEndedHandler = () => {
          clearLiveEndedListener();
          finish();
        };
        lightboxVideo.addEventListener("ended", liveEndedHandler);

        /* play() 在缓冲不够时常失败；勿立即 finish，先等 canplay/loadeddata 再试 */
        let playRetryScheduled = false;
        const attemptPlay = () => {
          lightboxVideo.play().catch(() => {
            if (playRetryScheduled) {
              clearLiveEndedListener();
              finish();
              return;
            }
            playRetryScheduled = true;
            const onBuffer = () => {
              lightboxVideo.removeEventListener("canplay", onBuffer);
              lightboxVideo.removeEventListener("loadeddata", onBuffer);
              attemptPlay();
            };
            lightboxVideo.addEventListener("canplay", onBuffer);
            lightboxVideo.addEventListener("loadeddata", onBuffer);
          });
        };
        if (lightboxVideo.readyState >= 3) {
          attemptPlay();
        } else {
          let initialReady = false;
          const onReady = () => {
            if (initialReady) return;
            initialReady = true;
            lightboxVideo.removeEventListener("canplay", onReady);
            lightboxVideo.removeEventListener("loadeddata", onReady);
            attemptPlay();
          };
          lightboxVideo.addEventListener("canplay", onReady);
          lightboxVideo.addEventListener("loadeddata", onReady);
        }
      };

      const bindLiveHover = () => {
        if (!lightboxPhoto) return;
        unbindLiveHover();
        liveHoverEnter = () => {
          if (!liveAtPoster) return;
          startLivePlayback(() => {});
        };
        liveHoverLeave = () => {
          clearLiveEndedListener();
          lightboxVideo.pause();
          showLivePoster();
        };
        lightboxPhoto.addEventListener("mouseenter", liveHoverEnter);
        lightboxPhoto.addEventListener("mouseleave", liveHoverLeave);
      };

      if (lightboxPhoto) lightboxPhoto.classList.add("lightbox-photo--live");

      startLivePlayback(() => {
        bindLiveHover();
      });

      if (lightboxMuteBtn) {
        lightboxMuteBtn.style.display = "flex";
        syncLightboxMuteButton();
      }

      const captionText = photo.caption || "";
      lightboxCaption.innerHTML = `${escapeHtml(captionText)}<span class="lightbox-live-hint"> · Live Photo · 首次自动播放，之后为静图，悬停再播一次</span>`;
    } else {
      if (lightboxPhoto) lightboxPhoto.classList.remove("lightbox-photo--live");
      if (lightboxMuteBtn) lightboxMuteBtn.style.display = "none";
      lightboxVideo.style.display = "none";
      lightboxVideo.src = "";
      lightboxVideo.poster = "";
      lightboxImage.style.display = "";
      lightboxImage.src = photo.src;
      lightboxImage.alt = photo.caption || entry.title;
      const captionText = photo.caption || "";
      lightboxCaption.innerHTML = captionText;
    }

    const metaLines = [`${entry.place} · ${entry.title}`];
    if (hasWeatherData(entry)) {
      const w = entry.weather;
      const parts = [];
      if (w.summary) parts.push(w.summary);
      if (w.temp_low_c != null || w.temp_high_c != null) {
        const lo = w.temp_low_c != null ? `${w.temp_low_c}°` : "—";
        const hi = w.temp_high_c != null ? `${w.temp_high_c}°` : "—";
        parts.push(`${lo}～${hi}`);
      }
      if (parts.length) metaLines.push(`天气 ${parts.join(" · ")}`);
    } else if (getGpsCoords(entry.gps)) {
      metaLines.push("天气待同步");
    }
    const c = getGpsCoords(entry.gps);
    if (c) metaLines.push(`${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`);
    lightboxMeta.innerHTML = metaLines.map((line) => escapeHtml(line)).join("<br/>");

    const merged = state.lightbox.merged;
    const canNav = merged
      ? merged.slots && merged.slots.length > 1
      : entry.photos.length > 1;
    prevBtn.style.visibility = canNav ? "" : "hidden";
    nextBtn.style.visibility = canNav ? "" : "hidden";
  };

  const closeLightbox = () => {
    if (typeof state.lightbox.liveCleanup === "function") {
      state.lightbox.liveCleanup();
      state.lightbox.liveCleanup = null;
    }
    if (lightboxPhoto) lightboxPhoto.classList.remove("lightbox-photo--live");
    lightbox.classList.remove("open");
    document.body.classList.remove("gallery-open");
    lightboxImage.src = "";
    lightboxVideo.pause();
    lightboxVideo.src = "";
    lightboxVideo.style.display = "none";
    if (lightboxMuteBtn) lightboxMuteBtn.style.display = "none";
    lightboxImage.style.display = "";
    state.lightbox.entryId = null;
    state.lightbox.index = 0;
    state.lightbox.merged = null;
  };

  const nextPhoto = () => {
    const m = state.lightbox.merged;
    if (m && m.slots && m.slots.length > 1) {
      m.cursor = (m.cursor + 1) % m.slots.length;
      const s = m.slots[m.cursor];
      state.lightbox.entryId = s.entryId;
      state.lightbox.index = s.photoIndex;
      updateLightbox();
      return;
    }
    if (!state.lightbox.entryId) return;
    const entry = getLightboxEntry(state.lightbox.entryId);
    if (!entry || entry.photos.length < 2) return;
    state.lightbox.index = (state.lightbox.index + 1) % entry.photos.length;
    updateLightbox();
  };

  const prevPhoto = () => {
    const m = state.lightbox.merged;
    if (m && m.slots && m.slots.length > 1) {
      m.cursor = (m.cursor - 1 + m.slots.length) % m.slots.length;
      const s = m.slots[m.cursor];
      state.lightbox.entryId = s.entryId;
      state.lightbox.index = s.photoIndex;
      updateLightbox();
      return;
    }
    if (!state.lightbox.entryId) return;
    const entry = getLightboxEntry(state.lightbox.entryId);
    if (!entry || entry.photos.length < 2) return;
    state.lightbox.index = (state.lightbox.index - 1 + entry.photos.length) % entry.photos.length;
    updateLightbox();
  };

  const refreshApiListing = async (limitOverride) => {
    if (!hasApi) return;
    countText.textContent = "加载中…";
    const data = await fetchApiEntries({
      offset: 0,
      limit: limitOverride || pageSize,
      append: false,
    });
    if (data == null) return;
    buildTags();
    render();
    syncJumpDateControl();
    buildYearJump();
    buildTimeRail();
    persistViewStateSoon();
  };

  const jumpToDate = async () => {
    if (!hasApi || !jumpDateInput) return;
    const value = String(jumpDateInput.value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    countText.textContent = "跳转中…";
    const data = await fetchApiEntries({
      offset: 0,
      limit: pageSize,
      anchorDate: value,
      append: false,
    });
    if (data == null) return;
    buildTags();
    render();
    syncJumpDateControl();
    buildYearJump();
    buildTimeRail();
    requestAnimationFrame(() => {
      const anchorEntryId =
        typeof data.anchorEntryId === "string" && data.anchorEntryId ? data.anchorEntryId : "";
      if (scrollToRenderedEntry(anchorEntryId)) return;
      window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
      persistViewStateSoon();
    });
  };

  const getRenderedDayItem = (dayKey) => {
    if (!dayKey) return null;
    return timeline.querySelector(`.day-item[data-day-key="${CSS.escape(String(dayKey))}"]`);
  };

  const appendDayGroupToTimeline = (group, options) => {
    const { animIndexRef } = options;
    const item = document.createElement("article");
    item.className = "day-item";
    item.dataset.dayKey = group.dayKey;

    const date = document.createElement("div");
    date.className = "day-date";
    const first = group.entries[0];
    const raw = group.dayKey.startsWith("__") && first ? first.date : group.dayKey;
    const ymdMatch = String(raw || "").match(/^(\d{4}-\d{2}-\d{2})/);
    const ymd = ymdMatch ? ymdMatch[1] : null;
    if (ymd) {
      date.innerHTML = `<strong>${toDateText(ymd)}</strong><span class="weekday">周${toWeekText(ymd)}</span>`;
    } else {
      date.innerHTML = `<strong>${escapeHtml(String(raw || "—"))}</strong><span class="weekday">周—</span>`;
    }

    const cardsWrap = document.createElement("div");
    cardsWrap.className = "day-cards";
    const locGroups = groupEntriesByLocation(group.entries);
    locGroups.forEach((loc) => {
      const list = loc.entries;
      if (list.length === 1) {
        cardsWrap.appendChild(createDayCard(list[0], animIndexRef.value));
        animIndexRef.value += 1;
        return;
      }
      const block = document.createElement("div");
      block.className = "day-location-block";
      const rep = list.find((e) => getGpsCoords(e.gps)) || list[0];
      const meta = document.createElement("div");
      meta.className = "location-block__meta";
      const sharedGps = buildGpsRow(rep, {
        resolveAlsoIds: list.filter((e) => e.id !== rep.id).map((e) => e.id),
      });
      if (sharedGps) meta.appendChild(sharedGps);
      const sharedWeather = buildWeatherRow(rep);
      if (sharedWeather) meta.appendChild(sharedWeather);
      if (meta.childNodes.length) block.appendChild(meta);
      block.appendChild(createMergedLocationCard(list, rep, animIndexRef.value));
      animIndexRef.value += 1;
      cardsWrap.appendChild(block);
    });

    item.appendChild(date);
    item.appendChild(cardsWrap);
    timeline.appendChild(item);
  };

  const mergeDayGroupIntoExisting = (existingItem, group, options) => {
    const { animIndexRef } = options;
    const cardsWrap = existingItem.querySelector(".day-cards");
    if (!cardsWrap) return;
    const locGroups = groupEntriesByLocation(group.entries);
    locGroups.forEach((loc) => {
      const list = loc.entries;
      if (list.length === 1) {
        cardsWrap.appendChild(createDayCard(list[0], animIndexRef.value));
        animIndexRef.value += 1;
        return;
      }
      const block = document.createElement("div");
      block.className = "day-location-block";
      const rep = list.find((e) => getGpsCoords(e.gps)) || list[0];
      const meta = document.createElement("div");
      meta.className = "location-block__meta";
      const sharedGps = buildGpsRow(rep, {
        resolveAlsoIds: list.filter((e) => e.id !== rep.id).map((e) => e.id),
      });
      if (sharedGps) meta.appendChild(sharedGps);
      const sharedWeather = buildWeatherRow(rep);
      if (sharedWeather) meta.appendChild(sharedWeather);
      if (meta.childNodes.length) block.appendChild(meta);
      block.appendChild(createMergedLocationCard(list, rep, animIndexRef.value));
      animIndexRef.value += 1;
      cardsWrap.appendChild(block);
    });
  };

  const render = (options = {}) => {
    const appendMode = !!options.append;
    const data = getEntries();
    const visible = hasApi ? data : data.slice(0, (state.pageIndex + 1) * pageSize);
    const prevVisibleCount = Math.max(0, Math.floor(Number(timeline.dataset.visibleCount) || 0));
    const shouldAppend = appendMode && prevVisibleCount > 0 && visible.length >= prevVisibleCount;
    if (!shouldAppend) {
      timeline.innerHTML = "";
      delete timeline.dataset.visibleCount;
    }
    emptyState.style.display = visible.length === 0 ? "block" : "none";
    const totalLabel = hasApi ? remoteTotal : data.length;
    const shownLabel = visible.length;
    const dayGroups = groupEntriesByCalendarDay(visible);
    const shownDays = dayGroups.length;
    countText.textContent = `${totalLabel} 条 · 已展示 ${shownLabel} 条 · ${shownDays} 个日期`;
    const hasMoreInMemory = hasApi ? false : visible.length < data.length;
    const hasMoreRemote = !!nextChunkUrl;
    loadMore.style.display = hasMoreInMemory || hasMoreRemote ? "" : "none";

    const animIndexRef = { value: 0 };
    if (!shouldAppend) {
      dayGroups.forEach((group) => appendDayGroupToTimeline(group, { animIndexRef }));
      timeline.dataset.visibleCount = String(visible.length);
    } else {
      const delta = visible.slice(prevVisibleCount);
      if (delta.length) {
        const deltaGroups = groupEntriesByCalendarDay(delta);
        deltaGroups.forEach((group) => {
          const existing = getRenderedDayItem(group.dayKey);
          if (existing) {
            mergeDayGroupIntoExisting(existing, group, { animIndexRef });
          } else {
            appendDayGroupToTimeline(group, { animIndexRef });
          }
        });
        timeline.dataset.visibleCount = String(visible.length);
      }
    }

    observeCards();
    observeImages();
    observeFarMediaRelease();
    syncTagChipSelection();
    syncJumpDateControl();
    buildYearJump();
    buildTimeRail();
    syncTimeRailCurrent();
  };

  searchInput.addEventListener("input", () => {
    state.query = searchInput.value || "";
    state.pageIndex = 0;
    if (!hasApi) {
      render();
      persistViewStateSoon();
      return;
    }
    refreshApiListing().catch((error) => {
      console.error(error);
      countText.textContent = "时间轴接口加载失败";
    });
  });

  sortSelect.addEventListener("change", () => {
    state.sortDesc = sortSelect.value === "desc";
    state.pageIndex = 0;
    if (!hasApi) {
      render();
      persistViewStateSoon();
      return;
    }
    refreshApiListing().catch((error) => {
      console.error(error);
      countText.textContent = "时间轴接口加载失败";
    });
  });

  if (jumpDateBtn) {
    jumpDateBtn.addEventListener("click", () => {
      jumpToDate().catch((error) => {
        console.error(error);
        countText.textContent = "日期跳转失败";
      });
    });
  }

  if (timeRailToggle) {
    timeRailToggle.addEventListener("click", () => {
      setTimeRailOpen(timeRailPanel ? timeRailPanel.hidden : true);
    });
  }

  if (jumpDateInput) {
    jumpDateInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      jumpToDate().catch((error) => {
        console.error(error);
        countText.textContent = "日期跳转失败";
      });
    });
  }

  clearBtn.addEventListener("click", () => {
    state.query = "";
    state.tags = new Set();
    state.sortDesc = true;
    state.pageIndex = 0;
    state.expanded.clear();
    searchInput.value = "";
    sortSelect.value = "desc";
    Array.from(tagWrap.querySelectorAll(".chip")).forEach((chip) => chip.classList.remove("active"));
    replaceHashEntryId("");
    if (!hasApi) {
      render();
      persistViewStateSoon();
      return;
    }
    refreshApiListing().catch((error) => {
      console.error(error);
      countText.textContent = "时间轴接口加载失败";
    });
  });

  loadMore.addEventListener("click", async () => {
    const data = getEntries();
    const limit = (state.pageIndex + 1) * pageSize;
    if (limit < data.length) {
      state.pageIndex += 1;
      render({ append: true });
      persistViewStateSoon();
      return;
    }
    if (nextChunkUrl && !chunkLoading) {
      loadMore.disabled = true;
      const label = loadMore.textContent;
      loadMore.textContent = "加载中…";
      try {
        await fetchNextChunk();
        render({ append: true });
        persistViewStateSoon();
      } catch (e) {
        console.error(e);
        countText.textContent = "加载更多失败，请稍后重试";
      } finally {
        loadMore.disabled = false;
        loadMore.textContent = label;
      }
    }
  });

  nextBtn.addEventListener("click", nextPhoto);
  prevBtn.addEventListener("click", prevPhoto);
  lightboxClose.addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox) closeLightbox();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && timeRailPanel && !timeRailPanel.hidden) {
      setTimeRailOpen(false);
    }
    if (!lightbox.classList.contains("open")) return;
    if (event.key === "Escape") closeLightbox();
    if (event.key === "ArrowRight") nextPhoto();
    if (event.key === "ArrowLeft") prevPhoto();
  });

  document.addEventListener("click", (event) => {
    if (!timeRail || !timeRailPanel || timeRailPanel.hidden) return;
    if (timeRail.contains(event.target)) return;
    setTimeRailOpen(false);
  });

  window.addEventListener("scroll", persistViewStateSoon, { passive: true });
  window.addEventListener("scroll", syncTimeRailCurrent, { passive: true });
  window.addEventListener("pagehide", persistViewState);

  const bootstrap = async () => {
    const saved = readSavedViewState();
    applySavedUiState(saved);
    if (hasApi) {
      try {
        await fetchApiEntries({
          offset: 0,
          limit: Math.max(pageSize, (state.pageIndex + 1) * pageSize),
          append: false,
        });
      } catch (e) {
        console.error(e);
        countText.textContent = "时间轴接口加载失败（需先 npm run sync-photo-timeline 或点击工具里同步）";
        emptyState.style.display = "block";
        return;
      }
    } else if (hasRemote) {
      try {
        const first = await fetchJson(boot.dataUrl);
        mergeChunk(first);
      } catch (e) {
        console.error(e);
        countText.textContent = "时间轴数据加载失败";
        emptyState.style.display = "block";
        return;
      }
    }

    if (allEntries.length === 0) {
      countText.textContent = "暂无数据";
      emptyState.style.display = "block";
      return;
    }

    buildTags();
    syncTagChipSelection();
    syncJumpDateControl();
    setTimeRailOpen(false);
    buildTimeRail();
    await restoreViewPosition(saved);
  };

  bootstrap();
})();
