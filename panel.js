const $ = (id) => document.getElementById(id);

const STORE_KEY = "pixel-helper:sections";
function loadSaved() {
  try {
    return (JSON.parse(localStorage.getItem(STORE_KEY)) ?? []).filter(
      (s) => !looksLikePage(s.segment),
    );
  } catch {
    return [];
  }
}

// A top-level segment with a file extension or a long ID is a page slug, not a section.
const looksLikePage = (segment) =>
  /\.\w{2,5}$/.test(segment) || /\d{5,}/.test(segment);
const persist = () =>
  localStorage.setItem(STORE_KEY, JSON.stringify(state.saved));

const state = {
  raw: "",
  layer: [],
  isArray: true,
  pageUrl: "",
  host: "",
  saved: loadSaved(),
  open: new Set(),
  rows: [],
  urlItems: [],
  urlEdited: false,
};

const IDENT = /^[A-Za-z_$][\w$]*$/;
const acc = (key, optional = true) =>
  IDENT.test(key)
    ? `${optional ? "?" : ""}.${key}`
    : `${optional ? "?." : ""}[${JSON.stringify(key)}]`;
const seg = (key) => (typeof key === "number" ? `?.[${key}]` : acc(key));

const layerName = () => $("layer").value.trim() || "dataLayer";
const isSegment = () =>
  ["viewed", "basketed", "purchased"].includes($("type").value);
const isPostClick = () =>
  ["attribution", "conversion"].includes($("type").value);

// path[0] is the entry index when the layer is an array. Segments may map over arrays; scraper fields must stay scalar.
function buildExpr(path, allowMap) {
  const root = `window${acc(layerName(), false)}`;
  if (!state.isArray) return root + path.map(seg).join("");

  const [index, ...rest] = path;
  if (rest.length === 0) return `${root}?.[${index}]`;
  if (typeof rest[0] !== "string")
    return `${root}?.[${index}]${rest.map(seg).join("")}`;

  // Match the entry by key instead of index, since entry order varies between pages.
  const [first, ...tail] = rest;
  const arrayAt = allowMap ? tail.findIndex((k) => typeof k === "number") : -1;
  const head = arrayAt === -1 ? tail : tail.slice(0, arrayAt);
  let expr = `${root}?.find((e) => e${acc(first)})${acc(first)}${head.map(seg).join("")}`;
  if (arrayAt !== -1) {
    const after = tail.slice(arrayAt + 1);
    expr += `?.map((x) => x${after.map(seg).join("")})`;
  }
  return expr;
}

function readPage() {
  const name = JSON.stringify(layerName());
  const code = `(() => {
    const seen = new WeakSet();
    try {
      return JSON.stringify({ url: location.href, layer: window[${name}] === undefined ? null : window[${name}] }, (k, v) => {
        if (typeof v === "function") return "[function]";
        if (v && typeof v === "object") {
          if (v instanceof Node) return "[node]";
          if (seen.has(v)) return "[repeated]";
          seen.add(v);
        }
        return v;
      });
    } catch (e) { return JSON.stringify({ error: String(e) }); }
  })()`;

  chrome.devtools.inspectedWindow.eval(code, (raw, exception) => {
    if (exception || typeof raw !== "string") {
      $("status").textContent = "Cannot read page";
      return;
    }
    if (raw === state.raw) return;
    state.raw = raw;
    const data = JSON.parse(raw);
    if (data.error) {
      $("status").textContent = data.error;
      return;
    }
    if (data.layer === null) {
      $("status").textContent = `window.${layerName()} not found`;
      state.layer = [];
    } else {
      state.isArray = Array.isArray(data.layer);
      state.layer = data.layer;
      $("status").textContent = state.isArray
        ? `${data.layer.length} entries`
        : "object";
    }
    if (data.url !== state.pageUrl) {
      state.pageUrl = data.url;
      savePage(data.url);
      if (!state.urlEdited) $("url").value = patternFromSaved();
      renderSaved();
      renderUrlParts();
    }
    renderTree();
    renderOutput();
  });
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// Pages are matched by top-level section (first path segment), never by product slug.
function describeUrl(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "");
  const segment = u.pathname.split("/").filter(Boolean)[0] ?? "";
  return { host, segment: looksLikePage(segment) ? "" : segment };
}

function savePage(href) {
  const page = describeUrl(href);
  if (!page) return;
  state.host = page.host;
  if (
    page.segment &&
    !state.saved.some((s) => s.host === page.host && s.segment === page.segment)
  ) {
    state.saved.push({ ...page, checked: true });
    persist();
  }
}

const hostPages = () => state.saved.filter((s) => s.host === state.host);

function patternFromSaved() {
  if (!state.host) return "";
  const host = escRe(state.host);
  const segments = hostPages()
    .filter((s) => s.checked)
    .map((s) => escRe(s.segment));
  return segments.length ? `${host}\\/(${segments.join("|")})(?:\\/|$)` : host;
}

function refreshUrl() {
  state.urlEdited = false;
  $("url").value = patternFromSaved();
  renderSaved();
  renderOutput();
}

function renderSaved() {
  const box = $("saved");
  box.replaceChildren();
  for (const page of hostPages()) {
    const row = el("div", "saved-row");
    const check = el("input");
    check.type = "checkbox";
    check.checked = page.checked;
    check.addEventListener("change", () => {
      page.checked = check.checked;
      persist();
      refreshUrl();
    });
    const label = el("label", "mono");
    label.append(check, ` /${page.segment}`);
    const remove = el("button", "", "×");
    remove.addEventListener("click", () => {
      state.saved.splice(state.saved.indexOf(page), 1);
      persist();
      refreshUrl();
    });
    row.append(label, remove);
    box.append(row);
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function pickButton(path) {
  const btn = el("button", "pick", "use");
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    pick(path);
  });
  return btn;
}

function leafRow(label, value, path) {
  const row = el("div", "leaf");
  row.append(
    el("span", "key", `${label}: `),
    el("span", "val", JSON.stringify(value)),
    pickButton(path),
  );
  return row;
}

function renderNode(value, path, label) {
  if (value === null || typeof value !== "object")
    return leafRow(label, value, path);

  const details = el("details");
  const key = JSON.stringify(path);
  const summary = el("summary");
  const count = Array.isArray(value) ? `[${value.length}]` : "{…}";
  summary.append(
    el("span", "key", `${label} `),
    el("span", "", count),
    pickButton(path),
  );
  details.append(summary);

  let filled = false;
  const fill = () => {
    if (filled || !details.open) return;
    filled = true;
    for (const [k, v] of Object.entries(value)) {
      const childKey = Array.isArray(value) ? Number(k) : k;
      details.append(renderNode(v, [...path, childKey], String(k)));
    }
  };
  details.open = state.open.has(key);
  details.addEventListener("toggle", () => {
    if (details.open) state.open.add(key);
    else state.open.delete(key);
    fill();
  });
  fill();
  return details;
}

function flatten(value, path, out) {
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      flatten(v, [...path, Array.isArray(value) ? Number(k) : k], out);
    }
  } else {
    out.push({ path, value });
  }
}

function renderTree() {
  const tree = $("tree");
  tree.replaceChildren();
  const query = $("search").value.trim().toLowerCase();

  if (query) {
    const leaves = [];
    flatten(state.layer, [], leaves);
    leaves
      .filter(({ path, value }) =>
        `${path.join(".")} ${value}`.toLowerCase().includes(query),
      )
      .slice(0, 200)
      .forEach(({ path, value }) =>
        tree.append(leafRow(path.join("."), value, path)),
      );
    return;
  }

  if (!state.isArray) {
    for (const [k, v] of Object.entries(state.layer))
      tree.append(renderNode(v, [k], k));
    return;
  }
  state.layer.forEach((entry, i) => {
    const hint =
      entry && typeof entry === "object"
        ? (entry.event ?? Object.keys(entry)[0] ?? "")
        : "";
    tree.append(renderNode(entry, [i], `[${i}] ${hint}`));
  });
}

function pick(path) {
  const name = [...path].reverse().find((k) => typeof k === "string") ?? "";
  applyExpr(buildExpr(path, isSegment()), name);
}

function applyExpr(expr, name) {
  if (isSegment()) {
    $("sku").value = expr;
  } else if ($("type").value === "scraper") {
    state.rows.push({ name, expr });
    renderRows();
  }
  renderOutput();
}

function renderRows() {
  const container = $("rows");
  container.replaceChildren();
  state.rows.forEach((row, i) => {
    const wrap = el("div", "row");
    const name = el("input");
    name.value = row.name;
    name.placeholder = "product store field";
    name.addEventListener("input", () => {
      row.name = name.value;
      renderOutput();
    });
    const expr = el("input", "mono");
    expr.value = row.expr;
    expr.addEventListener("input", () => {
      row.expr = expr.value;
      renderOutput();
    });
    const remove = el("button", "", "×");
    remove.addEventListener("click", () => {
      state.rows.splice(i, 1);
      renderRows();
      renderOutput();
    });
    wrap.append(name, expr, remove);
    container.append(wrap);
  });
}

// A bare Pixel.helper is a function reference (as in the README); anything else is wrapped.
const asFn = (expr) =>
  !expr
    ? "() => undefined"
    : /^Pixel\.\w+$/.test(expr)
      ? expr
      : `() => ${expr}`;
const asKey = (name) => (IDENT.test(name) ? name : JSON.stringify(name));

const TRIGGER_TYPES = ["basketed", "purchased", "conversion"];
const triggerEnabled = () =>
  TRIGGER_TYPES.includes($("type").value) && $("trigger-on").checked;

// Runs in the inspected page, where $0 is the element selected in the Elements panel.
// mode "scrape" targets a specific content element; otherwise a clickable element shared by many products.
function pageSelectorCandidates(start, mode) {
  const el =
    start && start.nodeType === 1
      ? mode === "scrape"
        ? start
        : start.closest(
            "button, a, [role='button'], input[type='button'], input[type='submit']",
          ) || start
      : null;
  if (!el) return null;

  const tag = el.tagName.toLowerCase();
  const count = (sel) => {
    try {
      return document.querySelectorAll(sel).length;
    } catch (e) {
      return 0;
    }
  };
  const attrValue = (v) => v.replace(/["\\]/g, "\\$&");
  const stableNames = [
    "data-testid",
    "data-test",
    "data-qa",
    "data-cy",
    "data-automation-id",
    "itemprop",
    "property",
    "name",
  ];

  const goodClasses = (node) =>
    [...node.classList].filter(
      (c) => !/\d{3,}|^css-|^sc-|^_|^[a-z]{1,2}-[a-z0-9]{5,}$/i.test(c),
    );
  const classes = goodClasses(el)
    .slice(0, 3)
    .map((c) => "." + CSS.escape(c))
    .join("");
  const stable = stableNames
    .filter((n) => el.hasAttribute(n))
    .map((n) => "[" + n + '="' + attrValue(el.getAttribute(n)) + '"]')
    .join("");
  // Presence-only data attributes match every product, unlike their values.
  const dataAttrs = [...el.attributes]
    .map((a) => a.name)
    .filter((n) => n.startsWith("data-") && !stableNames.includes(n))
    .slice(0, 2)
    .map((n) => "[" + CSS.escape(n) + "]")
    .join("");

  const path = [];
  for (
    let node = el;
    node && node.nodeType === 1 && node !== document.body && path.length < 4;
    node = node.parentElement
  ) {
    const same = [...node.parentNode.children].filter(
      (s) => s.tagName === node.tagName,
    );
    path.unshift(
      node.tagName.toLowerCase() +
        (same.length > 1
          ? ":nth-of-type(" + (same.indexOf(node) + 1) + ")"
          : ""),
    );
  }

  // Nearby parents with a usable id or class give selectors like ".product-name-tag span.product-collection".
  const ancestors = [];
  let hops = 0;
  for (
    let a = el.parentElement;
    a && a !== document.body && hops < 6 && ancestors.length < 3;
    a = a.parentElement, hops++
  ) {
    const firstClass = goodClasses(a)[0];
    const sel =
      a.id && !/\d{3,}/.test(a.id)
        ? "#" + CSS.escape(a.id)
        : firstClass
          ? "." + CSS.escape(firstClass)
          : "";
    if (sel) ancestors.push(sel);
  }
  const ownVariants = [
    classes && tag + classes,
    stable && tag + stable,
    tag,
  ].filter(Boolean);
  const nested = ancestors.flatMap((a) => ownVariants.map((v) => a + " " + v));

  const idSel = el.id && !/\d{3,}/.test(el.id) && "#" + CSS.escape(el.id);
  const byAttrs = [
    stable && tag + stable,
    (classes || dataAttrs) && tag + classes + dataAttrs,
    classes && tag + classes,
    dataAttrs && tag + dataAttrs,
  ];
  const raw =
    mode === "scrape"
      ? [idSel, ...byAttrs, ...nested, path.join(" > ")]
      : [...byAttrs, idSel, ...nested, path.join(" > ")];
  const candidates = [...new Set(raw.filter(Boolean))]
    .filter((sel) => {
      try {
        return el.matches(sel);
      } catch (e) {
        return false;
      }
    })
    .map((selector) => ({ selector, count: count(selector) }));
  if (mode === "scrape")
    candidates.sort(
      (a, b) => (a.count === 1 ? 0 : 1) - (b.count === 1 ? 0 : 1),
    );
  candidates.length = Math.min(candidates.length, 12);
  const attributes = [...el.attributes]
    .filter((a) => a.name !== "class" && a.name !== "style")
    .map((a) => ({ name: a.name, value: a.value.slice(0, 60) }));
  return {
    candidates,
    attributes,
    classSelector:
      [...el.classList].map((c) => "." + CSS.escape(c)).join("") || tag,
  };
}

function readSelected(mode, done, source = "$0") {
  const code = `JSON.stringify((${pageSelectorCandidates})(${source}, ${JSON.stringify(mode)}))`;
  chrome.devtools.inspectedWindow.eval(code, (result, exception) => {
    if (exception || typeof result !== "string")
      return done(null, "Cannot read the selected element");
    const data = JSON.parse(result);
    if (!data || !data.candidates.length)
      return done(
        null,
        "Select the element in the Elements panel first, then try again.",
      );
    done(data);
  });
}

// The list hides itself once a selector is chosen.
function renderCandidates(box, candidates, onChoose) {
  box.replaceChildren(el("div", "hint", "Choose a selector:"));
  for (const { selector, count } of candidates) {
    const row = el("button", "cand");
    row.append(
      el("span", "cand-sel mono", selector),
      el("span", "cand-count", `${count} ${count === 1 ? "match" : "matches"}`),
    );
    row.addEventListener("click", () => {
      box.replaceChildren();
      onChoose(selector);
    });
    box.append(row);
  }
}

const PICK_KEY = "__pixelHelperPick";
const clearPicked = () =>
  chrome.devtools.inspectedWindow.eval(
    `delete window.${HITS_KEY}; delete window.${PICK_KEY}`,
  );

// Runs in the inspected page: hover highlight, click to choose, Esc to cancel. Result is left on window[key].
function pagePicker(key) {
  if (window[key + "Stop"]) window[key + "Stop"]();
  const style = document.createElement("style");
  style.textContent = "* { cursor: crosshair !important; }";
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;z-index:2147483647;pointer-events:none;display:none;border:2px solid #2a7ab8;background:rgba(42,122,184,.25);";
  const tip = document.createElement("div");
  tip.style.cssText =
    "position:fixed;z-index:2147483647;pointer-events:none;display:none;background:#222;color:#fff;font:11px monospace;padding:2px 6px;border-radius:3px;";
  document.documentElement.append(style, box, tip);

  const swallow = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const blocked = [
    "mousedown",
    "mouseup",
    "pointerdown",
    "pointerup",
    "auxclick",
    "contextmenu",
    "dblclick",
  ];
  const move = (e) => {
    const t = e.target;
    if (!t || t.nodeType !== 1) return;
    const r = t.getBoundingClientRect();
    Object.assign(box.style, {
      display: "block",
      left: r.left + "px",
      top: r.top + "px",
      width: r.width + "px",
      height: r.height + "px",
    });
    tip.textContent =
      t.tagName.toLowerCase() +
      (t.id ? "#" + t.id : "") +
      [...t.classList]
        .slice(0, 2)
        .map((c) => "." + c)
        .join("");
    Object.assign(tip.style, {
      display: "block",
      left: Math.max(0, r.left) + "px",
      top: (r.top >= 24 ? r.top - 22 : r.bottom + 2) + "px",
    });
  };
  const stop = () => {
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("click", click, true);
    window.removeEventListener("keydown", keydown, true);
    for (const name of blocked) window.removeEventListener(name, swallow, true);
    style.remove();
    box.remove();
    tip.remove();
    delete window[key + "Stop"];
  };
  const click = (e) => {
    swallow(e);
    const el = e.target;
    stop();
    window[key] = { state: "picked", el };
  };
  const keydown = (e) => {
    if (e.key !== "Escape") return;
    swallow(e);
    stop();
    window[key] = { state: "cancelled" };
  };

  window.addEventListener("mousemove", move, true);
  window.addEventListener("click", click, true);
  window.addEventListener("keydown", keydown, true);
  for (const name of blocked) window.addEventListener(name, swallow, true);
  window[key + "Stop"] = stop;
  window[key] = { state: "picking" };
}

let pickToken = 0;

function selectOnPage(info, onPicked) {
  const run = (code) =>
    new Promise((resolve) =>
      chrome.devtools.inspectedWindow.eval(code, (result) => resolve(result)),
    );
  const token = ++pickToken;
  info.textContent = "Click an element on the page (Esc to cancel)...";
  run(`(${pagePicker})(${JSON.stringify(PICK_KEY)})`).then(async () => {
    for (let i = 0; i < 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (token !== pickToken) return;
      const state = await run(
        `window.${PICK_KEY} ? window.${PICK_KEY}.state : "none"`,
      );
      if (state === "picked") {
        info.textContent = "";
        onPicked(`window.${PICK_KEY}.el`);
        return;
      }
      if (state !== "picking") {
        info.textContent = "";
        return;
      }
    }
    info.textContent = "Selection timed out";
    run(`window.${PICK_KEY}Stop && window.${PICK_KEY}Stop()`);
  });
}

function pickTrigger(source = "$0") {
  const info = $("trigger-count");
  readSelected(
    "trigger",
    (data, error) => {
      if (source !== "$0") clearPicked();
      if (!data) {
        info.textContent = error;
        return;
      }
      info.textContent = "";
      setTriggerSelector(data.classSelector);
      renderCandidates(
        $("trigger-candidates"),
        data.candidates,
        setTriggerSelector,
      );
    },
    source,
  );
}

// Runs in the inspected page: finds elements whose text or attribute values contain the query.
function pageSearch(query, key) {
  const q = query.toLowerCase();
  const skip = ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"];
  const found = [];
  for (const node of document.querySelectorAll("*")) {
    if (skip.includes(node.tagName)) continue;
    const own = [...node.childNodes]
      .filter((c) => c.nodeType === 3)
      .map((c) => c.nodeValue)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    let where = null;
    let snippet = "";
    if (own.toLowerCase().includes(q)) {
      where = "text";
      snippet = own;
    } else {
      const attr = [...node.attributes].find(
        (a) =>
          a.name !== "class" &&
          a.name !== "style" &&
          a.value.toLowerCase().includes(q),
      );
      if (attr) {
        where = attr.name;
        snippet = attr.value;
      }
    }
    if (where) found.push({ node, where, snippet });
  }
  const shown = found.slice(0, 50);
  window[key] = shown.map((f) => f.node);
  return {
    total: found.length,
    results: shown.map((f, index) => ({
      index,
      where: f.where,
      snippet: f.snippet.slice(0, 100),
      label:
        f.node.tagName.toLowerCase() +
        (f.node.id ? "#" + f.node.id : "") +
        [...f.node.classList]
          .slice(0, 2)
          .map((c) => "." + c)
          .join(""),
    })),
  };
}

const HITS_KEY = "__pixelHelperHits";

function searchDom() {
  const box = $("dom-results");
  const query = $("dom-search").value.trim();
  if (query.length < 2) {
    box.replaceChildren();
    return;
  }
  const code = `JSON.stringify((${pageSearch})(${JSON.stringify(query)}, ${JSON.stringify(HITS_KEY)}))`;
  chrome.devtools.inspectedWindow.eval(code, (result, exception) => {
    if (exception || typeof result !== "string") {
      box.replaceChildren(el("div", "hint", "Search failed"));
      return;
    }
    const { total, results } = JSON.parse(result);
    const summary = total
      ? `${total} element(s) found${total > results.length ? `, showing ${results.length}` : ""}. Click one to use it:`
      : "No matches";
    box.replaceChildren(el("div", "hint", summary));
    for (const hit of results) {
      const row = el("button", "hit");
      const head = el("div", "hit-head");
      head.append(
        el("span", "cand-sel mono", hit.label),
        el("span", "cand-count", hit.where),
      );
      row.append(head, el("div", "hit-snippet", hit.snippet));
      row.addEventListener("click", () => {
        box.replaceChildren();
        pickDom(
          `window.${HITS_KEY}[${hit.index}]`,
          hit.where === "text" ? "innerText" : `attr:${hit.where}`,
        );
      });
      box.append(row);
    }
  });
}

function pickDom(source = "$0", preferred = "") {
  const info = $("dom-status");
  readSelected(
    "scrape",
    (data, error) => {
      if (source !== "$0") clearPicked();
      if (!data) {
        info.textContent = error;
        return;
      }
      info.textContent = "";
      const sources = [
        ["innerText", "Text (innerText)"],
        ["textContent", "textContent"],
        ...data.attributes.map((a) => [
          `attr:${a.name}`,
          `${a.name} = ${a.value}`,
        ]),
      ];
      $("dom-source").replaceChildren(
        ...sources.map(([value, label]) => {
          const option = el("option", "", label);
          option.value = value;
          return option;
        }),
      );
      if (preferred) $("dom-source").value = preferred;
      $("dom-selector").value = data.classSelector;
      $("dom-selected").classList.remove("hidden");
      updateDomPreview();
      renderCandidates($("dom-candidates"), data.candidates, (selector) => {
        $("dom-selector").value = selector;
        $("dom-selected").classList.remove("hidden");
        updateDomPreview();
      });
    },
    source,
  );
}

function domExpression() {
  const selector = JSON.stringify($("dom-selector").value.trim());
  const [kind, ...rest] = $("dom-source").value.split(":");
  const access =
    kind === "attr"
      ? `.getAttribute(${JSON.stringify(rest.join(":"))})`
      : `.${kind}`;
  if (isSegment() && $("dom-all").checked)
    return `[...document.querySelectorAll(${selector})].map((e) => e${access})`;
  return `document.querySelector(${selector})?${access}`;
}

function updateDomPreview() {
  const selector = $("dom-selector").value.trim();
  highlight("dom", $("source").value === "dom" ? selector : "");
  if (!selector) {
    $("dom-count").textContent = "";
    $("dom-preview").textContent = "";
    return;
  }
  const code = `JSON.stringify((() => {
    try { return { count: document.querySelectorAll(${JSON.stringify(selector)}).length, value: ${domExpression()} }; }
    catch (e) { return { error: e.message }; }
  })())`;
  chrome.devtools.inspectedWindow.eval(code, (result, exception) => {
    if (exception || typeof result !== "string") {
      $("dom-preview").textContent = "Cannot evaluate";
      return;
    }
    const r = JSON.parse(result);
    $("dom-count").textContent = r.error
      ? "Invalid selector"
      : `Matches ${r.count} element(s) on this page`;
    $("dom-preview").textContent = r.error
      ? r.error
      : r.value === undefined
        ? "(empty)"
        : JSON.stringify(r.value);
  });
}

function addDomValue() {
  const [kind, ...rest] = $("dom-source").value.split(":");
  applyExpr(
    domExpression(),
    kind === "attr" ? rest.join(":").replace(/^data-/, "") : "",
  );
  $("dom-status").textContent = appliedMessage();
}

function appliedMessage() {
  if (isSegment()) return "Set as the SKU expression";
  return $("type").value === "scraper"
    ? "Added as a scrape field"
    : "This pixel type has no scrape value";
}

const FENCE = "```";
const PROMPT_LIMIT = 20000;
const PIXEL_RULES = [
  "# Library rules",
  "- new Pixel({ advertiser, type, url, ... }) with type one of: scraper, viewed, basketed, purchased, attribution, conversion.",
  "- scraper: scrape is an object whose keys match the advertiser's product store field names; each value is a function returning a string, number or boolean (never an array). A sku field is required.",
  "- viewed / basketed / purchased: scrape is a function returning the SKU string, or an array of SKUs.",
  "- attribution / conversion: need a label (the same on both) and no scrape. Attribution runs on the landing page (reads the ccpid query parameter), conversion on the conversion page.",
  "- url is a RegExp matched against the page URL; the pixel only runs where it matches.",
  '- Optional trigger: { event: "click", elements: "css selector" } runs the pixel on that DOM event instead of on scrape changes; scrape then receives the element.',
  "- Optional: optional: [field names allowed to be empty], before(data, callback) and after(data) hooks.",
  "- Scrape functions are re-run continuously: use optional chaining and avoid generated class names.",
  "- Source priority for every value: 1) dataLayer or other window data, 2) the URL (Pixel.getPathSegment / Pixel.getQueryParameter), 3) the DOM (document.querySelector). Use the highest-priority source that reliably holds the value on every page the url pattern matches. Fall back to a lower source only when a higher one does not have the value; a fallback chain such as a ?? b is fine when both sources give the same format.",
  "- DOM selectors must be built from the tags, ids, classes and attributes listed in the DOM section of the prompt. Never guess class names or data attributes; if a value is not listed, leave that field out instead of inventing a selector.",
  "- A trigger must target the clickable element (button or link) from the Clickable elements list whose text matches the request, and must not match other buttons.",
  "- Helpers: Pixel.getUrl(), Pixel.getPathSegment(i) (zero-based, empty segments skipped), Pixel.getQueryParameter(key), Pixel.getAllPathSegments(), Pixel.getAllQueryParameters().",
  "- A SKU must identify the product and be identical every time that product is viewed. Do not build it from volatile values such as dates, times, session or search parameters unless the request says so.",
].join("\n");

function trimLayer(budget) {
  const entries = state.isArray ? state.layer : [state.layer];
  const lines = [];
  let used = 0;
  let shown = 0;
  for (const entry of entries) {
    const text = JSON.stringify(entry) ?? "";
    if (used + text.length > budget) {
      if (!shown) lines.push(`${text.slice(0, budget)}... (truncated)`);
      break;
    }
    lines.push(text);
    used += text.length;
    shown++;
  }
  if (entries.length > shown)
    lines.push(`... ${entries.length - shown} more entries not shown`);
  return lines.join("\n");
}

function buildPrompt(dataBudget, extra = "") {
  const goal =
    $("ai-goal").value.trim() ||
    "Create the right pixel for this page from the data below, following the source priority.";
  const parts = urlParts(state.pageUrl)
    .slice(0, 12)
    .map((p) => `- ${p.label}: ${p.value}  (use: ${p.expr})`)
    .join("\n");
  const seen = hostPages()
    .map((s) => `/${s.segment}${s.checked ? "" : " (not selected)"}`)
    .join(", ");
  const hasLayer = state.isArray
    ? state.layer.length > 0
    : Object.keys(state.layer ?? {}).length > 0;
  const selector = $("dom-selector").value.trim();
  const sources = [
    "# Data sources, in priority order",
    "## 1. dataLayer",
    hasLayer
      ? `window.${layerName()} (${state.isArray ? "array, one entry per line" : "object"}):\n${FENCE}json\n${trimLayer(dataBudget)}\n${FENCE}`
      : `No data was found at window.${layerName()}.`,
    `## 2. URL\n${parts}`,
    `## 3. DOM\nElements visible on the page right now. Build selectors only from these tags, ids, classes and attributes.\n${state.domOutline || "(the DOM could not be read)"}${selector ? `\nElement chosen in the panel: ${selector} (current value: ${$("dom-preview").textContent || "unknown"})` : ""}`,
  ].join("\n");

  const events = (state.lastEvents ?? [])
    .filter((e) => e.level !== "info")
    .slice(0, 8);
  const lastTest = events.length
    ? `\n\n# Last test result\n${events.map((e) => `${e.level.toUpperCase()}: ${e.message}${e.data == null ? "" : ` ${JSON.stringify(e.data).slice(0, 300)}`}`).join("\n")}`
    : "";

  return [
    "You are helping me write a Choreograph Create pixel with the npm package choreograph-create-pixel for the website below.",
    `# Request\n${goal}`,
    PIXEL_RULES,
    `# Page\nURL: ${state.pageUrl}\nURL pattern currently in the panel: /${$("url").value}/\nSections seen on this site: ${seen || "none"}\nAdvertiser ID: ${Number($("advertiser").value) || 0} (keep 0 as a placeholder if it is 0)`,
    sources,
    `# Current draft in the panel\n${FENCE}json\n${JSON.stringify(pixelDraft(), null, 2)}\n${FENCE}${lastTest}`,
    extra,
    OUTPUT_SPEC,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const PIXEL_TYPES = [
  "scraper",
  "viewed",
  "basketed",
  "purchased",
  "attribution",
  "conversion",
];

const OUTPUT_SPEC = [
  "# Output",
  "Reply with only one JSON object: no prose and no code fences. Shape:",
  '{"pixels":[{"type":"viewed","url":"<regex source, no slashes>","label":"<attribution/conversion only>","trigger":{"elements":"<css selector>"},"scrape":"<see below>"}]}',
  "- One object per pixel (for example a viewed pixel and a basketed pixel). Keep values from the current draft when they are already right.",
  '- "trigger" only when the pixel should fire on a click (the event is always click); otherwise omit it.',
  '- scraper: "scrape" is an object mapping product store field names to JS expressions, with at least a sku field. viewed/basketed/purchased: "scrape" is one JS expression returning the SKU string (or an array of SKUs). attribution/conversion: omit "scrape".',
  "- JS expressions are plain expressions evaluated on the page, not functions, and must not rely on an element argument. Use optional chaining, for example window.dataLayer?.find((e) => e?.product)?.product?.sku",
  "- Pixel.getPathSegment(i), Pixel.getQueryParameter(key) and the other helpers can be used inside expressions.",
].join("\n");

// Same shape as the reply Copilot is asked for, so a draft and a suggestion are interchangeable.
function pixelDraft() {
  const type = $("type").value;
  const draft = { type, url: $("url").value };
  if (isPostClick()) draft.label = $("label").value;
  if (triggerEnabled())
    draft.trigger = { elements: $("trigger-elements").value.trim() };
  if (isSegment()) draft.scrape = $("sku").value.trim();
  else if (type === "scraper")
    draft.scrape = Object.fromEntries(
      state.rows.filter((r) => r.name).map((r) => [r.name, r.expr.trim()]),
    );
  return draft;
}

// The page data shrinks first when the prompt is over the limit.
function renderPrompt(extra = "") {
  let budget = 8000;
  let prompt = buildPrompt(budget, extra);
  while (prompt.length > PROMPT_LIMIT && budget > 200) {
    budget = Math.floor(budget / 2);
    prompt = buildPrompt(budget, extra);
  }
  $("ai-preview").value = prompt;
  $("ai-length").textContent = `${prompt.length} characters`;
  return prompt;
}

const BRIDGE_KEY = "pixel-helper:bridge";
const bridge = (() => {
  try {
    return {
      port: 47821,
      token: "",
      ...JSON.parse(localStorage.getItem(BRIDGE_KEY)),
    };
  } catch {
    return { port: 47821, token: "" };
  }
})();
const saveBridge = () =>
  localStorage.setItem(BRIDGE_KEY, JSON.stringify(bridge));

async function bridgeFetch(path, options = {}) {
  if (!bridge.token)
    throw new Error("Paste the bridge token under Connection first.");
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${bridge.port}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error(
      `Cannot reach the bridge on port ${bridge.port}. Is VS Code running with the Pixel Helper Bridge extension?`,
    );
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Bridge error ${response.status}`);
  }
  return response;
}

async function checkBridge() {
  const out = $("bridge-status");
  out.textContent = "Checking...";
  try {
    const { models } = await (await bridgeFetch("/health")).json();
    out.textContent = models.length
      ? `Connected. Models: ${models.map((m) => m.name).join(", ")}`
      : "Connected, but no Copilot models are available. Sign in to GitHub Copilot, then run Pixel Helper: Authorize Copilot in VS Code.";
  } catch (error) {
    out.textContent = error.message;
  }
}

// The bridge streams one JSON message per line: {chunk}, {done} or {error}.
async function readStream(response, onText) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.error) throw new Error(message.error);
      if (message.chunk) {
        text += message.chunk;
        onText(text);
      }
    }
  }
  return text;
}

function parseReply(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const data = JSON.parse(
    fenced
      ? fenced[1]
      : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
  );
  const pixels = (Array.isArray(data.pixels) ? data.pixels : [data]).filter(
    (p) => p && PIXEL_TYPES.includes(p.type),
  );
  if (!pixels.length) throw new Error("The reply had no valid pixels");
  return pixels;
}

function loadSuggestion(pixel) {
  $("type").value = pixel.type;
  if (typeof pixel.label === "string") $("label").value = pixel.label;
  if (typeof pixel.url === "string") {
    $("url").value = pixel.url.replace(/^\/|\/$/g, "");
    state.urlEdited = true;
  }
  $("trigger-on").checked = Boolean(pixel.trigger && pixel.trigger.elements);
  $("trigger-elements").value =
    pixel.trigger && pixel.trigger.elements
      ? String(pixel.trigger.elements)
      : "";
  if (isSegment())
    $("sku").value = typeof pixel.scrape === "string" ? pixel.scrape : "";
  const fields =
    pixel.scrape &&
    typeof pixel.scrape === "object" &&
    !Array.isArray(pixel.scrape)
      ? pixel.scrape
      : {};
  state.rows =
    pixel.type === "scraper"
      ? Object.entries(fields).map(([name, expr]) => ({
          name,
          expr: String(expr),
        }))
      : [];
  renderRows();
  syncTypeVisibility();
}

function showTab(id) {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.tab === id);
    $(tab.dataset.tab).classList.toggle("hidden", tab.dataset.tab !== id);
  }
  if (id === "tab-ai") {
    renderPrompt();
    refreshDomOutline().then(() => renderPrompt());
  }
}

// Runs in the inspected page: clickable elements with their text first, then other visible text (prices and numbers first).
function pageDomOutline(maxLines, maxChars) {
  const skip = [
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "SVG",
    "IFRAME",
    "HEAD",
    "OPTION",
  ];
  const hints = [
    "data-testid",
    "data-test",
    "data-qa",
    "data-cy",
    "itemprop",
    "name",
    "aria-label",
  ];
  const describe = (el, maxClasses = 3) => {
    let text = el.tagName.toLowerCase();
    if (el.id && !/\d{3,}/.test(el.id)) text += "#" + el.id;
    text += [...el.classList]
      .filter((c) => !/\d{3,}|^css-|^sc-|^_/i.test(c))
      .slice(0, maxClasses)
      .map((c) => "." + c)
      .join("");
    for (const name of hints)
      if (el.hasAttribute(name))
        text += "[" + name + '="' + el.getAttribute(name).slice(0, 40) + '"]';
    return text;
  };
  const normalize = (text) => text.replace(/\s+/g, " ").trim();
  const seen = new Set();

  const clickable = [];
  const buttons = document.querySelectorAll(
    "button, a[href], [role='button'], input[type='button'], input[type='submit']",
  );
  for (let i = 0; i < buttons.length && i < 3000; i++) {
    const el = buttons[i];
    if (!el.getClientRects().length) continue;
    const text = normalize(
      el.innerText || el.textContent || el.value || "",
    ).slice(0, 60);
    if (!text) continue;
    const line = (describe(el, 4) + ' "' + text + '"').slice(0, 220);
    if (seen.has(line)) continue;
    seen.add(line);
    clickable.push({
      i,
      line,
      score: /add|basket|bag|cart|buy|checkout|book|select|continue|pay/i.test(
        text,
      )
        ? 1
        : 0,
    });
  }
  clickable.sort((a, b) => b.score - a.score || a.i - b.i);

  const items = [];
  const all = document.body ? document.body.querySelectorAll("*") : [];
  for (let i = 0; i < all.length && i < 8000; i++) {
    const el = all[i];
    if (skip.includes(el.tagName.toUpperCase()) || !el.getClientRects().length)
      continue;
    const own = normalize(
      [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.nodeValue)
        .join(" "),
    );
    if (!own || own.length > 80) continue;
    const parent =
      el.parentElement && el.parentElement !== document.body
        ? describe(el.parentElement) + " > "
        : "";
    const line = (parent + describe(el) + ' "' + own + '"').slice(0, 200);
    if (seen.has(line)) continue;
    seen.add(line);
    const score = /[£$€]\s?\d|\d[.,]\d{2}/.test(own)
      ? 2
      : /\d/.test(own)
        ? 1
        : 0;
    items.push({ i, line, score });
  }
  items.sort((a, b) => b.score - a.score || a.i - b.i);
  const text = items
    .slice(0, maxLines)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.line)
    .join("\n");
  const output =
    'Clickable elements, as: selector "visible text":\n' +
    clickable
      .slice(0, 50)
      .map((x) => x.line)
      .join("\n") +
    '\n\nOther text on the page, as: parent > element "own text":\n' +
    text;
  return output.length > maxChars ? output.slice(0, maxChars) : output;
}

function refreshDomOutline(maxLines = 120, maxChars = 6000) {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(
      `(${pageDomOutline})(${maxLines}, ${maxChars})`,
      (result) => {
        state.domOutline = typeof result === "string" ? result : "";
        resolve();
      },
    );
  });
}

async function runExpression(expr) {
  const lib = await getLib();
  const code = `(() => {
    try {
      const Pixel = (() => { ${lib}
      return ChoreographCreatePixel; })();
      const value = (${expr}
      );
      return JSON.stringify({ value: value === undefined ? null : value });
    } catch (e) { return JSON.stringify({ error: e.message }); }
  })()`;
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(code, (result, exception) => {
      if (exception)
        return resolve({
          error:
            exception.value ||
            exception.description ||
            "could not be evaluated",
        });
      try {
        resolve(JSON.parse(result));
      } catch {
        resolve({ error: "could not be evaluated" });
      }
    });
  });
}

// Runs what Copilot wrote on the real page, so invented selectors show up as empty values.
async function findProblems(pixels) {
  const problems = [];
  for (const [index, pixel] of pixels.entries()) {
    const add = (field, issue, expr = "") =>
      problems.push({ pixel: index, field, expr, issue });
    if (typeof pixel.url === "string") {
      try {
        if (!new RegExp(pixel.url.replace(/^\/|\/$/g, "")).test(state.pageUrl))
          add("url", "does not match the current page URL", pixel.url);
      } catch {
        add("url", "is not a valid regex", pixel.url);
      }
    }
    const selector = pixel.trigger && pixel.trigger.elements;
    if (selector) {
      const found = await runExpression(
        `[...document.querySelectorAll(${JSON.stringify(String(selector))})].map((e) => (e.innerText || e.textContent || e.value || "").replace(/\\s+/g, " ").trim().slice(0, 60))`,
      );
      const named = [
        ...$("ai-goal").value.matchAll(/["“”]([^"“”]{2,40})["“”]/g),
      ].map((m) => m[1].toLowerCase());
      if (found.error)
        add(
          "trigger.elements",
          `is not a valid selector (${found.error})`,
          selector,
        );
      else if (!found.value.length)
        add("trigger.elements", "matches no element on the page", selector);
      else if (
        named.length &&
        !found.value.some((text) =>
          named.some((n) => text.toLowerCase().includes(n)),
        )
      ) {
        add(
          "trigger.elements",
          `matches elements with the text ${JSON.stringify(found.value.slice(0, 5))}, but the request names ${named.map((n) => JSON.stringify(n)).join(" or ")}`,
          selector,
        );
      }
    }
    const fields =
      pixel.type === "scraper"
        ? pixel.scrape
        : ["viewed", "basketed", "purchased"].includes(pixel.type)
          ? { sku: pixel.scrape }
          : {};
    for (const [field, expr] of Object.entries(
      fields && typeof fields === "object" ? fields : {},
    )) {
      if (typeof expr !== "string" || !expr.trim()) {
        add(field, "has no expression");
        continue;
      }
      const { value, error } = await runExpression(expr);
      if (error) add(field, `threw: ${error}`, expr);
      else if (
        value === null ||
        (typeof value === "string" && !value.trim()) ||
        (Array.isArray(value) && !value.length)
      )
        add(field, "returned nothing", expr);
      else if (Array.isArray(value) && pixel.type === "scraper")
        add(
          field,
          "returned an array; scraper fields must be a single value",
          expr,
        );
    }
  }
  return problems;
}

function problemsText(reply, problems) {
  const list = problems
    .map(
      (p) =>
        `- pixel ${p.pixel + 1}, ${p.field}${p.expr ? ` (${p.expr})` : ""}: ${p.issue}`,
    )
    .join("\n");
  return [
    `# Your previous reply\n${reply}`,
    `# Problems found when running it on the real page\n${list}`,
    "Fix these. Use only selectors that match elements in the DOM section above, which was just refreshed; do not guess. If a value cannot be found there, leave the field out. Reply with the full corrected JSON in the same shape.",
  ].join("\n\n");
}

function loadedMessage(problems) {
  if (!problems.length)
    return {
      level: "success",
      message:
        "Loaded from Copilot. Every expression returned a value on this page. Press Test pixel to run it.",
    };
  return {
    level: "warn",
    message:
      "Loaded from Copilot, but some parts did not work on this page. Fix them by hand or ask Copilot again.",
    data: problems.map(
      (p) => `${p.field}${p.expr ? ` (${p.expr})` : ""}: ${p.issue}`,
    ),
  };
}

function showSuggestions(pixels, problems = []) {
  const box = $("ai-suggestions");
  box.replaceChildren();
  if (pixels.length === 1) {
    loadSuggestion(pixels[0]);
    showTab("tab-pixel");
    showResult([loadedMessage(problems)]);
    return;
  }
  $("ai-status").textContent =
    `Copilot suggested ${pixels.length} pixels. Pick one to load it into the panel.`;
  pixels.forEach((pixel, index) => {
    const bad = problems.filter((p) => p.pixel === index);
    const row = el("button", "cand");
    row.append(
      el("span", "cand-sel mono", pixel.type),
      el(
        "span",
        "part-value mono",
        `${bad.length ? `${bad.length} problem(s) · ` : ""}${pixel.url ?? ""}`,
      ),
    );
    row.addEventListener("click", () => {
      loadSuggestion(pixel);
      showTab("tab-pixel");
      showResult([loadedMessage(bad)]);
    });
    box.append(row);
  });
}

let aiAbort;
const MAX_FIXES = 2;

async function buildWithCopilot() {
  if (aiAbort) {
    aiAbort.abort();
    return;
  }
  const status = $("ai-status");
  const stream = $("ai-stream");
  aiAbort = new AbortController();
  $("ai-build").textContent = "Cancel";
  stream.textContent = "";
  $("ai-suggestions").replaceChildren();
  const ask = async (prompt) => {
    const response = await bridgeFetch("/generate", {
      method: "POST",
      body: JSON.stringify({ prompt }),
      signal: aiAbort.signal,
    });
    return readStream(response, (partial) => {
      stream.textContent = partial;
    });
  };
  try {
    status.textContent = "Reading the page...";
    await refreshDomOutline();
    status.textContent = "Copilot is working in VS Code...";
    let reply = await ask(renderPrompt());
    let pixels;
    try {
      pixels = parseReply(reply);
    } catch (error) {
      status.textContent = `Could not read Copilot's reply: ${error.message}. The raw reply is below.`;
      return;
    }
    let problems = [];
    for (let attempt = 0; ; attempt++) {
      status.textContent = "Checking the result against the page...";
      problems = await findProblems(pixels);
      if (!problems.length || attempt === MAX_FIXES) break;
      status.textContent = `${problems.length} problem(s) found on the page. Asking Copilot to fix them (${attempt + 1} of ${MAX_FIXES})...`;
      await refreshDomOutline(300, 12000);
      const fixed = await ask(renderPrompt(problemsText(reply, problems)));
      try {
        pixels = parseReply(fixed);
        reply = fixed;
      } catch {
        break;
      }
    }
    stream.textContent = "";
    status.textContent = "Done.";
    showSuggestions(pixels, problems);
  } catch (error) {
    status.textContent =
      error.name === "AbortError" ? "Cancelled." : error.message;
  } finally {
    aiAbort = undefined;
    $("ai-build").textContent = "Build with Copilot";
  }
}

async function copyPrompt() {
  await navigator.clipboard.writeText(renderPrompt());
  $("ai-status").textContent = "Prompt copied to the clipboard.";
}

// Runs in the inspected page: custom globals (absent from a blank iframe's window) and a deep key/value search.
function pageWindow(query) {
  const frame = document.createElement("iframe");
  frame.style.display = "none";
  document.documentElement.append(frame);
  const native = new Set(
    frame.contentWindow ? Object.getOwnPropertyNames(frame.contentWindow) : [],
  );
  frame.remove();

  const names = Object.getOwnPropertyNames(window).filter(
    (n) => !native.has(n) && !/^__pixelHelper|^\d+$/.test(n),
  );
  const likely =
    /data|layer|digital|utag|tealium|track|analytics|product|page|user|store|config|state/i;
  const isNode = (v) =>
    v instanceof Node ||
    v === window ||
    v.window === v ||
    ArrayBuffer.isView(v);

  const globals = [];
  for (const name of names) {
    let v;
    try {
      v = window[name];
    } catch (e) {
      continue;
    }
    if (v === null || typeof v !== "object" || isNode(v)) continue;
    globals.push({
      name,
      kind: Array.isArray(v)
        ? "Array(" + v.length + ")"
        : "Object(" + Object.keys(v).length + ")",
    });
  }
  globals.sort(
    (a, b) =>
      likely.test(b.name) - likely.test(a.name) || a.name.localeCompare(b.name),
  );

  const results = [];
  if (query) {
    const q = query.toLowerCase();
    const seen = new WeakSet();
    let visited = 0;
    const walk = (value, path) => {
      if (results.length >= 100 || visited > 30000 || value == null) return;
      const t = typeof value;
      if (t === "function" || t === "symbol") return;
      if (t !== "object") {
        if (String(value).toLowerCase().includes(q))
          results.push({
            path,
            where: "value",
            value: String(value).slice(0, 100),
          });
        return;
      }
      if (isNode(value) || seen.has(value) || path.length > 7) return;
      seen.add(value);
      visited++;
      let keys;
      try {
        keys = Object.keys(value);
      } catch (e) {
        return;
      }
      const isArray = Array.isArray(value);
      for (const key of keys.slice(0, 200)) {
        let child;
        try {
          child = value[key];
        } catch (e) {
          continue;
        }
        consider(
          child,
          path.concat(isArray ? Number(key) : key),
          isArray ? null : key,
        );
      }
    };
    const consider = (child, path, key) => {
      const isPrimitive = (v) =>
        v !== null && typeof v !== "object" && typeof v !== "function";
      if (key && key.toLowerCase().includes(q)) {
        if (isPrimitive(child)) {
          results.push({
            path,
            where: "key",
            value: String(child).slice(0, 100),
          });
          return;
        }
        if (Array.isArray(child) && child.length && isPrimitive(child[0])) {
          results.push({
            path: path.concat(0),
            where: "key",
            value: String(child[0]).slice(0, 100),
          });
          return;
        }
      }
      walk(child, path);
    };
    for (const name of names) {
      let v;
      try {
        v = window[name];
      } catch (e) {
        continue;
      }
      consider(v, [name], name);
    }
  }
  return {
    globals: globals.slice(0, 150),
    results,
    truncated: results.length >= 100,
  };
}

const formatPath = (path) =>
  path
    .map((k, i) => (typeof k === "number" ? `[${k}]` : i ? `.${k}` : k))
    .join("");

function windowExpr(path, allowMap) {
  const [name, ...rest] = path;
  const arrayAt = allowMap ? rest.findIndex((k) => typeof k === "number") : -1;
  const head = arrayAt === -1 ? rest : rest.slice(0, arrayAt);
  let expr = `window${acc(name, false)}${head.map(seg).join("")}`;
  if (arrayAt !== -1)
    expr += `?.map((x) => x${rest
      .slice(arrayAt + 1)
      .map(seg)
      .join("")})`;
  return expr;
}

function refreshWindow() {
  const query = $("window-search").value.trim();
  const code = `JSON.stringify((${pageWindow})(${JSON.stringify(query.length >= 2 ? query : "")}))`;
  chrome.devtools.inspectedWindow.eval(code, (result, exception) => {
    if (exception || typeof result !== "string") {
      $("window-status").textContent = "Cannot read the page";
      return;
    }
    const data = JSON.parse(result);
    renderWindowGlobals(data.globals);
    renderWindowResults(query, data);
  });
}

function renderWindowGlobals(globals) {
  const box = $("window-globals");
  box.replaceChildren();
  if (!globals.length)
    box.append(el("div", "hint", "No custom object globals found."));
  for (const { name, kind } of globals) {
    const row = el("button", "cand");
    row.append(
      el("span", "cand-sel mono", name),
      el("span", "cand-count", kind),
    );
    row.addEventListener("click", () => {
      $("layer").value = name;
      $("source").value = "datalayer";
      syncSource();
      state.raw = "";
      readPage();
    });
    box.append(row);
  }
}

function renderWindowResults(query, data) {
  const box = $("window-results");
  box.replaceChildren();
  if (query.length < 2) return;
  const { results, truncated } = data;
  box.append(
    el(
      "div",
      "hint",
      results.length
        ? `${results.length}${truncated ? "+" : ""} match(es). Click one to use it:`
        : "No matches",
    ),
  );
  for (const hit of results) {
    const row = el("button", "hit");
    const head = el("div", "hit-head");
    head.append(
      el("span", "cand-sel mono", formatPath(hit.path)),
      el("span", "cand-count", hit.where),
    );
    row.append(head, el("div", "hit-snippet", hit.value));
    row.addEventListener("click", () => {
      applyExpr(
        windowExpr(hit.path, isSegment()),
        [...hit.path].reverse().find((k) => typeof k === "string") ?? "",
      );
      $("window-status").textContent = appliedMessage();
    });
    box.append(row);
  }
}

function urlParts(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return [];
  }
  const decode = (s) => {
    try {
      return decodeURI(s);
    } catch {
      return s;
    }
  };
  const parts = [
    { label: "Host", value: u.hostname, expr: "location.hostname" },
  ];
  u.pathname
    .split("/")
    .filter(Boolean)
    .forEach((segment, i) => {
      parts.push({
        label: `Path ${i + 1}`,
        value: decode(segment),
        expr: `Pixel.getPathSegment(${i})`,
      });
    });
  for (const [key, value] of u.searchParams) {
    parts.push({
      label: `Query ${key}`,
      value,
      expr: `Pixel.getQueryParameter(${JSON.stringify(key)})`,
      hint: key,
    });
  }
  if (u.hash.length > 1)
    parts.push({
      label: "Hash",
      value: u.hash.slice(1),
      expr: 'location.hash.replace(/^#/, "")',
    });
  parts.push({
    label: "Full path",
    value: u.pathname,
    expr: "location.pathname",
  });
  parts.push({
    label: "Clean URL",
    value: `${u.origin}${u.pathname}`,
    expr: "Pixel.getUrl()",
  });
  return parts;
}

function renderUrlParts() {
  const box = $("url-parts");
  box.replaceChildren();
  for (const part of urlParts(state.pageUrl)) {
    const row = el("button", "cand");
    row.append(
      el("span", "cand-sel mono", part.label),
      el("span", "part-value mono", part.value),
    );
    row.addEventListener("click", () => {
      state.urlItems.push({
        label: part.label,
        base: part.expr,
        hint: part.hint ?? "",
        delimiter: "",
        piece: 0,
        regex: "",
      });
      renderUrlItems();
      updateUrlPreview();
    });
    box.append(row);
  }
}

function renderUrlItems() {
  const box = $("url-items");
  box.replaceChildren();
  if (!state.urlItems.length)
    box.append(el("div", "hint", "Click a URL part above to add it."));
  state.urlItems.forEach((item, i) => {
    const row = el("div", "url-item");
    const title = el("div", "url-item-title");
    const up = el("button", "", "\u2191");
    up.title = "Move up";
    up.disabled = i === 0;
    up.addEventListener("click", () => {
      [state.urlItems[i - 1], state.urlItems[i]] = [
        state.urlItems[i],
        state.urlItems[i - 1],
      ];
      renderUrlItems();
      updateUrlPreview();
    });
    const remove = el("button", "", "\u00d7");
    remove.title = "Remove";
    remove.addEventListener("click", () => {
      state.urlItems.splice(i, 1);
      renderUrlItems();
      updateUrlPreview();
    });
    title.append(el("strong", "", item.label), up, remove);

    const field = (placeholder, key, title, type = "text") => {
      const input = el("input", "mono");
      input.type = type;
      input.placeholder = placeholder;
      input.title = title;
      input.value = item[key];
      input.addEventListener("input", () => {
        item[key] = input.value;
        updateUrlPreview();
      });
      return input;
    };
    const controls = el("div", "url-item-controls");
    controls.append(
      field(
        "split by",
        "delimiter",
        "Split the value on this separator, e.g. - or .",
      ),
      field(
        "piece",
        "piece",
        "Which piece to keep: 0 is the first, -1 the last",
        "number",
      ),
      field(
        "regex (optional)",
        "regex",
        "Applied last; the first capture group is used if there is one",
      ),
    );
    row.append(title, controls);
    box.append(row);
  });
}

function urlItemExpr(item) {
  let expr = item.base;
  if (item.delimiter) {
    const n = Number(item.piece) || 0;
    const split = `${expr}?.split(${JSON.stringify(item.delimiter)})`;
    expr = n < 0 ? `${split}.slice(${n})[0]` : `${split}[${n}]`;
  }
  if (item.regex) {
    const hasGroup = /\((?!\?)/.test(item.regex);
    expr = `${expr}?.match(/${item.regex.replace(/(?<!\\)\//g, "\\/")}/)?.[${hasGroup ? 1 : 0}]`;
  }
  return expr;
}

// Several parts are joined, and the result is undefined if any part is empty so the library flags it.
function urlExpression() {
  const exprs = state.urlItems.map(urlItemExpr);
  if (exprs.length <= 1) return exprs[0] ?? "";
  return `((p) => p.every(Boolean) ? p.join(${JSON.stringify($("url-sep").value)}) : undefined)([${exprs.join(", ")}])`;
}

let urlPreviewToken = 0;

async function updateUrlPreview() {
  const out = $("url-preview");
  const token = ++urlPreviewToken;
  const expr = urlExpression();
  if (!expr) {
    out.textContent = "";
    return;
  }
  const badRegex = state.urlItems.some((item) => {
    try {
      if (item.regex) new RegExp(item.regex);
      return false;
    } catch {
      return true;
    }
  });
  if (badRegex) {
    out.textContent = "Invalid regex";
    return;
  }
  let lib;
  try {
    lib = await getLib();
  } catch (e) {
    out.textContent = `Cannot load library: ${e}`;
    return;
  }
  const code = `JSON.stringify((() => {
    try {
      const Pixel = (() => { ${lib}
      return ChoreographCreatePixel; })();
      return { value: ${expr} };
    } catch (e) { return { error: e.message }; }
  })())`;
  chrome.devtools.inspectedWindow.eval(code, (result, exception) => {
    if (token !== urlPreviewToken) return;
    if (exception || typeof result !== "string") {
      out.textContent = "Cannot evaluate";
      return;
    }
    const r = JSON.parse(result);
    out.textContent = r.error
      ? r.error
      : r.value === undefined
        ? "(empty)"
        : JSON.stringify(r.value);
  });
}

function addUrlValue() {
  const first = state.urlItems[0];
  applyExpr(
    urlExpression(),
    state.urlItems.length === 1 && first.hint ? first.hint : "",
  );
  $("url-status").textContent = !state.urlItems.length
    ? "Add at least one URL part first"
    : appliedMessage();
}

function syncSource() {
  const source = $("source").value;
  $("tree-pane").classList.toggle("hidden", source !== "datalayer");
  $("dom-pane").classList.toggle("hidden", source !== "dom");
  $("url-pane").classList.toggle("hidden", source !== "url");
  $("window-pane").classList.toggle("hidden", source !== "window");
  for (const node of document.querySelectorAll(".dl"))
    node.classList.toggle("hidden", source !== "datalayer");
  $("sku").placeholder = {
    datalayer: "Click a value in the tree",
    dom: "Use the DOM picker on the left",
    url: "Use the URL builder on the left",
    window: "Use the window search on the left",
  }[source];
  if (source === "window") refreshWindow();
  if (source === "url") {
    renderUrlParts();
    renderUrlItems();
    updateUrlPreview();
  }
  updateDomPreview();
}

function setTriggerSelector(selector) {
  $("trigger-elements").value = selector;
  renderOutput();
  updateTriggerCount();
}

// A style rule avoids touching the page's DOM attributes; invalid selectors are skipped.
function highlight(name, selector) {
  const code = `(() => {
    const id = "__pixelHelperHl_${name}";
    const old = document.getElementById(id);
    if (old) old.remove();
    const sel = ${JSON.stringify(selector)};
    if (!sel || !CSS.supports("selector(" + sel + ")")) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = sel + " { outline: 2px solid rgba(46, 160, 80, 0.7) !important; outline-offset: 1px !important; }";
    (document.head || document.documentElement).append(style);
  })()`;
  chrome.devtools.inspectedWindow.eval(code);
}

function updateTriggerCount() {
  const info = $("trigger-count");
  const selector = $("trigger-elements").value.trim();
  highlight("trigger", triggerEnabled() ? selector : "");
  if (!selector) {
    info.textContent = "";
    return;
  }
  const code = `(() => { try { return document.querySelectorAll(${JSON.stringify(selector)}).length; } catch (e) { return -1; } })()`;
  chrome.devtools.inspectedWindow.eval(code, (n) => {
    info.textContent =
      n === -1 ? "Invalid selector" : `Matches ${n} element(s) on this page`;
  });
}

function configSource({ debug = false } = {}) {
  const type = $("type").value;
  const lines = [
    "{",
    `  advertiser: ${Number($("advertiser").value) || 0},`,
    `  type: ${JSON.stringify(type)},`,
  ];
  if (debug) lines.push("  debug: true,");
  if (isPostClick())
    lines.push(`  label: ${JSON.stringify($("label").value)},`);
  lines.push(`  url: /${$("url").value || "(?:)"}/,`);
  if (triggerEnabled()) {
    lines.push(
      "  trigger: {",
      '    event: "click",',
      `    elements: ${JSON.stringify($("trigger-elements").value.trim())},`,
      "  },",
    );
  }
  if (isSegment()) {
    lines.push(`  scrape: ${asFn($("sku").value.trim())},`);
  } else if (type === "scraper") {
    lines.push("  scrape: {");
    for (const row of state.rows.filter((r) => r.name)) {
      lines.push(`    ${asKey(row.name)}: ${asFn(row.expr.trim())},`);
    }
    lines.push("  },");
  }
  lines.push("}");
  return lines.join("\n");
}

function generate() {
  return `import Pixel from "choreograph-create-pixel";\n\nnew Pixel(${configSource()});\n`;
}

const LIB_PATH = "lib/choreograph-create-pixel.iife.min.js";

let libCache;
const getLib = async () =>
  (libCache ??= await (await fetch(chrome.runtime.getURL(LIB_PATH))).text());

async function loadLib() {
  try {
    return await getLib();
  } catch (e) {
    showMessage(`Cannot load library: ${e}`, "error");
    return null;
  }
}

const PAGE_REPLACER =
  '(k, v) => typeof v === "function" ? "[function]" : v instanceof RegExp ? String(v) : v';
const LIVE_KEY = "__pixelHelperLive";

// Unmodified library with debug on: this sends real requests, exactly like loading with ?pixel_debug.
async function runTest() {
  const trigger = triggerEnabled();
  showMessage(
    trigger
      ? "Waiting for a click on the trigger element (up to 30s)..."
      : "Sending...",
  );
  const lib = await loadLib();
  if (!lib) return;

  const evalInPage = (code) =>
    new Promise((resolve) =>
      chrome.devtools.inspectedWindow.eval(code, (result, exception) =>
        resolve({ result, exception }),
      ),
    );

  // The library marks trigger elements and never removes its listeners, so test instances expire.
  const start = await evalInPage(`(() => {
    const Base = (() => { ${lib}
    return ChoreographCreatePixel; })();
    const attr = ${JSON.stringify(`create-${$("type").value}-click`)};
    document.querySelectorAll("[" + attr + "]").forEach((e) => e.removeAttribute(attr));
    const store = window.${LIVE_KEY} = { events: [], instance: null };
    const deadline = Date.now() + ${trigger ? 35000 : 10000};
    const expired = (self) => self._dead || Date.now() > deadline;
    const Pixel = class extends Base {
      cycle() { if (this._ran) return; this._ran = true; super.cycle(); }
      log(level, message, data) { store.events.push({ level, message, data }); }
      scrape(element) { if (!expired(this)) super.scrape(element); }
      convert() { if (!expired(this)) super.convert(); }
    };
    try { store.instance = new Pixel(${configSource({ debug: true })}); } catch (e) { store.events.push({ level: "error", message: String(e) }); }
  })()`);
  if (start.exception) {
    showMessage(
      `Error: ${start.exception.value || start.exception.description || start.exception.code}`,
      "error",
    );
    return;
  }

  let events = [];
  for (let i = 0; i < (trigger ? 100 : 14); i++) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { result } = await evalInPage(
      `JSON.stringify(window.${LIVE_KEY} ? window.${LIVE_KEY}.events : [], ${PAGE_REPLACER})`,
    );
    events = result ? JSON.parse(result) : [];
    if (events.length || !trigger) showResult(events);
    if (
      events.some(
        (e) =>
          e.level === "error" ||
          e.level === "success" ||
          /^Successful/.test(e.message),
      )
    )
      break;
  }
  await evalInPage(
    `(() => { const s = window.${LIVE_KEY}; if (s && s.instance) s.instance._dead = true; delete window.${LIVE_KEY}; })()`,
  );
}

function showResult(events) {
  state.lastEvents = events;
  const out = $("test-result");
  out.replaceChildren();
  const rows = events.length
    ? events
    : [
        {
          level: "info",
          message: "No output. The pixel did not run; check the URL pattern.",
        },
      ];
  for (const e of rows) {
    const row = el("div", `result ${e.level}`);
    const head = el("div", "result-head");
    head.append(el("span", "badge", e.level), el("span", "", e.message));
    row.append(head);
    if (e.data != null)
      row.append(el("pre", "result-data", JSON.stringify(e.data, null, 2)));
    out.append(row);
  }
}

const showMessage = (message, level = "info") =>
  showResult([{ level, message }]);

function renderOutput() {
  $("output").value = generate();
}

function syncTypeVisibility() {
  $("label-field").classList.toggle("hidden", !isPostClick());
  $("scrape-segment").classList.toggle("hidden", !isSegment());
  $("scrape-scraper").classList.toggle("hidden", $("type").value !== "scraper");
  $("trigger-section").classList.toggle(
    "hidden",
    !TRIGGER_TYPES.includes($("type").value),
  );
  $("trigger-fields").classList.toggle("hidden", !$("trigger-on").checked);
  $("dom-all-label").classList.toggle("hidden", !isSegment());
  updateTriggerCount();
  renderOutput();
}

$("type").addEventListener("change", () => {
  if ($("type").value === "basketed") $("trigger-on").checked = true;
  syncTypeVisibility();
});
$("trigger-on").addEventListener("change", syncTypeVisibility);
$("pick-trigger").addEventListener("click", () => pickTrigger());
$("select-trigger").addEventListener("click", () =>
  selectOnPage($("trigger-count"), (source) => pickTrigger(source)),
);
$("select-dom").addEventListener("click", () =>
  selectOnPage($("dom-status"), (source) => pickDom(source)),
);
$("source").addEventListener("change", syncSource);
$("url-sep").addEventListener("input", updateUrlPreview);
$("url-add").addEventListener("click", addUrlValue);
let windowTimer;
$("window-search").addEventListener("input", () => {
  clearTimeout(windowTimer);
  windowTimer = setTimeout(refreshWindow, 300);
});
$("window-rescan").addEventListener("click", refreshWindow);
$("pick-dom").addEventListener("click", () => pickDom());
let domSearchTimer;
$("dom-search").addEventListener("input", () => {
  clearTimeout(domSearchTimer);
  domSearchTimer = setTimeout(searchDom, 300);
});
$("dom-add").addEventListener("click", addDomValue);
$("dom-source").addEventListener("change", updateDomPreview);
$("dom-all").addEventListener("change", () => {
  renderOutput();
  updateDomPreview();
});
let domTimer;
$("dom-selector").addEventListener("input", () => {
  clearTimeout(domTimer);
  domTimer = setTimeout(updateDomPreview, 300);
});
let triggerTimer;
$("trigger-elements").addEventListener("input", () => {
  renderOutput();
  clearTimeout(triggerTimer);
  triggerTimer = setTimeout(updateTriggerCount, 300);
});
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
}
for (const id of ["advertiser", "label", "sku"])
  $(id).addEventListener("input", renderOutput);
$("url").addEventListener("input", () => {
  state.urlEdited = true;
  renderOutput();
});
$("search").addEventListener("input", renderTree);
$("layer").addEventListener("change", () => {
  state.raw = "";
  readPage();
});
$("refresh").addEventListener("click", () => {
  state.raw = "";
  readPage();
});
$("add-row").addEventListener("click", () => {
  state.rows.push({ name: "", expr: "" });
  renderRows();
});
$("copy").addEventListener("click", () =>
  navigator.clipboard.writeText($("output").value),
);
$("ai-goal").addEventListener("input", () => renderPrompt());
$("ai-build").addEventListener("click", buildWithCopilot);
$("bridge-check").addEventListener("click", checkBridge);
$("bridge-port").value = bridge.port;
$("bridge-token").value = bridge.token;
$("bridge-port").addEventListener("input", () => {
  bridge.port = Number($("bridge-port").value) || 47821;
  saveBridge();
});
$("bridge-token").addEventListener("input", () => {
  bridge.token = $("bridge-token").value.trim();
  saveBridge();
});
$("ai-copy").addEventListener("click", copyPrompt);
$("test").addEventListener("click", runTest);
$("clear-saved").addEventListener("click", () => {
  state.saved = state.saved.filter((s) => s.host !== state.host);
  persist();
  refreshUrl();
});

chrome.devtools.network.onNavigated.addListener(() => {
  state.open.clear();
  state.urlEdited = false;
  state.raw = "";
  readPage();
});

syncTypeVisibility();
syncSource();
readPage();
setInterval(readPage, 1500);
