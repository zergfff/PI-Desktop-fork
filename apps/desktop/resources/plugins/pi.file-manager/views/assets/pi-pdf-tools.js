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

  // ── 选中文字 → 浮出标注工具 ────────────────────────────────────────────────
  const bar = document.createElement("div");
  bar.className = "pi-pdf-bar";
  bar.hidden = true;
  const actions = [
    { kind: "highlight", label: "高亮" },
    { kind: "underline", label: "下划线" },
    { kind: "strike", label: "删除线" },
  ];
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.dataset.kind = action.kind;
    bar.append(button);
  }
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.textContent = "复制";
  copyButton.dataset.kind = "copy";
  bar.append(copyButton);

  let selectionRects = [];
  const hideBar = () => {
    bar.hidden = true;
    selectionRects = [];
  };

  /** 把 DOM 选区按页拆成「页面归一化矩形」，PDF 用户空间换算留给宿主。 */
  const collectSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!document.querySelector(".pdf-stage") || !document.querySelector(".pdf-stage").contains(range.commonAncestorContainer)) {
      return null;
    }
    const byPage = new Map();
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width < 1 || rect.height < 1) continue;
      const page = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest(".page");
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

  document.addEventListener("mouseup", (event) => {
    if (!isPreview) return;
    if (bar.contains(event.target)) return;
    window.setTimeout(() => {
      const picked = collectSelection();
      if (!picked) return hideBar();
      selectionRects = [...picked.byPage.entries()].map(([page, rects]) => ({ page, rects }));
      bar.dataset.text = picked.text;
      const last = window.getSelection().getRangeAt(0).getBoundingClientRect();
      bar.hidden = false;
      bar.style.left = `${Math.max(8, Math.min(window.innerWidth - 260, last.left))}px`;
      bar.style.top = `${Math.max(8, last.top - 44)}px`;
    }, 10);
  });

  document.addEventListener("mousedown", (event) => {
    if (!bar.hidden && !bar.contains(event.target)) hideBar();
  });

  const reload = () => {
    // 注释写进文件后重新载入，让 pdf.js 的注释层把新 Annotation 画出来。
    window.location.reload();
  };

  bar.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-kind]");
    if (!button) return;
    const kind = button.dataset.kind;
    if (kind === "copy") {
      try {
        await navigator.clipboard.writeText(bar.dataset.text || "");
      } catch {
        /* clipboard refused: the selection is still there to copy by hand */
      }
      hideBar();
      return;
    }
    if (!currentPath) {
      button.textContent = "先打开文件";
      return;
    }
    const ops = selectionRects.map((entry) => ({
      page: entry.page,
      kind,
      rects: entry.rects,
      text: bar.dataset.text || "",
    }));
    button.disabled = true;
    try {
      const result = await bridge.invoke("fm.pdf.annotate", { path: currentPath, ops });
      if (result && result.ok) reload();
      else button.textContent = "未写入";
    } catch (error) {
      button.textContent = "写入失败";
    } finally {
      button.disabled = false;
    }
  });

  // ── PDF 右键菜单 ───────────────────────────────────────────────────────────
  const menu = document.createElement("div");
  menu.className = "pi-pdf-menu";
  menu.hidden = true;

  const menuItems = () => {
    const picked = collectSelection();
    const items = [
      { id: "copy", label: "复制" },
      { id: "print", label: "打印…" },
      { id: "find", label: "查找…" },
    ];
    if (picked) items.push({ id: "highlight", label: "高亮" }, { id: "underline", label: "下划线" }, { id: "strike", label: "删除线" });
    return items;
  };

  const openMenu = (event) => {
    const stage = event.target.closest && event.target.closest(".pdf-stage");
    if (!stage) return;
    event.preventDefault();
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
  };
  document.addEventListener("contextmenu", openMenu);

  document.addEventListener("mousedown", (event) => {
    if (!menu.hidden && !menu.contains(event.target)) menu.hidden = true;
  });

  menu.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-id]");
    if (!button) return;
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
    // 选区还在：标完再收起菜单
    const picked = collectSelection();
    if (!picked || !currentPath) return;
    const ops = [...picked.byPage.entries()].map(([page, rects]) => ({ page, kind: id, rects, text: picked.text }));
    try {
      const result = await bridge.invoke("fm.pdf.annotate", { path: currentPath, ops });
      if (result && result.ok) reload();
    } catch {
      /* surfacing the failure in a menu that is already gone helps nobody */
    }
  });

  document.body.append(bar, menu);
  // 打开时就清一次：上一个会话可能留下了几个 PDF 内部标签。
  window.setTimeout(prunePdfTabs, 2500);
})();
