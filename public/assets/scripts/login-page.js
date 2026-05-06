(function () {
  const $ = (id) => document.getElementById(id);

  const form = $("loginForm");
  const usernameInput = $("username");
  const passwordInput = $("password");
  const submitBtn = $("loginSubmit");
  const statusEl = $("loginStatus");
  const continueLink = $("continueLink");
  const logoutBtn = $("logoutBtn");
  const togglePasswordBtn = $("togglePasswordBtn");
  const visualPanel = $("visualPanel");
  const pupilNodes = Array.from(document.querySelectorAll(".pupil, .dot-pupil"));
  const characterNodes = Array.from(document.querySelectorAll("[data-character]"));
  let lastMouseMoveAt = 0;

  const nextUrl = (() => {
    try {
      const url = new URL(window.location.href);
      const raw = String(url.searchParams.get("next") || "").trim();
      if (!raw) return "/photo-timeline.html";
      if (raw.startsWith("http://") || raw.startsWith("https://")) return "/photo-timeline.html";
      if (!raw.startsWith("/")) return "/photo-timeline.html";
      return raw;
    } catch {
      return "/photo-timeline.html";
    }
  })();

  if (continueLink) continueLink.href = nextUrl;

  const setStatus = (message, kind) => {
    if (!statusEl) return;
    statusEl.textContent = String(message || "");
    statusEl.classList.remove("is-error", "is-success");
    if (kind === "error") statusEl.classList.add("is-error");
    if (kind === "success") statusEl.classList.add("is-success");
  };

  const fetchJson = async (url, options) => {
    const res = await fetch(url, Object.assign({ credentials: "same-origin" }, options || {}));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || String(res.status));
    return data;
  };

  const setTypingState = (active) => {
    document.body.classList.toggle("is-typing", !!active);
  };

  const setUsernameFocusState = (active) => {
    document.body.classList.toggle("is-username-focus", !!active);
    if (active) {
      const target = visualPanel || document.body;
      const rect = target.getBoundingClientRect();
      applyGaze(rect.left + rect.width * 0.82, rect.top + rect.height * 0.24);
    }
  };

  const setPasswordFocusState = (active) => {
    document.body.classList.toggle("is-password-focus", !!active);
    if (active) {
      const target = visualPanel || document.body;
      const rect = target.getBoundingClientRect();
      applyGaze(rect.left + rect.width * 0.22, rect.top + rect.height * 0.78);
    }
  };

  const syncSessionUi = async () => {
    try {
      const session = await fetchJson("/api/photo-timeline/session");
      if (!session.hasSecret) {
        setStatus("服务端还没配置前台登录账号，请先填写 server/.env。", "error");
        if (submitBtn) submitBtn.disabled = true;
        return;
      }
      if (submitBtn) submitBtn.disabled = false;
      if (session.loggedIn) {
        if (usernameInput) usernameInput.value = session.username || "";
        if (passwordInput) passwordInput.value = "";
        if (logoutBtn) logoutBtn.hidden = false;
        setStatus(`当前已登录${session.username ? `：${session.username}` : ""}，可直接返回照片册。`, "success");
      } else {
        if (logoutBtn) logoutBtn.hidden = true;
        setStatus("", "");
      }
    } catch (error) {
      setStatus(String((error && error.message) || error), "error");
    }
  };

  const applyGaze = (clientX, clientY) => {
    const target = visualPanel || document.body;
    if (!target || !pupilNodes.length) return;
    const rect = target.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = (clientX - centerX) / Math.max(rect.width / 2, 1);
    const dy = (clientY - centerY) / Math.max(rect.height / 2, 1);
    const moveX = Math.max(-1, Math.min(1, dx));
    const moveY = Math.max(-1, Math.min(1, dy));
    pupilNodes.forEach((node) => {
      const isSmall = node.classList.contains("dot-pupil") || node.classList.contains("pupil--small");
      const max = isSmall ? 3.2 : 5.2;
      node.style.setProperty("--look-x", `${(moveX * max).toFixed(2)}px`);
      node.style.setProperty("--look-y", `${(moveY * max).toFixed(2)}px`);
    });
    characterNodes.forEach((node, index) => {
      const head = node.querySelector(".character__head");
      if (!head) return;
      const x = moveX * (index >= 2 ? 4.5 : 3.2);
      const y = moveY * (index >= 2 ? 2.8 : 2.1);
      const r = moveX * (index % 2 === 0 ? 2.5 : -2.5);
      head.style.setProperty("--head-x", `${x.toFixed(2)}px`);
      head.style.setProperty("--head-y", `${y.toFixed(2)}px`);
      head.style.setProperty("--head-r", `${r.toFixed(2)}deg`);
    });
    const mouth = document.querySelector(".character--yellow .character__mouth");
    if (mouth) {
      mouth.style.setProperty("--mouth-x", `${(moveX * 2.4).toFixed(2)}px`);
      mouth.style.setProperty("--mouth-r", `${(moveX * 3.2).toFixed(2)}deg`);
    }
  };

  const updatePupils = (event) => {
    if (document.body.classList.contains("is-username-focus")) return;
    if (document.body.classList.contains("is-password-focus")) return;
    lastMouseMoveAt = Date.now();
    applyGaze(event.clientX, event.clientY);
  };

  const runIdleLoop = () => {
    if (document.body.classList.contains("is-username-focus")) {
      window.requestAnimationFrame(runIdleLoop);
      return;
    }
    if (document.body.classList.contains("is-password-focus")) {
      window.requestAnimationFrame(runIdleLoop);
      return;
    }
    const idleFor = Date.now() - lastMouseMoveAt;
    if (idleFor > 1200) {
      const t = Date.now() / 1000;
      const fakeEvent = {
        clientX:
          ((visualPanel ? visualPanel.getBoundingClientRect().left : 0) || 0) +
          ((visualPanel ? visualPanel.getBoundingClientRect().width : window.innerWidth) || window.innerWidth) *
            (0.5 + Math.sin(t * 0.9) * 0.18),
        clientY:
          ((visualPanel ? visualPanel.getBoundingClientRect().top : 0) || 0) +
          ((visualPanel ? visualPanel.getBoundingClientRect().height : window.innerHeight) || window.innerHeight) *
            (0.48 + Math.cos(t * 1.2) * 0.12),
      };
      applyGaze(fakeEvent.clientX, fakeEvent.clientY);
    }
    window.requestAnimationFrame(runIdleLoop);
  };

  const setPasswordVisible = (visible) => {
    if (!passwordInput) return;
    passwordInput.type = visible ? "text" : "password";
    if (togglePasswordBtn) {
      togglePasswordBtn.classList.toggle("is-open", visible);
      togglePasswordBtn.setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
      togglePasswordBtn.title = visible ? "隐藏密码" : "显示密码";
    }
  };

  if (usernameInput) {
    usernameInput.addEventListener("focus", () => {
      setPasswordFocusState(false);
      setTypingState(true);
      setUsernameFocusState(true);
    });
    usernameInput.addEventListener("blur", () => {
      setTypingState(false);
      setUsernameFocusState(false);
    });
    usernameInput.addEventListener("input", () => {
      setTypingState(true);
      setUsernameFocusState(true);
    });
  }

  if (passwordInput) {
    passwordInput.addEventListener("focus", () => {
      setTypingState(false);
      setUsernameFocusState(false);
      setPasswordFocusState(true);
    });
    passwordInput.addEventListener("blur", () => setPasswordFocusState(false));
  }

  if (togglePasswordBtn) {
    togglePasswordBtn.addEventListener("click", () => {
      if (!passwordInput) return;
      setPasswordVisible(passwordInput.type === "password");
      passwordInput.focus();
    });
  }

  document.addEventListener("mousemove", updatePupils);

  if (form) {
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      const username = usernameInput ? String(usernameInput.value || "").trim() : "";
      const password = passwordInput ? String(passwordInput.value || "") : "";
      if (!username || !password) {
        setStatus("请输入用户名和密码。", "error");
        return;
      }
      if (submitBtn) submitBtn.disabled = true;
      setStatus("登录中…", "");
      try {
        await fetchJson("/api/photo-timeline/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        setStatus("登录成功，正在进入照片册…", "success");
        window.location.href = nextUrl;
      } catch (error) {
        setStatus(String((error && error.message) || error), "error");
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async function () {
      logoutBtn.disabled = true;
      try {
        await fetchJson("/api/photo-timeline/logout", { method: "POST" });
        if (passwordInput) passwordInput.value = "";
        setStatus("已退出登录。", "success");
        await syncSessionUi();
      } catch (error) {
        setStatus(String((error && error.message) || error), "error");
      } finally {
        logoutBtn.disabled = false;
      }
    });
  }

  setPasswordVisible(false);
  lastMouseMoveAt = 0;
  runIdleLoop();
  syncSessionUi();
})();
