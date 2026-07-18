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
      key: "services", label: "Services ▾", href: "/services.html",
      children: [
        {
          key: "cloud", label: "Cloud ▾", href: "/cloud.html",
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
      key: "solutions", label: "Solutions ▾", href: "/solutions.html",
      children: [
        { label: "Finance", href: "/solutions.html#finance" },
        { label: "Healthcare", href: "/solutions.html#healthcare" },
        { label: "Government", href: "/solutions.html#government" },
      ],
    },
    { key: "pricing", label: "Pricing", href: "/pricing.html" },
    { key: "configure", label: "Configure", href: "/configure.html" },
    {
      key: "support", label: "Support ▾", href: "/support.html",
      children: [
        { label: "Docs", href: "/support.html#docs" },
        { label: "Contact Support", href: "/contact.html" },
        { label: "System Status", href: "/status.html" },
      ],
    },
  ];

  const current = window.PAGE || "";

  function renderList(items) {
    return (
      "<ul>" +
      items
        .map((it) => {
          const isCurrent = it.key && it.key === current ? ' class="current"' : "";
          const sub = it.children ? renderList(it.children) : "";
          return `<li><a href="${it.href}"${isCurrent}>${it.label}</a>${sub}</li>`;
        })
        .join("") +
      "</ul>"
    );
  }

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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderHeader);
  } else {
    renderHeader();
  }
})();
