"use strict";

const STATUS_LABEL = {
  new: "Новый",
  work: "В работе",
  done: "Готов",
  cancelled: "Отменён",
};
const FILTERS = [
  ["all", "Все"],
  ["new", "Новые"],
  ["work", "В работе"],
  ["done", "Готовые"],
  ["cancelled", "Отменённые"],
];
const STEPS = [
  ["01", "Регистрация", "Клиент создаёт аккаунт. Самый первый аккаунт — владелец."],
  ["02", "Заказ", "Клиент пишет, что нужно сделать."],
  ["03", "Переписка", "Вы отвечаете прямо в заказе и меняете статус."],
];

const state = {
  me: null,
  meta: { needsOwner: true, localUrl: "", lanUrl: null },
  view: "auth",
  authTab: "login",
  orders: [],
  filter: "all",
  query: "",
  order: null,
  messages: [],
  banner: "",
  preserveBanner: false,
  loading: false,
  poll: null,
  polling: false,
};

let routeGen = 0;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "value" || key === "selected" || key === "checked" || key === "disabled") node[key] = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clip(text, limit = 140) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return flat.slice(0, limit - 1) + "…";
}

function formatTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function api(path, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const error = new Error("Нет связи с сервером");
    error.status = 0;
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Ошибка");
    error.status = response.status;
    throw error;
  }
  return data;
}

function showBanner(text) {
  state.banner = text || "";
  const existing = document.querySelector("[data-banner]");
  if (!state.banner) {
    if (existing) existing.remove();
    return;
  }
  const box = existing || el("div", { class: "alert", role: "alert", "data-banner": "1" });
  box.textContent = state.banner;
  if (!existing) {
    const host = document.querySelector("form") || document.querySelector(".screen") || document.querySelector("#app");
    host.prepend(box);
  }
}

function bannerNode() {
  if (!state.banner) return null;
  return el("div", { class: "alert", role: "alert", "data-banner": "1", text: state.banner });
}

function setHash(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function parseRoute() {
  const raw = location.hash.replace(/^#/, "");
  if (raw === "/register") return { name: "auth", tab: "register" };
  if (raw === "/login" || raw === "") return { name: "auth", tab: "login" };
  if (raw === "/orders/new") return { name: "create" };
  const match = /^\/orders\/(\d+)$/.exec(raw);
  if (match) return { name: "order", id: Number(match[1]) };
  if (raw === "/orders") return { name: "list" };
  return { name: "list" };
}

function stopPoll() {
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
}

function startPoll() {
  stopPoll();
  state.poll = setInterval(poll, 3000);
}

function appendMessages(list, force) {
  if (!list || !list.length) return;
  const seen = new Set(state.messages.map((message) => message.id));
  let added = false;
  for (const message of list) {
    if (!seen.has(message.id)) {
      state.messages.push(message);
      seen.add(message.id);
      added = true;
    }
  }
  if (!added) return;
  state.messages.sort((a, b) => a.id - b.id);
  paintMessages(force);
}

async function poll() {
  if (state.polling || !state.me) return;
  if (state.view === "order" && state.order) await pollOrder();
  else if (state.view === "list" && !state.loading) await pollList();
}

async function pollOrder() {
  state.polling = true;
  const id = state.order.id;
  const after = state.messages.reduce((max, message) => Math.max(max, message.id), 0);
  try {
    const data = await api(`/api/orders/${id}?after=${after}`);
    if (!state.order || state.order.id !== id) return;
    const statusChanged = data.order.status !== state.order.status;
    state.order = data.order;
    if (statusChanged) paintStatus();
    appendMessages(data.messages, false);
  } catch (error) {
    if (error.status === 401) {
      state.me = null;
      location.replace("#/login");
    }
  } finally {
    state.polling = false;
  }
}

async function pollList() {
  state.polling = true;
  try {
    const data = await api("/api/orders");
    if (state.view !== "list") return;
    state.orders = data.orders;
    paintCards();
  } catch (error) {
    if (error.status === 401) {
      state.me = null;
      location.replace("#/login");
    }
  } finally {
    state.polling = false;
  }
}

async function boot() {
  try {
    state.meta = await api("/api/meta");
  } catch {
    document.querySelector("#app").replaceChildren(
      el("p", { class: "booting", text: "Не удалось подключиться. Запустите сервер и обновите страницу." })
    );
    return;
  }
  try {
    state.me = (await api("/api/me")).user;
  } catch {
    state.me = null;
  }
  await route();
}

async function route() {
  const gen = ++routeGen;
  stopPoll();
  if (state.preserveBanner) state.preserveBanner = false;
  else state.banner = "";
  const current = parseRoute();

  if (!state.me) {
    state.authTab = state.meta.needsOwner ? "register" : (current.tab === "register" ? "register" : "login");
    state.view = "auth";
    const wanted = state.meta.needsOwner ? "#/register" : (current.tab === "register" ? "#/register" : "#/login");
    if (location.hash !== wanted) {
      location.replace(wanted);
      return;
    }
    render();
    return;
  }

  if (current.name === "auth" || location.hash === "" || location.hash === "#") {
    location.replace("#/orders");
    return;
  }
  if (current.name === "create") {
    if (state.me.role !== "client") {
      location.replace("#/orders");
      return;
    }
    state.view = "create";
    render();
    return;
  }
  if (current.name === "order") {
    try {
      const data = await api(`/api/orders/${current.id}`);
      if (gen !== routeGen) return;
      state.order = data.order;
      state.messages = data.messages;
      state.view = "order";
      render();
      startPoll();
    } catch (error) {
      if (gen !== routeGen) return;
      if (error.status === 401) {
        state.me = null;
        location.replace("#/login");
        return;
      }
      state.banner = error.message || "Заказ не найден";
      state.preserveBanner = true;
      location.replace("#/orders");
    }
    return;
  }

  state.view = "list";
  state.loading = true;
  render();
  try {
    state.orders = (await api("/api/orders")).orders;
    if (gen !== routeGen) return;
  } catch (error) {
    if (gen !== routeGen) return;
    if (error.status === 401) {
      state.me = null;
      location.replace("#/login");
      return;
    }
    state.banner = error.message;
  }
  state.loading = false;
  if (gen !== routeGen) return;
  state.view = "list";
  render();
  startPoll();
}

function titleFor() {
  if (state.view === "auth") {
    if (state.meta.needsOwner) return "Создать кабинет — Заказы";
    return state.authTab === "register" ? "Регистрация — Заказы" : "Вход — Заказы";
  }
  if (state.view === "create") return "Новый заказ — Заказы";
  if (state.view === "order" && state.order) return state.order.title + " — Заказы";
  return "Заказы";
}

function render() {
  document.title = titleFor();
  if (state.view === "auth") renderAuth();
  else if (state.view === "list") renderList();
  else if (state.view === "create") renderCreate();
  else if (state.view === "order") renderOrder();
}

function renderAuth() {
  const ownerSetup = state.meta.needsOwner;
  const tab = ownerSetup ? "register" : state.authTab;
  const registering = tab === "register";
  const form = el("form", { novalidate: true, onsubmit: submitAuth }, [
    bannerNode(),
    registering ? field("Имя", "name", "text", "name") : null,
    field("Почта", "email", "email", registering ? "email" : "username"),
    field("Пароль", "password", "password", registering ? "new-password" : "current-password"),
    registering ? field("Пароль ещё раз", "password2", "password", "new-password") : null,
    el("button", {
      class: "btn primary",
      type: "submit",
      text: ownerSetup ? "Создать кабинет" : (registering ? "Зарегистрироваться" : "Войти"),
    }),
    el("p", {
      class: "hint",
      text: ownerSetup
        ? "Этот аккаунт будет владельцем. Клиенты зарегистрируются отдельно."
        : (registering
          ? "После регистрации можно создать заказ и написать владельцу."
          : "Заказы и переписка хранятся на компьютере, где запущен сайт."),
    }),
  ]);
  const card = el("div", { class: "auth-card" }, [
    ownerSetup ? null : el("div", { class: "tabs" }, [
      el("a", { href: "#/login", class: tab === "login" ? "active" : "", text: "Вход" }),
      el("a", { href: "#/register", class: tab === "register" ? "active" : "", text: "Регистрация" }),
    ]),
    el("h1", { text: ownerSetup ? "Создать кабинет" : (registering ? "Регистрация" : "Вход") }),
    el("p", {
      class: "lede form-note",
      text: ownerSetup
        ? "Сначала аккаунт владельца. Потом клиенты смогут регистрироваться сами."
        : (registering ? "Аккаунт клиента. Заказы видите только вы и владелец." : "Войдите, чтобы открыть свои заказы."),
    }),
    form,
  ]);
  const side = el("aside", { class: "auth-side" }, [
    el("div", {}, [
      el("div", { class: "brand" }, [
        el("span", { class: "mark", "aria-hidden": "true" }),
        el("span", { text: "Заказы" }),
      ]),
      el("p", { class: "eyebrow", text: "Кабинет" }),
      el("h1", { text: "Заказы и переписка" }),
      el("p", {
        class: "lede",
        text: ownerSetup
          ? "Сначала создайте аккаунт владельца. Потом по ссылке зайдут клиенты."
          : "Клиент оставляет заказ и пишет вам. Вы отвечаете в том же заказе.",
      }),
    ]),
    el("div", {}, [
      el("ol", { class: "steps" }, STEPS.map(([num, title, text]) => (
        el("li", { class: "step" }, [
          el("span", { class: "num", text: num }),
          el("div", {}, [
            el("strong", { text: title }),
            el("span", { text }),
          ]),
        ])
      ))),
      el("p", { class: "side-note", text: "Переписка хранится на этом компьютере." }),
    ]),
  ]);
  document.querySelector("#app").replaceChildren(el("div", { class: "auth" }, [side, el("main", { class: "auth-main" }, [card])]));
  document.querySelector("form input")?.focus();
}

function field(label, name, type, autocomplete) {
  const input = el("input", {
    name,
    type,
    autocomplete,
    maxlength: type === "email" ? "200" : (name === "name" ? "80" : "200"),
  });
  if (type === "email") {
    input.setAttribute("inputmode", "email");
    input.setAttribute("autocapitalize", "none");
    input.spellcheck = false;
  }
  return el("label", { class: "field" }, [el("span", { text: label }), input]);
}

async function submitAuth(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const registering = state.meta.needsOwner || state.authTab === "register";
  if (registering) {
    if ((data.name || "").trim().length < 2) return showBanner("Введите имя — хотя бы 2 буквы");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((data.email || "").trim())) return showBanner("Почта выглядит неверно");
    if ((data.password || "").length < 6) return showBanner("Пароль должен быть не короче 6 символов");
    if (data.password !== data.password2) return showBanner("Пароли не совпадают");
  } else if (!(data.email || "").trim() || !data.password) {
    return showBanner("Введите почту и пароль");
  }
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  showBanner("");
  try {
    const result = await api(registering ? "/api/register" : "/api/login", {
      method: "POST",
      body: registering
        ? { name: data.name, email: data.email, password: data.password }
        : { email: data.email, password: data.password },
    });
    state.me = result.user;
    if (state.me.role === "owner") state.meta.needsOwner = false;
    state.orders = [];
    setHash("#/orders");
  } catch (error) {
    showBanner(error.message);
    button.disabled = false;
  }
}

function topbar() {
  return el("header", { class: "topbar" }, [
    el("a", { class: "brand", href: "#/orders" }, [
      el("span", { class: "mark", "aria-hidden": "true" }),
      el("span", { text: "Заказы" }),
    ]),
    el("div", { class: "userbox" }, [
      el("span", { class: "name", text: state.me.name }),
      state.me.role === "owner" ? el("span", { class: "pill", text: "Владелец" }) : null,
      el("button", { class: "btn ghost small", type: "button", text: "Выйти", onclick: logout }),
    ]),
  ]);
}

async function logout() {
  try {
    await api("/api/logout", { method: "POST" });
  } catch (error) {
    showBanner(error.message);
    return;
  }
  state.me = null;
  state.orders = [];
  state.order = null;
  state.messages = [];
  stopPoll();
  setHash("#/login");
}

function renderList() {
  const screen = el("main", { class: "screen" }, [
    el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { text: "Заказы" }),
        el("p", {
          class: "lede",
          text: state.me.role === "client"
            ? "Здесь ваши заказы. Откройте любой, чтобы написать владельцу."
            : "Здесь заказы клиентов. Откройте любой, чтобы ответить.",
        }),
      ]),
      state.me.role === "client"
        ? el("a", { class: "btn primary", href: "#/orders/new", text: "Новый заказ" })
        : null,
    ]),
    state.me.role === "owner" ? shareBox() : null,
    toolbar(),
    bannerNode(),
    el("div", { class: "cards", id: "order-cards" }),
  ]);
  document.querySelector("#app").replaceChildren(topbar(), screen);
  const search = document.querySelector("#search");
  search.addEventListener("input", () => {
    state.query = search.value;
    paintCards();
  });
  paintCards();
}

function shareTarget() {
  const host = location.hostname;
  const onHomeNetwork = host === "localhost" || host === "127.0.0.1" || host === "::1"
    || host.startsWith("192.168.")
    || host.startsWith("10.")
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  if (!onHomeNetwork) {
    return {
      url: location.origin,
      note: "Эту ссылку можно отправить клиенту. Сайт по ней открыт и когда компьютер выключен.",
    };
  }
  if (state.meta.lanUrl) {
    return {
      url: state.meta.lanUrl,
      note: "Эту ссылку можно открыть с телефона или другого компьютера в той же сети Wi-Fi.",
    };
  }
  return {
    url: state.meta.localUrl || location.origin,
    note: "Ссылка открывается на этом компьютере.",
  };
}

function shareBox() {
  const share = shareTarget();
  const url = share.url;
  const note = share.note;
  return el("section", { class: "share" }, [
    el("label", { for: "share-url", text: "Ссылка для клиентов" }),
    el("div", { class: "share-row" }, [
      el("input", { id: "share-url", readonly: true, value: url }),
      el("button", { class: "btn ghost small", type: "button", text: "Скопировать", onclick: copyShare }),
    ]),
    el("p", { class: "hint", text: note }),
  ]);
}

async function copyShare(event) {
  const input = document.querySelector("#share-url");
  try {
    await navigator.clipboard.writeText(input.value);
    event.currentTarget.textContent = "Скопировано";
  } catch {
    input.focus();
    input.select();
    event.currentTarget.textContent = "Выделите ссылку";
  }
}

function toolbar() {
  return el("div", { class: "toolbar" }, [
    el("div", { class: "chips", role: "group", "aria-label": "Фильтр заказов" }, FILTERS.map(([key, label]) => (
      el("button", {
        type: "button",
        class: "chip",
        "data-filter": key,
        text: label,
        onclick: () => {
          state.filter = key;
          paintCards();
        },
      })
    ))),
    el("input", {
      id: "search",
      class: "search",
      type: "search",
      placeholder: "Поиск",
      value: state.query,
      "aria-label": "Поиск по заказам",
    }),
  ]);
}

function matches(order) {
  if (state.filter !== "all" && order.status !== state.filter) return false;
  const query = state.query.trim().toLowerCase();
  if (!query) return true;
  return [order.title, order.description, order.clientName, order.clientEmail, order.lastMessage]
    .filter(Boolean)
    .join("\n")
    .toLowerCase()
    .includes(query);
}

function paintCards() {
  const box = document.querySelector("#order-cards");
  if (!box) return;
  document.querySelectorAll("[data-filter]").forEach((button) => {
    const key = button.getAttribute("data-filter");
    const count = key === "all" ? state.orders.length : state.orders.filter((order) => order.status === key).length;
    const label = FILTERS.find(([id]) => id === key)[1];
    button.textContent = `${label} ${count}`;
    button.setAttribute("aria-pressed", key === state.filter ? "true" : "false");
  });
  if (state.loading) {
    box.replaceChildren(el("p", { class: "hint", text: "Загрузка…" }));
    return;
  }
  const visible = state.orders.filter(matches);
  if (!visible.length) {
    const untouched = state.orders.length === 0 && state.filter === "all" && !state.query.trim();
    box.replaceChildren(emptyState(untouched));
    return;
  }
  box.replaceChildren(...visible.map(renderCard));
}

function emptyState(untouched) {
  if (!untouched) return el("div", { class: "empty" }, [el("h2", { text: "Ничего не нашлось" })]);
  if (state.me.role === "owner") {
    return el("div", { class: "empty" }, [
      el("h2", { text: "Заказов ещё нет" }),
      el("p", { text: "Когда клиент зарегистрируется и создаст заказ, он появится здесь. Отвечать можно внутри заказа." }),
    ]);
  }
  return el("div", { class: "empty" }, [
    el("h2", { text: "Пока нет заказов" }),
    el("p", { text: "Опишите работу — и сразу можно написать владельцу." }),
    el("a", { class: "btn primary", href: "#/orders/new", text: "Новый заказ" }),
  ]);
}

function previewText(order) {
  if (!order.lastMessage) return clip(order.description || "");
  const who = order.lastAuthorId === state.me.id ? "Вы" : (order.lastAuthorName || "Сообщение");
  return clip(`${who}: ${order.lastMessage}`);
}

function renderCard(order) {
  return el("a", { class: "card " + order.status, href: `#/orders/${order.id}` }, [
    el("div", { class: "card-top" }, [
      el("span", { class: "stamp " + order.status, text: STATUS_LABEL[order.status] }),
      el("time", { datetime: order.updatedAt, text: formatTime(order.updatedAt) }),
    ]),
    el("h2", { text: order.title }),
    state.me.role === "owner"
      ? el("div", { class: "who", text: order.clientEmail ? `${order.clientName} · ${order.clientEmail}` : order.clientName })
      : null,
    el("p", { class: "preview", text: previewText(order) }),
  ]);
}

function renderCreate() {
  const form = el("form", { class: "narrow", novalidate: true, onsubmit: submitOrder }, [
    bannerNode(),
    el("label", { class: "field" }, [
      el("span", { text: "Название" }),
      el("input", { name: "title", maxlength: "140", placeholder: "Кратко, что нужно сделать" }),
    ]),
    el("label", { class: "field" }, [
      el("span", { text: "Описание" }),
      el("textarea", { name: "description", maxlength: "4000", placeholder: "Подробности, сроки, пожелания" }),
    ]),
    el("button", { class: "btn primary", type: "submit", text: "Создать и написать" }),
  ]);
  const screen = el("main", { class: "screen" }, [
    el("a", { class: "back", href: "#/orders", text: "← К заказам" }),
    el("div", { class: "narrow" }, [
      el("h1", { text: "Новый заказ" }),
      el("p", { class: "lede form-note", text: "После создания откроется переписка — можно сразу написать." }),
    ]),
    form,
  ]);
  document.querySelector("#app").replaceChildren(topbar(), screen);
  document.querySelector("input[name=title]")?.focus();
}

async function submitOrder(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  if ((data.title || "").trim().length < 2) return showBanner("Введите название заказа");
  if (!(data.description || "").trim()) return showBanner("Опишите, что нужно сделать");
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  showBanner("");
  try {
    const result = await api("/api/orders", {
      method: "POST",
      body: { title: data.title, description: data.description },
    });
    setHash(`#/orders/${result.order.id}`);
  } catch (error) {
    showBanner(error.message);
    button.disabled = false;
  }
}

function renderOrder() {
  const order = state.order;
  const statusControl = state.me.role === "owner" ? statusSelect() : el("span", {
    id: "status-stamp",
    class: "stamp " + order.status,
    text: STATUS_LABEL[order.status],
  });
  const screen = el("main", { class: "screen" }, [
    el("a", { class: "back", href: "#/orders", text: "← К заказам" }),
    bannerNode(),
    el("div", { class: "order-head" }, [
      el("div", {}, [
        el("h1", { text: order.title }),
        el("p", { class: "hint", text: "Создан " + formatTime(order.createdAt) }),
      ]),
      statusControl,
    ]),
    el("div", { class: "order-layout" }, [
      el("section", { class: "brief" }, [
        el("h2", { text: "Описание" }),
        el("p", { class: "description", text: order.description }),
        state.me.role === "owner" ? el("div", { class: "client-box" }, [
          el("h2", { text: "Клиент" }),
          el("p", { text: order.clientName }),
          el("p", { class: "hint", text: order.clientEmail || "" }),
        ]) : null,
      ]),
      el("section", { class: "chat-panel" }, [
        el("h2", { text: "Переписка" }),
        el("div", { id: "chat-log", class: "chat-log", role: "log", "aria-label": "Переписка" }),
        el("form", { class: "composer", onsubmit: sendMessage }, [
          el("textarea", {
            id: "composer",
            maxlength: "4000",
            placeholder: "Написать сообщение…",
            "aria-label": "Сообщение",
          }),
          el("div", { class: "composer-row" }, [
            el("p", { class: "hint", text: "Enter — отправить, Shift+Enter — новая строка" }),
            el("button", { class: "btn primary", type: "submit", text: "Отправить" }),
          ]),
        ]),
      ]),
    ]),
  ]);
  document.querySelector("#app").replaceChildren(topbar(), screen);
  const composer = document.querySelector("#composer");
  composer.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form.requestSubmit();
    }
  });
  requestAnimationFrame(() => paintMessages(true));
  if (window.matchMedia("(min-width: 800px)").matches) composer.focus();
}

function statusSelect() {
  const select = el("select", { id: "status-select", class: "status-select", "aria-label": "Статус", onchange: onStatus });
  for (const [key, label] of Object.entries(STATUS_LABEL)) {
    select.append(el("option", { value: key, text: label, selected: key === state.order.status }));
  }
  return el("label", { class: "status-label" }, [el("span", { text: "Статус" }), select]);
}

async function onStatus(event) {
  const select = event.currentTarget;
  select.disabled = true;
  try {
    const data = await api(`/api/orders/${state.order.id}`, {
      method: "PATCH",
      body: { status: select.value },
    });
    if (state.order && data.order.id === state.order.id) state.order = data.order;
    paintStatus();
  } catch (error) {
    select.value = state.order.status;
    showBanner(error.message);
  } finally {
    select.disabled = false;
  }
}

function paintStatus() {
  const select = document.querySelector("#status-select");
  const stamp = document.querySelector("#status-stamp");
  if (select && document.activeElement !== select) select.value = state.order.status;
  if (stamp) {
    stamp.className = "stamp " + state.order.status;
    stamp.textContent = STATUS_LABEL[state.order.status];
  }
}

function paintMessages(force) {
  const log = document.querySelector("#chat-log");
  if (!log) return;
  const nearBottom = force || log.scrollHeight - log.scrollTop - log.clientHeight < 90;
  if (!state.messages.length) {
    log.replaceChildren(el("p", { class: "hint", text: "Сообщений пока нет. Напишите первым." }));
  } else {
    log.replaceChildren(...state.messages.map(renderBubble));
  }
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function renderBubble(message) {
  const mine = message.authorId === state.me.id;
  return el("article", { class: "bubble " + (mine ? "mine" : "theirs") }, [
    el("header", {}, [
      el("strong", { text: mine ? "Вы" : message.authorName }),
      message.authorRole === "owner" && !mine ? el("span", { class: "role", text: "Владелец" }) : null,
      el("time", { datetime: message.createdAt, text: formatTime(message.createdAt) }),
    ]),
    el("p", { text: message.body }),
  ]);
}

let sending = false;

async function sendMessage(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const textarea = form.querySelector("textarea");
  const text = textarea.value.trim();
  if (!text || sending || !state.order) return;
  sending = true;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const data = await api(`/api/orders/${state.order.id}/messages`, {
      method: "POST",
      body: { body: text },
    });
    textarea.value = "";
    appendMessages([data.message], true);
    showBanner("");
  } catch (error) {
    showBanner(error.message);
  } finally {
    sending = false;
    button.disabled = false;
    textarea.focus();
  }
}

window.addEventListener("hashchange", () => { route(); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) poll();
});
boot();
