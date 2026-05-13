(function () {
  const searchInput = document.getElementById("mapSearchInput");
  const statusEl = document.getElementById("mapStatus");
  const listEl = document.getElementById("mapPointList");
  const emptyEl = document.getElementById("mapEmptyState");
  const mapCanvas = document.getElementById("mapCanvas");
  const statTotal = document.getElementById("statTotal");
  const statVisible = document.getElementById("statVisible");
  const statPlaces = document.getElementById("statPlaces");
  const mapGuestHint = document.getElementById("mapGuestHint");

  const state = {
    allPoints: [],
    filteredPoints: [],
    markers: [],
    markerById: new Map(),
    map: null,
    infoWindow: null,
    AMap: null,
  };

  const norm = (value) =>
    String(value == null ? "" : value)
      .trim()
      .toLowerCase();

  const getPointText = (point) =>
    [
      point.date,
      point.calendar_date,
      point.title,
      point.place,
      point.note,
      point.gps && point.gps.label,
      point.cover && point.cover.caption,
    ]
      .filter(Boolean)
      .join(" ");

  const truncateCoordToDecimals = (value, decimals) => {
    const factor = 10 ** decimals;
    return Math.trunc(Number(value) * factor) / factor;
  };

  const wgs84ToGcj02 = (lat, lng) => {
    const PI = Math.PI;
    const outOfChina = (la, ln) => ln < 72.004 || ln > 137.8347 || la < 0.8293 || la > 55.8271;
    if (outOfChina(lat, lng)) return { lat, lng };

    const transformLat = (ln, la) => {
      let ret =
        -100.0 + 2.0 * ln + 3.0 * la + 0.2 * la * la + 0.1 * ln * la + 0.2 * Math.sqrt(Math.abs(ln));
      ret += ((20.0 * Math.sin(6.0 * ln * PI) + 20.0 * Math.sin(2.0 * ln * PI)) * 2.0) / 3.0;
      ret += ((20.0 * Math.sin(la * PI) + 40.0 * Math.sin((la / 3.0) * PI)) * 2.0) / 3.0;
      ret += ((160.0 * Math.sin((la / 12.0) * PI) + 320 * Math.sin((la * PI) / 30.0)) * 2.0) / 3.0;
      return ret;
    };

    const transformLng = (ln, la) => {
      let ret =
        300.0 + ln + 2.0 * la + 0.1 * ln * ln + 0.1 * ln * la + 0.1 * Math.sqrt(Math.abs(ln));
      ret += ((20.0 * Math.sin(6.0 * ln * PI) + 20.0 * Math.sin(2.0 * ln * PI)) * 2.0) / 3.0;
      ret += ((20.0 * Math.sin(ln * PI) + 40.0 * Math.sin((ln / 3.0) * PI)) * 2.0) / 3.0;
      ret += ((150.0 * Math.sin((ln / 12.0) * PI) + 300.0 * Math.sin((ln / 30.0) * PI)) * 2.0) / 3.0;
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

  const pointPlaceBucket = (point) => {
    const gps = point && point.gps ? point.gps : {};
    return `${truncateCoordToDecimals(gps.latitude, 2).toFixed(2)},${truncateCoordToDecimals(gps.longitude, 2).toFixed(2)}`;
  };

  const resolveUrl = (path) => new URL(path, window.location.href).toString();

  const sitePathPrefix = () => {
    try {
      const p = window.location.pathname || "";
      if (p.startsWith("/photo-album/")) return "/photo-album";
    } catch (_) {
      /* ignore */
    }
    return "";
  };

  const toSiteMediaUrl = (u) => {
    let s = String(u || "").trim();
    if (!s) return s;
    s = s.replace(/\\/g, "/");
    const base = sitePathPrefix();
    const noLead = s.replace(/^\/+/, "");
    if (
      !/^assets\/live(\/|$)/i.test(noLead) &&
      !/^uploadphotos\//i.test(noLead) &&
      !/^(https?:|data:)/i.test(noLead)
    ) {
      if (/^_(livp-external|admin-manual|admin-import)(\/|$)/i.test(noLead)) {
        s = `assets/live/${noLead}`;
      }
    }
    if (/^uploadphotos\//i.test(s)) return `${base}/${s.replace(/^\/+/, "")}`;
    if (/^\/assets\/live(\/|$)/i.test(s)) return `${base}${s}`;
    if (/^assets\/live(\/|$)/i.test(s)) return `${base}/${s.replace(/^\/+/, "")}`;
    return s;
  };

  const escapeHtml = (value) =>
    String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      if (ch === "&") return "&amp;";
      if (ch === "<") return "&lt;";
      if (ch === ">") return "&gt;";
      if (ch === '"') return "&quot;";
      return "&#39;";
    });

  const setStatus = (text) => {
    statusEl.textContent = text;
  };

  const loadJson = async (path) => {
    const res = await fetch(resolveUrl(path), { credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || res.statusText || String(res.status));
    }
    return data;
  };

  const loadAmapSdk = async (config) => {
    if (window.AMap) return window.AMap;
    if (!config.amapJsKey) {
      throw new Error("未配置高德地图 JS Key（请在 server/.env 设置 AMAP_JS_KEY）");
    }
    if (config.amapSecurityJsCode) {
      window._AMapSecurityConfig = { securityJsCode: config.amapSecurityJsCode };
    }
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src =
        `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(config.amapJsKey)}&plugin=` +
        encodeURIComponent("AMap.Scale,AMap.ToolBar");
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("高德地图脚本加载失败"));
      document.head.appendChild(script);
    });
    if (!window.AMap) throw new Error("高德地图初始化失败");
    return window.AMap;
  };

  const buildTimelineHref = (point) =>
    `./photo-timeline.html#entry=${encodeURIComponent(point.id)}`;

  const buildInfoHtml = (point) => {
    const coverRaw =
      point.cover && (point.cover.thumb || point.cover.src) ? point.cover.thumb || point.cover.src : "";
    const cover = toSiteMediaUrl(coverRaw);
    const title = point.title || point.gps.label || point.date || "照片";
    const meta = [point.date, point.gps.label || point.place || "", `${point.photoCount || 0} 张照片`]
      .filter(Boolean)
      .join(" · ");
    const note = point.note ? String(point.note).slice(0, 120) : "";
    const escapedTitle = escapeHtml(title);
    const escapedMeta = escapeHtml(meta);
    const escapedNote = escapeHtml(note);
    return [
      `<div class="photo-map-info">`,
      cover ? `<img class="photo-map-info__cover" src="${cover}" alt="${escapedTitle}" />` : "",
      `<h3 class="photo-map-info__title">${escapedTitle}</h3>`,
      escapedMeta ? `<p class="photo-map-info__meta">${escapedMeta}</p>` : "",
      escapedNote ? `<p class="photo-map-info__note">${escapedNote}</p>` : "",
      `<a class="photo-map-info__link" href="${buildTimelineHref(point)}" target="_blank" rel="noopener noreferrer">在时间轴中查看</a>`,
      `</div>`,
    ].join("");
  };

  const openPoint = (point) => {
    const marker = state.markerById.get(point.id);
    if (!marker || !state.map || !state.AMap) return;
    const html = buildInfoHtml(point);
    if (!state.infoWindow) {
      state.infoWindow = new state.AMap.InfoWindow({ offset: new state.AMap.Pixel(0, -18) });
    }
    state.infoWindow.setContent(html);
    const lngLat = marker.getCenter ? marker.getCenter() : marker.getPosition();
    state.infoWindow.open(state.map, lngLat);
    state.map.setCenter(lngLat);
  };

  const renderList = () => {
    listEl.innerHTML = "";
    const frag = document.createDocumentFragment();
    const points = state.filteredPoints.slice(0, 200);
    points.forEach((point) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "map-point-item";
      btn.addEventListener("click", () => openPoint(point));

      const coverUrlRaw =
        point.cover && (point.cover.thumb || point.cover.src) ? point.cover.thumb || point.cover.src : "";
      const coverUrl = toSiteMediaUrl(coverUrlRaw);
      if (coverUrl) {
        const img = document.createElement("img");
        img.src = coverUrl;
        img.alt = point.title || point.gps.label || point.date || "照片";
        btn.appendChild(img);
      } else {
        const placeholder = document.createElement("div");
        placeholder.className = "map-point-item__placeholder";
        placeholder.textContent = "照片";
        btn.appendChild(placeholder);
      }

      const body = document.createElement("div");
      const title = document.createElement("p");
      title.className = "map-point-item__title";
      title.textContent = point.title || point.gps.label || point.date || "未命名照片";
      body.appendChild(title);

      const meta = document.createElement("p");
      meta.className = "map-point-item__meta";
      meta.textContent = [point.date, point.gps.label || point.place || "", `${point.photoCount || 0} 张照片`]
        .filter(Boolean)
        .join(" · ");
      body.appendChild(meta);

      if (point.note) {
        const note = document.createElement("p");
        note.className = "map-point-item__note";
        note.textContent = String(point.note).slice(0, 80);
        body.appendChild(note);
      }
      btn.appendChild(body);
      frag.appendChild(btn);
    });
    listEl.appendChild(frag);
  };

  const syncMarkers = () => {
    if (!state.map) return;
    const visibleIds = new Set(state.filteredPoints.map((point) => point.id));
    const visibleMarkers = [];
    state.markers.forEach((marker) => {
      const point = marker.getExtData();
      if (visibleIds.has(point.id)) {
        marker.setMap(state.map);
        visibleMarkers.push(marker);
      } else {
        marker.setMap(null);
      }
    });
    if (visibleMarkers.length) {
      state.map.setFitView(visibleMarkers);
      emptyEl.hidden = true;
    } else {
      emptyEl.hidden = false;
    }
  };

  const updateStats = () => {
    statTotal.textContent = String(state.allPoints.length);
    statVisible.textContent = String(state.filteredPoints.length);
    statPlaces.textContent = String(new Set(state.filteredPoints.map(pointPlaceBucket)).size);
  };

  const applyFilter = () => {
    const q = norm(searchInput.value);
    state.filteredPoints = !q
      ? state.allPoints.slice()
      : state.allPoints.filter((point) => norm(getPointText(point)).includes(q));
    updateStats();
    renderList();
    syncMarkers();
    setStatus(state.filteredPoints.length ? `显示 ${state.filteredPoints.length} 个点位` : "没有匹配结果");
  };

  const createMarkers = () => {
    state.markers = state.allPoints.map((point) => {
      const gcj = wgs84ToGcj02(point.gps.latitude, point.gps.longitude);
      const marker = new state.AMap.CircleMarker({
        center: [gcj.lng, gcj.lat],
        radius: 6,
        strokeColor: "rgba(255,255,255,0.96)",
        strokeWeight: 2,
        strokeOpacity: 1,
        fillColor: "#8b6f4e",
        fillOpacity: 0.92,
        bubble: true,
        cursor: "pointer",
        zIndex: 120,
        extData: point,
      });
      marker.on("click", () => openPoint(point));
      state.markerById.set(point.id, marker);
      return marker;
    });
    state.map.add(state.markers);
  };

  const initMap = async () => {
    const [config, pointData] = await Promise.all([
      loadJson("/api/photo-timeline/map-config"),
      loadJson("/api/photo-timeline/map-points"),
    ]);

    state.allPoints = Array.isArray(pointData.points) ? pointData.points : [];
    state.filteredPoints = state.allPoints.slice();
    updateStats();
    renderList();

    if (mapGuestHint) {
      mapGuestHint.hidden = true;
      mapGuestHint.textContent = "";
    }
    if (
      mapGuestHint &&
      !pointData.loggedIn &&
      Number(pointData.guestVisiblePhotoLimit) > 0
    ) {
      const lim = Number(pointData.guestVisiblePhotoLimit);
      let msg = `未登录：痕迹仅展示至多 ${lim} 张照片范围内的点位（与时间轴限额一致）`;
      const cnt = pointData.guestVisiblePhotoCount;
      if (cnt != null && Number.isFinite(Number(cnt))) {
        msg += ` · 当前约 ${Number(cnt)} 张`;
      }
      if (pointData.guestPreviewTruncated) msg += " · 已达预览上限";
      mapGuestHint.textContent = msg;
      mapGuestHint.hidden = false;
    }

    if (!state.allPoints.length) {
      emptyEl.hidden = false;
      setStatus("没有可显示的 GPS 点位");
      return;
    }

    state.AMap = await loadAmapSdk(config);
    const baseLayer = new state.AMap.TileLayer({
      visible: true,
      opacity: 1,
      zIndex: 1,
    });
    state.map = new state.AMap.Map(mapCanvas, {
      zoom: 4,
      viewMode: "2D",
      center: [104.114129, 37.550339],
      layers: [baseLayer],
      showLabel: true,
      terrain: false,
      resizeEnable: true,
      animateEnable: false,
      jogEnable: false,
    });
    state.map.addControl(new state.AMap.Scale());
    state.map.addControl(new state.AMap.ToolBar({ position: "RB" }));
    createMarkers();
    syncMarkers();
    setStatus(`已加载 ${state.allPoints.length} 个点位`);
  };

  searchInput.addEventListener("input", applyFilter);

  initMap().catch((err) => {
    emptyEl.hidden = false;
    setStatus("加载失败");
    emptyEl.innerHTML =
      `<strong>地图加载失败</strong><span>${String((err && err.message) || err)}</span>`;
  });
})();

