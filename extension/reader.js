/* Runs in Chrome's isolated content-script world, never in the page's world. */
(() => {
  function parse(text) {
    if (typeof text !== "string" || text.length > 150 || text.includes("%"))
      throw Error(
        "Select only the balance number, without percentages or other amounts.",
      );
    if (/[()]/.test(text))
      throw Error("Select a signed amount without parentheses.");
    text = text.replace(/[$€£]/g, "");
    const matches = text.match(/[-−]?\s*(?:\d[\d,.]*\d|\d)/g);
    if (matches?.length !== 1) throw Error("Select one number only.");
    const raw = matches[0].replace(/\s/g, "").replace("−", "-");
    if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw))
      throw Error(
        "Use a balance formatted as 1,234.56. Other number formats are not supported yet.",
      );
    const value = raw.replaceAll(",", "");
    if (!Number.isFinite(Number(value))) throw Error("Invalid balance.");
    if (
      /[kKmMbB]\b/.test(
        text.slice(text.indexOf(matches[0]) + matches[0].length).trim(),
      )
    )
      throw Error("Select the full amount, not an abbreviated value.");
    return value;
  }
  function fingerprint(el) {
    return (el.parentElement?.innerText || "")
      .replace(/[-−]?\d[\d,.]*/g, "#")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400);
  }
  function selector(el) {
    const parts = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n.id) {
        const s = "#" + CSS.escape(n.id);
        if (document.querySelectorAll(s).length === 1) {
          parts.unshift(s);
          break;
        }
      }
      const test = n.getAttribute("data-testid");
      if (test) {
        const s = `[data-testid="${CSS.escape(test)}"]`;
        if (document.querySelectorAll(s).length === 1) {
          parts.unshift(s);
          break;
        }
      }
      let index = 1;
      for (
        let prev = n.previousElementSibling;
        prev;
        prev = prev.previousElementSibling
      )
        if (prev.tagName === n.tagName) index++;
      parts.unshift(`${n.tagName.toLowerCase()}:nth-of-type(${index})`);
    }
    return parts.join(" > ");
  }
  function extract(config) {
    const matches = document.querySelectorAll(config.selector);
    if (matches.length !== 1)
      throw Error("Balance location changed. Select it again.");
    const el = matches[0];
    if (
      !el.getClientRects().length ||
      getComputedStyle(el).visibility === "hidden"
    )
      throw Error("Balance is not visible. Sign in and retry.");
    if (fingerprint(el) !== config.fingerprint)
      throw Error("Billing page changed. Select the balance again.");
    return parse(el.innerText);
  }
  function pick(config) {
    if (globalThis.__creditCleanup) globalThis.__creditCleanup();
    const host = document.createElement("div");
    host.id = "credit-tracker-picker";
    host.style.cssText =
      "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML =
      '<style>:host{all:initial}section{font:14px system-ui;background:#16213d;color:white;border-radius:12px;padding:18px 22px;box-shadow:0 10px 50px #0005;max-width:440px}p{line-height:1.5;margin:0 0 12px}button{font:600 12px system-ui;border:0;border-radius:6px;padding:9px 12px;margin-right:8px;cursor:pointer;background:#e7edff;color:#16213d}strong{font-size:24px}small{display:block;line-height:1.5;color:#ced7ed;margin:10px 0}</style><section><p id="message"></p><div id="actions"></div></section>';
    document.documentElement.append(host);
    const message = shadow.querySelector("#message"),
      actions = shadow.querySelector("#actions");
    let hovered, oldOutline, selected;
    function button(label, fn) {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = fn;
      actions.append(b);
      return b;
    }
    function clearOutline() {
      if (hovered) {
        hovered.style.outline = oldOutline;
        hovered = null;
      }
    }
    function cleanup() {
      clearOutline();
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      host.remove();
      delete globalThis.__creditCleanup;
    }
    function start() {
      selected = null;
      message.textContent = `Click the ${config.kind === "spend" ? "spend" : "balance"} number for ${config.name}. Press Escape to cancel.`;
      actions.replaceChildren();
      button("Cancel", cleanup);
    }
    function over(e) {
      if (selected || e.composedPath().includes(host)) return;
      clearOutline();
      hovered = e.target;
      oldOutline = hovered.style.outline;
      hovered.style.outline = "2px solid #284edc";
    }
    function key(e) {
      if (e.key === "Escape") cleanup();
    }
    function click(e) {
      if (e.composedPath().includes(host) || selected) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      clearOutline();
      try {
        const el = e.target,
          value = parse(el.innerText);
        selected = {
          provider: config.id,
          url: location.href,
          selector: selector(el),
          fingerprint: fingerprint(el),
          value,
        };
        message.replaceChildren();
        const title = document.createElement("span");
        title.textContent = `Track ${config.name}: `;
        const amount = document.createElement("strong");
        amount.textContent = `${value} ${config.unit}`;
        message.append(title, amount);
        const hint = document.createElement("small");
        hint.textContent = `${config.label}. Confirm this is the correct account and amount.`;
        message.append(hint);
        actions.replaceChildren();
        button("Use this balance", async () => {
          actions
            .querySelectorAll("button")
            .forEach((b) => (b.disabled = true));
          const response = await chrome.runtime.sendMessage({
            type: "capture",
            capture: selected,
          });
          if (response?.error) {
            message.textContent = response.error;
            actions.replaceChildren();
            button("Try again", start);
            button("Cancel", cleanup);
          } else {
            message.textContent =
              "Balance saved. Your dashboard is up to date.";
            actions.replaceChildren();
            button("Done", cleanup);
          }
        });
        button("Choose another", start);
        button("Cancel", cleanup);
      } catch (err) {
        message.textContent = err.message;
      }
    }
    document.addEventListener("pointerover", over, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    globalThis.__creditCleanup = cleanup;
    start();
  }
  globalThis.CreditReader = { parse, fingerprint, selector, extract, pick };
})();
