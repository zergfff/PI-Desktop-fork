/*
 * 文件管理器视图的补充层（PI-Desktop fork）。
 *
 * 这个文件不改压缩过的应用 bundle，只在它之上补三件事：
 *
 *   1. 两种布局：从启动页打开的是「只留文件树」，由 revealView 带 piViewOpen 打开的
 *      是「只留预览」。同一份 bundle、两个 view id，于是点文件能开成独立标签。
 *   2. 树里的文件单击 → 走 ui.revealView 在 preview 标签里打开，不再挤在右侧小窗。
 *   3. PDF：选中文字后浮出高亮/下划线/删除线，写回 PDF 的 /Annots（fm.pdf.annotate），
 *      并补右键菜单（复制 / 打印 / 查找 / 标注）。
 */
(() => {
  "use strict";

  const bridge = window.pluginBridge;
  if (!bridge || typeof bridge.invoke !== "function") return;

  const invoke = bridge.invoke.bind(bridge);
  const params = new URLSearchParams(window.location.search);
  const deepLink = (params.get("piViewOpen") || "").trim();
  const isPreview = Boolean(deepLink);

  document.documentElement.classList.add(isPreview ? "pi-preview-only" : "pi-tree-only");

  /**
   * 当前文件。`window.pluginBridge` 是冻结对象，改不了它的方法，所以路径靠两条：
   * 深链（piViewOpen）以及点树时写进 localStorage 的那一份 —— 两个标签同源，读得到。
   */
  const PATH_KEY = "pi.fm.previewPath";
  let currentPath = deepLink;
  try {
    if (!currentPath) currentPath = window.localStorage.getItem(PATH_KEY) || "";
    bridge.on("view:open", (payload) => {
      if (payload && typeof payload.path === "string" && payload.path) currentPath = payload.path;
      window.setTimeout(prunePdfTabs, 1200);
    });
  } catch {
    /* older hosts push nothing; the deep link already covers the first open */
  }

  /**
   * 预览标签里每换一次文件，插件就多留一个内部文档标签。文档标签条被 CSS 藏起来了，
   * 但那份 pdf.js 文档还在内存里，所以这里把**非当前**的 PDF 内部标签顺手关掉；
   * 文本类标签不动 —— 它们可能有未保存的草稿，关掉会弹确认框。
   */
  let closing = false;
  const prunePdfTabs = () => {
    if (closing || !isPreview) return;
    const strip = document.querySelector(".fm-document-tabs");
    if (!strip) return;
    const tabs = Array.from(strip.querySelectorAll(".fm-file-tab"));
    if (tabs.length < 2) return;
    // 活动标记在包一层的 div 上（data-active），而不是内部 button 的 aria-selected
    const isActive = (tab) =>
      tab.getAttribute("data-active") === "true" ||
      tab.querySelector('[role="tab"][aria-selected="true"]') !== null;
    const stale = tabs.filter((tab) => {
      const name = (tab.querySelector(".fm-tab-name")?.textContent || "").trim();
      return !isActive(tab) && /\.pdf$/i.test(name);
    });
    // 兜底：剩不到一个活动标签时什么都不关，宁可多留也不要把预览关空
    if (stale.length === 0 || stale.length >= tabs.length) return;
    closing = true;
    for (const tab of stale) tab.querySelector(".fm-tab-close")?.click();
    window.setTimeout(() => {
      closing = false;
    }, 400);
  };

  // ── 树：单击文件 → 在 preview 标签里打开 ────────────────────────────────────
  document.addEventListener(
    "click",
    (event) => {
      if (isPreview) return;
      const row = event.target && event.target.closest ? event.target.closest('[role="treeitem"][data-path]') : null;
      if (!row) return;
      // 目录行带 aria-expanded，展开是它自己的事；只有文件才转去预览。
      if (row.hasAttribute("aria-expanded")) return;
      const path = row.getAttribute("data-path");
      if (!path) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        window.localStorage.setItem(PATH_KEY, path);
      } catch {
        /* private mode: the deep link still carries the path */
      }
      bridge.invoke("ui.revealView", { viewId: "preview", location: path }).catch(() => {});
    },
    true,
  );

  // ── 查找：Ctrl+F 打开查看器自带的搜索条 ────────────────────────────────────
  document.addEventListener(
    "keydown",
    (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return;
      const toggle = document.querySelector(".pdf-search-toggle");
      if (!toggle) return;
      event.preventDefault();
      toggle.click();
      const input = document.querySelector(".pdf-search input");
      if (input) input.focus();
    },
    true,
  );

  // ── 选区 → 页面归一化矩形 ─────────────────────────────────────────────────
  /**
   * 把 DOM 选区按页拆成「页面归一化矩形」，PDF 用户空间换算留给宿主。
   * 只在真正要记一条标注时调用。
   */
  const collectSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const stage = document.querySelector(".pdf-stage");
    if (!stage || !stage.contains(range.commonAncestorContainer)) return null;
    const byPage = new Map();
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width < 1 || rect.height < 1) continue;
      const page = document
        .elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        ?.closest(".page");
      if (!page) continue;
      const box = page.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      const pageNumber = Number(page.getAttribute("data-page-number")) || 1;
      const entry = byPage.get(pageNumber) ?? [];
      entry.push({
        x0: (rect.left - box.left) / box.width,
        y0: (rect.top - box.top) / box.height,
        x1: (rect.right - box.left) / box.width,
        y1: (rect.bottom - box.top) / box.height,
      });
      byPage.set(pageNumber, entry);
    }
    if (byPage.size === 0) return null;
    return { byPage, text: selection.toString().slice(0, 2000) };
  };

  // ── 未保存的标注：先画在页面上，点保存才写进文件 ──────────────────────────
  let pending = [];

  const paint = () => {
    for (const node of Array.from(document.querySelectorAll(".pi-annot"))) node.remove();
    if (pending.length === 0) return;
    for (const op of pending) {
      const page = document.querySelector(`.page[data-page-number="${op.page}"]`);
      if (!page) continue;
      for (const rect of op.rects ?? []) {
        const mark = document.createElement("div");
        mark.className = "pi-annot";
        mark.dataset.kind = op.kind;
        mark.style.left = `${rect.x0 * 100}%`;
        mark.style.top = `${rect.y0 * 100}%`;
        mark.style.width = `${Math.max(0, rect.x1 - rect.x0) * 100}%`;
        mark.style.height = `${Math.max(0, rect.y1 - rect.y0) * 100}%`;
        page.append(mark);
      }
    }
  };

  const bar = document.createElement("div");
  bar.className = "pi-pdf-save";
  bar.hidden = true;
  const barCount = document.createElement("span");
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.textContent = "保存";
  const discardButton = document.createElement("button");
  discardButton.type = "button";
  discardButton.textContent = "放弃";
  bar.append(barCount, saveButton, discardButton);
  document.body.append(bar);

  const syncBar = () => {
    const count = pending.reduce((total, op) => total + (op.rects?.length ?? 0), 0);
    bar.hidden = count === 0;
    barCount.textContent = count === 0 ? "" : `未保存 ${count} 处标注`;
  };

  const setPending = (ops) => {
    pending = Array.isArray(ops) ? ops : [];
    paint();
    syncBar();
  };

  const reload = () => window.location.reload();

  saveButton.addEventListener("click", async () => {
    if (!currentPath || pending.length === 0) return;
    saveButton.disabled = true;
    saveButton.textContent = "保存中…";
    try {
      const result = await bridge.invoke("fm.pdf.commit", { path: currentPath });
      if (result && result.ok) {
        pending = [];
        reload();
        return;
      }
      saveButton.textContent = "保存失败";
    } catch {
      saveButton.textContent = "保存失败";
    } finally {
      saveButton.disabled = false;
      window.setTimeout(() => {
        saveButton.textContent = "保存";
      }, 1500);
    }
  });

  discardButton.addEventListener("click", async () => {
    if (!currentPath) return;
    try {
      await bridge.invoke("fm.pdf.discard", { path: currentPath });
    } catch {
      /* 草稿删不掉也不该拦住界面 */
    }
    setPending([]);
  });

  // 页面重绘（缩放、翻页）会丢掉叠加层，重画一次；节流免得滚动时抖动。
  let paintTimer = 0;
  const repaint = () => {
    if (!isPreview) return;
    window.clearTimeout(paintTimer);
    paintTimer = window.setTimeout(() => {
      paint();
      ensureNavHandle();
      syncOpenDefault();
      ensureAddressBar();
    }, 120);
  };
  const scroller = document.querySelector(".pdf-scroll") ?? document.body;
  scroller.addEventListener("scroll", repaint, { passive: true });
  window.addEventListener("resize", repaint);
  new MutationObserver(repaint).observe(document.body, { childList: true, subtree: true });

  // 直接关标签/刷新时宿主不会问插件，这里至少拦住"页面被替换"这条路径。
  window.addEventListener("beforeunload", (event) => {
    if (pending.length === 0) return;
    event.preventDefault();
    event.returnValue = "";
  });

  // 打开时把草稿读回来：上次没保存的标注还画在页面上。
  if (isPreview && currentPath) {
    bridge
      .invoke("fm.pdf.draft", { path: currentPath })
      .then((result) => {
        if (result && Array.isArray(result.ops)) setPending(result.ops);
      })
      .catch(() => {});
  }

  // ── 地址栏：文件管理器的根可以手输 ─────────────────────────────────────────
  // 文件管理器本来就是个浏览器，根不该只有"项目或主目录"。输入 `C:`、`D:\work`
  // 这类绝对路径就把它设成新的根；换根后整页重载，树/搜索/Git 都按新根重新推导。
  const ensureAddressBar = () => {
    if (isPreview) return;
    const header = document.querySelector("header");
    if (!header || header.querySelector(".pi-fm-addr")) return;
    const form = document.createElement("form");
    form.className = "pi-fm-addr";
    const input = document.createElement("input");
    input.type = "text";
    input.spellcheck = false;
        input.placeholder = "输入路径，如 C: 或 D:" + String.fromCharCode(92) + "某个目录";
    const go = document.createElement("button");
    go.type = "submit";
    go.textContent = "前往";
    form.append(input, go);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const target = input.value.trim();
      if (!target) return;
      input.classList.remove("pi-invalid");
      go.disabled = true;
      try {
        const result = await bridge.invoke("fm.setRoot", { path: target });
        if (result && result.ok) {
          window.location.reload();
          return;
        }
      } catch {
        input.classList.add("pi-invalid");
      }
      go.disabled = false;
    });
    header.append(form);
    bridge
      .invoke("fm.root", {})
      .then((result) => {
        if (result && result.path && !input.value) input.value = result.path;
      })
      .catch(() => {});
  };

  // ── Ctrl + 滚轮缩放（所有预览类型）─────────────────────────────────────────
  let zoomFactor = 1;
  document.addEventListener(
    "wheel",
    (event) => {
      if (!isPreview || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const zoom = document.querySelector(".pdf-zoom");
      if (zoom) {
        // PDF：交给查看器自己的缩放，页面尺寸、文本层和注释层才会一起变。
        const buttons = Array.from(zoom.querySelectorAll("button"));
        const minus = buttons.find((b) => /^[−\-]$/.test((b.textContent || "").trim()));
        const plus = buttons.find((b) => /^[+＋]$/.test((b.textContent || "").trim()));
        const target = event.deltaY < 0 ? plus : minus;
        if (target) target.click();
        return;
      }
      // 其它预览（文本 / 图片 / 表格 / 转换后的 Office）：整块内容缩放即可。
      const host = document.querySelector(".pi-zoom-host") ?? document.querySelector("#root > div");
      if (!host) return;
      zoomFactor = Math.min(3, Math.max(0.5, zoomFactor * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
      host.style.zoom = zoomFactor === 1 ? "" : String(Number(zoomFactor.toFixed(3)));
    },
    { passive: false, capture: true },
  );

  // ── 预览不了的文件：用本机默认应用打开 ─────────────────────────────────────
  const PREVIEWABLE = /\.(pdf|txt|md|markdown|json|jsonc|csv|tsv|log|yml|yaml|toml|ini|conf|js|mjs|cjs|ts|tsx|jsx|css|scss|html|htm|xml|sql|py|rs|go|java|c|h|cpp|sh|bat|ps1|png|jpe?g|gif|webp|bmp|ico|avif|svg|mp4|webm|mov|mkv|mp3|wav|m4a|ogg|flac|aac|xlsx|xls|csv|sqlite|db)$/i;

  const openDefault = document.createElement("button");
  openDefault.type = "button";
  openDefault.className = "pi-open-default";
  openDefault.textContent = "用默认应用打开";
  openDefault.hidden = true;
  openDefault.addEventListener("click", () => {
    if (!currentPath) return;
    openDefault.disabled = true;
    bridge
      .invoke("fs.openDefault", { path: currentPath })
      .catch(() => {})
      .finally(() => {
        openDefault.disabled = false;
      });
  });
  document.body.append(openDefault);

  const syncOpenDefault = () => {
    if (!isPreview) {
      openDefault.hidden = true;
      return;
    }
    const name = (currentPath.split(/[\\/]/).pop() || "").toLowerCase();
    // 转换中的 Office / PDF 一旦拿到 PDF 预览就不再提示；这里只看扩展名，
    // 因为转换失败时界面确实只剩「打开方式」这一条路。
    const converting = /\.(docx?|pptx?|xlsx?|odt|rtf)$/i.test(name) && Boolean(document.querySelector(".pdf-stage"));
    openDefault.hidden = !name || PREVIEWABLE.test(name) || converting;
  };

  // ── 工具栏「导航」块的宽度可拖 ─────────────────────────────────────────────
  // 页码块默认按内容撑开（194px），窄面板下把缩放挤出去。给它一条分隔条，宽度记在
  // localStorage 里，下次打开还是这个宽度。
  const NAV_WIDTH_KEY = "pi.fm.pdfNavWidth";
  const NAV_MIN = 84;
  const NAV_MAX = 320;

  const applyNavWidth = (toolbar, width) => {
    toolbar.style.setProperty("--pi-pdf-nav-w", `${Math.round(width)}px`);
  };

  const ensureNavHandle = () => {
    if (!isPreview) return;
    const toolbar = document.querySelector(".pdf-toolbar");
    const nav = toolbar?.querySelector(".pdf-navigation");
    if (!toolbar || !nav) return;
    let saved = 0;
    try {
      saved = Number(window.localStorage.getItem(NAV_WIDTH_KEY)) || 0;
    } catch {
      saved = 0;
    }
    if (saved >= NAV_MIN) applyNavWidth(toolbar, Math.min(saved, NAV_MAX));

    if (toolbar.querySelector(".pi-pdf-nav-resize")) return;
    const handle = document.createElement("div");
    handle.className = "pi-pdf-nav-resize";
    handle.title = "拖动调整导航宽度";
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = nav.getBoundingClientRect().width;
      handle.setPointerCapture(event.pointerId);
      const move = (moveEvent) => {
        const width = Math.min(NAV_MAX, Math.max(NAV_MIN, startWidth + (moveEvent.clientX - startX)));
        applyNavWidth(toolbar, width);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.classList.remove("pi-dragging");
        try {
          window.localStorage.setItem(
            NAV_WIDTH_KEY,
            String(Math.round(nav.getBoundingClientRect().width)),
          );
        } catch {
          /* 记不住就只影响下次打开 */
        }
      };
      handle.classList.add("pi-dragging");
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
    nav.after(handle);
  };

  // ── PDF 右键菜单 ───────────────────────────────────────────────────────────
  // 只在右键时出现；选中文字才多出三个标注项。不做「选中就浮出工具条」——
  // 那是选区自己的交互，多一个浮层只会挡住正文。
  const menu = document.createElement("div");
  menu.className = "pi-pdf-menu";
  menu.hidden = true;
  document.body.append(menu);

  const menuItems = () => {
    const picked = collectSelection();
    const items = [
      { id: "copy", label: "复制" },
      { id: "print", label: "打印…" },
      { id: "find", label: "查找…" },
    ];
    if (picked) {
      items.push(
        { id: "highlight", label: "高亮" },
        { id: "underline", label: "下划线" },
        { id: "strike", label: "删除线" },
      );
    }
    return items;
  };

  // capture 阶段：查看器自己也监听 contextmenu，冒泡阶段可能轮不到我们。
  document.addEventListener(
    "contextmenu",
    (event) => {
      if (!isPreview) return;
      const stage = event.target && event.target.closest ? event.target.closest(".pdf-stage") : null;
      if (!stage) return;
      event.preventDefault();
      event.stopPropagation();
      menu.replaceChildren();
      for (const item of menuItems()) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = item.label;
        button.dataset.id = item.id;
        menu.append(button);
      }
      menu.hidden = false;
      menu.style.left = `${Math.min(event.clientX, window.innerWidth - 180)}px`;
      menu.style.top = `${Math.min(event.clientY, window.innerHeight - 200)}px`;
    },
    true,
  );

  // 点菜单外面才收起来；点在菜单里什么都不做，否则收起后这一下会落到下面的
  // 文件树上（表现为「点高亮却打开了某个 .lnk」）。
  document.addEventListener(
    "mousedown",
    (event) => {
      if (menu.hidden) return;
      if (event.composedPath().includes(menu)) return;
      menu.hidden = true;
    },
    true,
  );

  menu.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-id]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const id = button.dataset.id;
    menu.hidden = true;
    if (id === "copy") {
      try {
        await navigator.clipboard.writeText(window.getSelection()?.toString() || "");
      } catch {
        /* nothing to do */
      }
      return;
    }
    if (id === "print") {
      const printButton = document.querySelector(".pdf-print, [aria-label*='打印'], [title*='打印']");
      if (printButton) printButton.click();
      else window.print();
      return;
    }
    if (id === "find") {
      const toggle = document.querySelector(".pdf-search-toggle");
      if (toggle) toggle.click();
      const input = document.querySelector(".pdf-search input");
      if (input) input.focus();
      return;
    }
    // 标注：只记草稿，不动文件。
    const picked = collectSelection();
    if (!picked || !currentPath) return;
    const ops = [...picked.byPage.entries()].map(([page, rects]) => ({
      page,
      kind: id,
      rects,
      text: picked.text,
    }));
    try {
      const result = await bridge.invoke("fm.pdf.stage", { path: currentPath, ops });
      if (result && Array.isArray(result.ops)) setPending(result.ops);
    } catch {
      /* 记不下来就什么都不改，文件至少没被动过 */
    }
  });

  window.setTimeout(() => {
    ensureNavHandle();
    syncOpenDefault();
    ensureAddressBar();
    prunePdfTabs();
  }, 1200);
})();
