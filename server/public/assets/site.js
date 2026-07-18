/* NimbusCore demo site — shared shell
 * -----------------------------------
 * Renders the site header/nav (with REAL hrefs so the scraper can crawl every
 * subpage), keeps a cart count in localStorage so it survives page navigations,
 * and exposes a tiny toast helper. Each page just drops in:
 *   <div id="site-header"></div>
 *   <script src="/assets/site.js"></script>
 * and sets `window.PAGE` to its own key to light up the active nav link. */
(function () {
  "use strict";

  // Real, crawlable link tree. Every entry is a genuine <a href> — that's what
  // lets scraper/scrape.js discover the whole site and lets the agent navigate.
  const NAV = [
    { key: "home", label: "Home", href: "/" },
    {
      key: "services", label: "Services", href: "/services.html",
      children: [
        {
          key: "cloud", label: "Cloud", href: "/cloud.html",
          children: [
            { label: "Enterprise Compute", href: "/cloud.html?type=enterprise" },
            { label: "Hybrid Compute", href: "/cloud.html?type=hybrid" },
            { label: "Edge Nodes", href: "/cloud.html?type=edge" },
          ],
        },
        { key: "telecom", label: "Telecom", href: "/telecom.html" },
        { key: "storage", label: "Storage", href: "/storage.html" },
      ],
    },
    {
      key: "solutions", label: "Solutions", href: "/solutions.html",
      children: [
        { label: "Finance", href: "/solutions.html#finance" },
        { label: "Healthcare", href: "/solutions.html#healthcare" },
        { label: "Government", href: "/solutions.html#government" },
      ],
    },
    { key: "pricing", label: "Pricing", href: "/pricing.html" },
    { key: "configure", label: "Configure", href: "/configure.html" },
    {
      key: "support", label: "Support", href: "/support.html",
      children: [
        { label: "Docs", href: "/support.html#docs" },
        { label: "Contact Support", href: "/contact.html" },
        { label: "System Status", href: "/status.html" },
      ],
    },
  ];

  const current = window.PAGE || "";

  // Each item with children gets its OWN caret <button>, separate from the <a>.
  // The <a> always navigates to that item's real overview page; the caret's only
  // job is to toggle the submenu open on click — no more relying on CSS :hover,
  // which made the submenu impossible to actually reach with a click.
  // depth 0 = top bar (opens downward, "▾"); depth 1+ = a flyout nested inside
  // another dropdown (opens to the right, "▸", e.g. Cloud's own submenu).
  function renderList(items, depth = 0) {
    return (
      "<ul>" +
      items
        .map((it) => {
          const isCurrent = it.key && it.key === current ? ' class="current"' : "";
          const hasChildren = !!it.children;
          const glyph = depth === 0 ? "▾" : "▸";
          const caret = hasChildren
            ? `<button type="button" class="nav-caret" aria-label="Toggle ${escapeHtml(it.label)} menu" aria-expanded="false">${glyph}</button>`
            : "";
          const sub = hasChildren ? renderList(it.children, depth + 1) : "";
          const liClass = hasChildren ? ' class="has-children"' : "";
          return `<li${liClass}><a href="${it.href}"${isCurrent}>${it.label}</a>${caret}${sub}</li>`;
        })
        .join("") +
      "</ul>"
    );
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function openDropdown(li) {
    clearTimeout(closeTimers.get(li));
    closeTimers.delete(li);
    // Keep any ANCESTOR dropdown open (so hovering into "Cloud" doesn't close
    // "Services"); close everything else that isn't this li itself.
    document.querySelectorAll("nav li.open").forEach((open) => {
      if (open === li || open.contains(li)) return;
      closeDropdown(open);
    });
    li.classList.add("open");
    const btn = li.querySelector(":scope > .nav-caret");
    if (btn) btn.setAttribute("aria-expanded", "true");
  }

  function closeDropdown(li) {
    clearTimeout(closeTimers.get(li));
    closeTimers.delete(li);
    li.classList.remove("open");
    const btn = li.querySelector(":scope > .nav-caret");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function closeAllDropdowns() {
    document.querySelectorAll("nav li.open").forEach(closeDropdown);
  }

  // Hover-intent: closing is delayed and gets cancelled the instant the pointer
  // re-enters any part of the same li (label, caret, or the submenu itself) —
  // so moving the mouse from the trigger down into the menu never loses it,
  // even during the brief gap where the cursor is over neither.
  const closeTimers = new Map();
  const CLOSE_DELAY_MS = 350;

  function renderHeader() {
    const host = document.getElementById("site-header");
    if (!host) return;
    host.outerHTML = `
      <header>
        <div class="bar">
          <a class="brand" href="/">☁ NimbusCore</a>
          <nav>${renderList(NAV)}</nav>
          <span class="cart"><a href="/cart.html">🛒 Cart: <b id="cart-count">0</b></a></span>
        </div>
      </header>`;
    updateCartBadge();
  }

  // Delegated (via document) so this keeps working after renderHeader() replaces
  // the header markup — mouseover/mouseout bubble, unlike mouseenter/mouseleave,
  // which is what makes delegation possible here.
  document.addEventListener("mouseover", (e) => {
    const li = e.target.closest("li.has-children");
    if (!li || li.contains(e.relatedTarget)) return; // still inside the same li
    openDropdown(li);
  });
  document.addEventListener("mouseout", (e) => {
    const li = e.target.closest("li.has-children");
    if (!li || li.contains(e.relatedTarget)) return; // moved to a descendant, not away
    const timer = setTimeout(() => closeDropdown(li), CLOSE_DELAY_MS);
    closeTimers.set(li, timer);
  });

  document.addEventListener("click", (e) => {
    const caret = e.target.closest(".nav-caret");
    if (caret) {
      e.preventDefault();
      e.stopPropagation();
      const li = caret.closest("li");
      li.classList.contains("open") ? closeDropdown(li) : openDropdown(li);
      return;
    }
    if (!e.target.closest("nav")) closeAllDropdowns();
  });

  // ---- cart (persisted across pages) ----
  function getCart() {
    try { return JSON.parse(localStorage.getItem("nimbus.cart") || "[]"); }
    catch { return []; }
  }
  function setCart(items) {
    localStorage.setItem("nimbus.cart", JSON.stringify(items));
    updateCartBadge();
  }
  function updateCartBadge() {
    const b = document.getElementById("cart-count");
    if (b) b.textContent = String(getCart().length);
  }

  function toast(msg) {
    let t = document.getElementById("toast");
    if (!t) {
      t = document.createElement("div");
      t.className = "toast";
      t.id = "toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => t.classList.remove("show"), 1800);
  }

  // Expose a tiny API for page scripts.
  window.Nimbus = {
    getCart,
    setCart,
    addToCart(item) {
      const items = getCart();
      items.push(item);
      setCart(items);
      toast("Added " + (item.name || "item") + " to cart");
    },
    toast,
    updateCartBadge,
  };

  // ---- hash-target highlight ----
  // Nav dropdown items like Solutions > Finance or Support > Docs link to an
  // in-page #id. Jumping there via the bare browser anchor is easy to miss, so
  // draw a blue box around the target section (like the widget's highlight
  // action) for a couple seconds after landing.
  function highlightHashTarget() {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.remove("nimbus-highlight");
    void target.offsetWidth; // restart the animation if the same target is re-hit
    target.classList.add("nimbus-highlight");
    clearTimeout(target._nimbusHighlightTimer);
    target._nimbusHighlightTimer = setTimeout(
      () => target.classList.remove("nimbus-highlight"),
      3200
    );
  }
  window.addEventListener("hashchange", highlightHashTarget);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      renderHeader();
      highlightHashTarget();
    });
  } else {
    renderHeader();
    highlightHashTarget();
  }
})();
