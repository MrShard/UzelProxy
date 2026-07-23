// ============================================================================
//  UzelProxy — background service worker (Manifest V3)
// ----------------------------------------------------------------------------
//  Роутинг: расширение генерирует PAC-скрипт на клиенте и применяет его через
//  chrome.proxy.settings. ВШИТОГО / серверного прокси НЕТ — проксирование
//  происходит только через собственный прокси пользователя (если он задан).
//  Готовый список ИСКЛЮЧЕНИЙ (сайты пускаются напрямую, DIRECT) при желании
//  подтягивается из публичного git-репозитория.
//
//  Приоритет маршрутизации в PAC (первое совпадение выигрывает):
//    1. git-исключения          → DIRECT
//    2. пользовательские noProxy  → DIRECT
//    3. onlyProxy               → прокси только для списка, остальное DIRECT
//    4. addProxy                → прокси для списка (аддитивно)
//    5. allProxy                → прокси для всего трафика
//    6. fallback                → DIRECT (без своего прокси расширение пассивно)
// ============================================================================

"use strict";

// URL готового списка исключений. jsDelivr даёт CDN-кеш (~обновление за неделю),
// нет rate-limit как у raw.githubusercontent.
const BLOCKLIST_URL = "https://cdn.jsdelivr.net/gh/MrShard/UzelProxy@main/blocklist.txt";

const WEEK_MINUTES = 10080;             // период обновления списка / интервал аларма
const TTL_MS = WEEK_MINUTES * 60 * 1000;

// --- обёртки над chrome.storage.local --------------------------------------
function set(obj) { return new Promise(r => chrome.storage.local.set(obj, r)); }
function get(key) { return new Promise(r => chrome.storage.local.get(key, r)); }

function nowUTC() { return new Date().toUTCString(); }
function epochUTC() { return new Date(0).toUTCString(); }

function genUid() {
    return "xxxxxxxx-xxxx-xxxx-xxxx-xxxx-v.7.0.4".replace(/x/g, a => {
        let b = 0 | 16 * Math.random();
        let c = (a === "x") ? b : (8 | 3 & b);
        return c.toString(16);
    });
}

function openTab(url) { chrome.tabs.create({ url }); }

function setIcon(path, title) {
    chrome.action.setIcon({ path });
    chrome.action.setTitle({ title });
}

function browserName() {
    for (const a of navigator.userAgentData.brands) {
        if (a?.brand === "Google Chrome") return "Chrome";
        if (a?.brand === "Microsoft Edge") return "Edge";
        if (a?.brand === "YaBrowser" || a?.brand === "Yandex") return "Yandex";
    }
}

// --- разрешения ------------------------------------------------------------
function hasAllUrls() {
    return new Promise(r => chrome.permissions.getAll(b =>
        b.origins.contains("<all_urls>") ? r(true) : r(false)));
}
function hasPermission(perm) {
    return new Promise(r => chrome.permissions.contains({ permissions: [perm] }, r));
}
function getAllExtensions() {
    return new Promise(r => chrome.management.getAll(r));
}

// Отключение других прокси/VPN-расширений при конфликте (если включено юзером).
async function disableConflictingExtensions() {
    const { isEnabled, disableExtensions } = await get(["isEnabled", "disableExtensions"]);
    const canManage = await hasPermission("management");
    if (!isEnabled || !disableExtensions || !canManage) return;
    const all = await getAllExtensions();
    all.forEach(x => {
        if (x.enabled && x.id !== chrome.runtime.id && x.permissions.contains("proxy")) {
            chrome.management.setEnabled(x.id, false);
        }
    });
}

// ============================================================================
//  Загрузка и кеширование списка исключений из git
// ============================================================================
let fetchInFlight = false;

async function fetchGitList(force) {
    const b = await get(["dtime", "gitDomains"]);

    // Недельный TTL-гейт: если список свежий — просто применяем кеш.
    if (!force && b.dtime && (Date.now() - new Date(b.dtime).getTime() < TTL_MS)) {
        applyPac();
        return;
    }
    if (fetchInFlight) return;
    fetchInFlight = true;

    try {
        const resp = await fetch(BLOCKLIST_URL, {
            method: "GET",
            headers: new Headers({ "If-Modified-Since": b.dtime || epochUTC() })
        });
        if (resp.status === 304) {           // список не изменился
            await set({ dtime: nowUTC() });
            applyPac();
            return;
        }
        if (!resp.ok) {                      // прочие ошибки — работаем на кеше
            applyPac();
            return;
        }
        const text = await resp.text();
        const domains = text.split(/\r?\n/)
            .map(s => s.trim())
            .filter(s => s && !s.startsWith("#") && /^[a-zA-Z0-9.*-]+$/.test(s));
        await set({ gitDomains: domains, dtime: nowUTC() });
        applyPac();
    } catch (e) {                            // сеть недоступна — оставляем кеш
        applyPac();
    } finally {
        fetchInFlight = false;
    }
}

// ============================================================================
//  Построение и применение PAC
// ============================================================================
function buildPac(o) {
    // o.userProxyString — bare-директива вида "PROXY 1.2.3.4:8080;" (без кавычек)
    return `function FindProxyForURL(url, host) {
\tconst GIT_ARRAY             = ${JSON.stringify(o.gitDomains)};
\tconst USER_OWN_PROXY        = ${o.userProxy};
\tconst USER_OWN_PROXY_STRING = ${JSON.stringify(o.userProxyString)};
\tconst USER_NO_PROXY         = ${o.noProxy};
\tconst USER_ONLY_PROXY       = ${o.onlyProxy};
\tconst USER_ADD_PROXY        = ${o.addProxy};
\tconst USER_ALL_PROXY        = ${o.allProxy};
\tconst USER_NO_PROXY_ARRAY   = ${JSON.stringify(o.noProxyDomains)};
\tconst USER_ONLY_PROXY_ARRAY = ${JSON.stringify(o.onlyProxyDomains)};
\tconst USER_ADD_PROXY_ARRAY  = ${JSON.stringify(o.addProxyDomains)};

\t// 1. готовые исключения из git-списка → напрямую
\tif (GIT_ARRAY && GIT_ARRAY.length > 0) {
\t\tfor (let i in GIT_ARRAY) {
\t\t\tif (GIT_ARRAY[i] == host) return 'DIRECT';
\t\t\tif (GIT_ARRAY[i][0] == '*') {
\t\t\t\tlet length = -1 * (GIT_ARRAY[i].length - 2);
\t\t\t\tif (GIT_ARRAY[i].substr(length) == host) return 'DIRECT';
\t\t\t\tlength = -1 * (GIT_ARRAY[i].length - 1);
\t\t\t\tif (GIT_ARRAY[i].substr(length) == host.substr(length)) return 'DIRECT';
\t\t\t}
\t\t}
\t}
\t// 2. пользовательские исключения → напрямую
\tif (USER_NO_PROXY) {
\t\tif (USER_NO_PROXY_ARRAY && USER_NO_PROXY_ARRAY.length > 0) {
\t\t\tfor (let i in USER_NO_PROXY_ARRAY) {
\t\t\t\tif (USER_NO_PROXY_ARRAY[i] == host) return 'DIRECT';
\t\t\t\tif (USER_NO_PROXY_ARRAY[i][0] == '*') {
\t\t\t\t\tlet length = -1 * (USER_NO_PROXY_ARRAY[i].length - 2);
\t\t\t\t\tif (USER_NO_PROXY_ARRAY[i].substr(length) == host) return 'DIRECT';
\t\t\t\t\tlength = -1 * (USER_NO_PROXY_ARRAY[i].length - 1);
\t\t\t\t\tif (USER_NO_PROXY_ARRAY[i].substr(length) == host.substr(length)) return 'DIRECT';
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\t// 3. проксировать только домены из списка (остальное напрямую)
\tif (USER_ONLY_PROXY && USER_OWN_PROXY) {
\t\tif (USER_ONLY_PROXY_ARRAY && USER_ONLY_PROXY_ARRAY.length > 0) {
\t\t\tfor (let i in USER_ONLY_PROXY_ARRAY) {
\t\t\t\tif (USER_ONLY_PROXY_ARRAY[i] == host) return USER_OWN_PROXY_STRING;
\t\t\t\telse if (USER_ONLY_PROXY_ARRAY[i][0] == '*') {
\t\t\t\t\tlet length = -1 * (USER_ONLY_PROXY_ARRAY[i].length - 2);
\t\t\t\t\tif (USER_ONLY_PROXY_ARRAY[i].substr(length) == host) return USER_OWN_PROXY_STRING;
\t\t\t\t\tlength = -1 * (USER_ONLY_PROXY_ARRAY[i].length - 1);
\t\t\t\t\tif (USER_ONLY_PROXY_ARRAY[i].substr(length) == host.substr(length)) return USER_OWN_PROXY_STRING;
\t\t\t\t\telse return 'DIRECT';
\t\t\t\t}
\t\t\t\telse return 'DIRECT';
\t\t\t}
\t\t}
\t}
\t// 4. добавить домены к проксируемым (аддитивно)
\tif (USER_ADD_PROXY && USER_OWN_PROXY) {
\t\tif (USER_ADD_PROXY_ARRAY && USER_ADD_PROXY_ARRAY.length > 0) {
\t\t\tfor (let i in USER_ADD_PROXY_ARRAY) {
\t\t\t\tif (USER_ADD_PROXY_ARRAY[i] == host) return USER_OWN_PROXY_STRING;
\t\t\t\tif (USER_ADD_PROXY_ARRAY[i][0] == '*') {
\t\t\t\t\tlet length = -1 * (USER_ADD_PROXY_ARRAY[i].length - 2);
\t\t\t\t\tif (USER_ADD_PROXY_ARRAY[i].substr(length) == host) return USER_OWN_PROXY_STRING;
\t\t\t\t\tlength = -1 * (USER_ADD_PROXY_ARRAY[i].length - 1);
\t\t\t\t\tif (USER_ADD_PROXY_ARRAY[i].substr(length) == host.substr(length)) return USER_OWN_PROXY_STRING;
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\t// 5. проксировать весь трафик (режим VPN)
\tif (USER_ALL_PROXY && USER_OWN_PROXY) {
\t\treturn USER_OWN_PROXY_STRING;
\t}
\t// 6. по умолчанию: напрямую (вшитого прокси нет)
\treturn 'DIRECT';
}`;
}

async function applyPac() {
    chrome.proxy.settings.clear({});
    if (!(await hasAllUrls())) {
        setIcon("icon-128-disabled.png", "Выкл");
        return true;
    }
    const a = await get();

    if (!a.isEnabled) {
        chrome.proxy.settings.clear({});
        setIcon("icon-128-disabled.png", "Выкл");
        return;
    }

    await disableConflictingExtensions();

    // Директива собственного прокси (осмысленна только при user_proxy)
    let proxyType = "PROXY";
    if (a.user_proxy) {
        if (a.user_proxy_type == null) {
            proxyType = "PROXY";
            await set({ user_proxy_type: "PROXY" });
        } else {
            proxyType = a.user_proxy_type;
        }
    }
    const userProxyString = `${proxyType} ${a.user_proxy_http || ""}:${a.user_proxy_port || ""};`;

    const pac = buildPac({
        userProxy: a.user_proxy ? true : false,
        userProxyString,
        noProxy: a.noProxy ? true : false,
        onlyProxy: a.onlyProxy ? true : false,
        addProxy: a.addProxy ? true : false,
        allProxy: a.allProxy ? true : false,
        noProxyDomains: a.noProxyDomains || [],
        onlyProxyDomains: a.onlyProxyDomains || [],
        addProxyDomains: a.addProxyDomains || [],
        gitDomains: (a.useGitList && Array.isArray(a.gitDomains)) ? a.gitDomains : []
    });

    const value = { mode: "pac_script", pacScript: { data: pac } };

    // Двухстадийная установка: dummy-DIRECT захватывает контроль, затем реальный PAC.
    chrome.proxy.settings.set({
        value: { mode: "pac_script", pacScript: { data: `function FindProxyForURL(url, host) {return 'DIRECT';}` } }
    }, () => {
        chrome.proxy.settings.get({}, s => {
            if (s.levelOfControl === "controlled_by_this_extension") {
                chrome.proxy.settings.set({ value });
            } else if (s.levelOfControl === "controlled_by_other_extensions") {
                chrome.proxy.settings.clear({});
                setIcon("icon-128-disabled.png", "err");
                chrome.action.setBadgeText({ text: "err" });
                chrome.action.setBadgeBackgroundColor({ color: "#f21a1a" });
            }
        });
    });

    setIcon("icon-128-enabled.png", "Вкл");
}

// ============================================================================
//  Share-таймер: однажды предложить страницу «поделиться»
// ============================================================================
async function maybeOpenShare(open) {
    const b = await get(["html", "share", "start"]);
    const pages = (b.html || "").split(";").filter(Boolean);
    const first = pages.shift();
    if (b.share === 0 && first && first !== "0" && (Date.now() - b.start) > 4e8) {
        await set({ share: Date.now() });
        open(first);
    }
}

// ============================================================================
//  Keep-alive service worker'а (MV3)
// ============================================================================
let keepAlivePort = null;

function connectKeepAlive() {
    chrome.runtime.lastError;
    chrome.runtime.connect({ name: "keepAlive" }).onDisconnect.addListener(connectKeepAlive);
}

async function ensureKeepAlive(tabs) {
    if (keepAlivePort) return;
    for (const { id } of (tabs || (await chrome.tabs.query({ url: "<all_urls>" })))) {
        try {
            await chrome.scripting.executeScript({ target: { tabId: id }, func: connectKeepAlive });
            return;
        } catch (e) { /* ignore */ }
    }
    chrome.tabs.onUpdated.addListener(onTabUpdatedForKeepAlive);
}

function stopKeepAlive() {
    if (keepAlivePort) { keepAlivePort.disconnect(); keepAlivePort = null; }
    ensureKeepAlive();
}

function onKeepAlivePort(port) {
    if (port && port.name === "keepAlive") {
        keepAlivePort = port;
        chrome.alarms.create("keepAlive", { periodInMinutes: 4.5 });
        chrome.alarms.onAlarm.removeListener(onAlarm);
        chrome.alarms.onAlarm.addListener(onAlarm);
        port.onDisconnect.addListener(stopKeepAlive);
    }
}

function onTabUpdatedForKeepAlive(_tabId, info, tab) {
    if (info.url && /^https?:/.test(info.url)) ensureKeepAlive([tab]);
}

function platformKeepAlive() {
    setInterval(chrome.runtime.getPlatformInfo, 20000);
}

// ============================================================================
//  Обработчики событий
// ============================================================================
function onAlarm(a) {
    if (a && a.name === "interval") {
        chrome.alarms.clear("interval", () => {
            maybeOpenShare(openTab);
            fetchGitList();              // недельное обновление списка
            chrome.alarms.create("interval", { periodInMinutes: WEEK_MINUTES });
        });
    } else if (a && a.name === "keepAlive") {
        chrome.alarms.clear("keepAlive", () => stopKeepAlive());
    }
}

function onInstalled(details) {
    if (details?.reason === "install") {
        const name = browserName();
        if (name === "Edge") openTab("common/start_edge.html");
        else if (name === "Yandex") openTab("common/start_yandex.html");
        else openTab("common/start_chrome.html");
    }
    if (details?.reason === "update") {
        set({ version: chrome.runtime.getManifest().version });
        if ("3.0.0" > details.previousVersion) openTab("common/update.html");
    }
    fetchGitList(true);
}

function onUpdateAvailable() {
    setTimeout(() => chrome.runtime.reload(), 10000);
}

async function onStartup() {
    platformKeepAlive();
    const perms = await chrome.permissions.getAll();
    if (!perms.origins.contains("<all_urls>")) {
        openTab("common/error.html");
        chrome.action.disable();
        setIcon("icon-128-disabled.png", "Выкл");
        return;
    }
    fetchGitList();                  // при старте: кеш + недельное обновление
}

function onMessage(msg, _sender, sendResponse) {
    (async () => {
        if (!(await hasAllUrls())) return;
        if (msg?.apply === "rebuild") {
            await applyPac();
            sendResponse();
        } else if (msg?.apply === "err") {
            sendResponse({ ext: await getLevelOfControl() });
        }
    })();
    return true;
}

function getLevelOfControl() {
    return new Promise(r => chrome.proxy.settings.get({}, s => r(s.levelOfControl)));
}

async function onPermissionAdded(perms) {
    if (perms.origins.contains("<all_urls>")) {
        chrome.tabs.query({}, tabs => {
            tabs.forEach(t => {
                if (t.url.includes(`${chrome.runtime.id}/common/error.html`)) chrome.tabs.remove(t.id);
            });
        });
        chrome.action.enable();
        await set({ isEnabled: true });
        fetchGitList(true);
    }
}

async function onPermissionRemoved(perms) {
    if (perms.origins.contains("<all_urls>")) {
        openTab("common/error.html");
        chrome.action.disable();
        await set({ isEnabled: false });
        setIcon("icon-128-disabled.png", "Выкл");
        applyPac();
    }
}

async function onProxyChange(settings) {
    const { isEnabled } = await get("isEnabled");
    const loc = settings?.levelOfControl;
    if (isEnabled && loc === "controlled_by_other_extensions") {
        chrome.proxy.settings.clear({});
        await disableConflictingExtensions();
        setIcon("icon-128-disabled.png", "err");
        chrome.action.setBadgeText({ text: "err" });
        chrome.action.setBadgeBackgroundColor({ color: "#f21a1a" });
        return;
    }
    if (isEnabled && (loc === "controllable_by_this_extension" || loc === "controlled_by_this_extension")) {
        applyPac();
    }
}

// ============================================================================
//  Дефолты в storage
// ============================================================================
async function initDefaults() {
    const defaults = {
        time: WEEK_MINUTES,
        blocklistUrl: BLOCKLIST_URL,
        dtime: epochUTC(),
        start: Date.now(),
        uid: genUid(),
        isEnabled: true,
        icon: true,
        userDomains: false,
        useGitList: false,
        gitDomains: [],
        noProxy: false,
        onlyProxy: false,
        addProxy: false,
        allProxy: false,
        version: chrome.runtime.getManifest().version,
        share: 0,
        html: "0;/common/share.html"
    };
    for (const [k, v] of Object.entries(defaults)) {
        const existing = await get(k);
        if (existing[k] === undefined || existing[k] === null) {
            await set({ [k]: v });
        }
    }
}

function registerListeners() {
    chrome.runtime.onConnect.addListener(onKeepAlivePort);
    chrome.runtime.onInstalled.addListener(onInstalled);
    chrome.runtime.onStartup.addListener(onStartup);
    chrome.runtime.onUpdateAvailable.addListener(onUpdateAvailable);
    chrome.runtime.onMessage.addListener(onMessage);
    chrome.permissions.onAdded.addListener(onPermissionAdded);
    chrome.permissions.onRemoved.addListener(onPermissionRemoved);
    chrome.proxy.settings.onChange.addListener(onProxyChange);
}

// Array.prototype.contains нужен для проверок origins/permissions.
Array.prototype.contains = function (a) { return -1 < this.indexOf(a); };

// ============================================================================
//  Точка входа
// ============================================================================
(async () => {
    registerListeners();
    await initDefaults();
    chrome.alarms.create("interval", { periodInMinutes: WEEK_MINUTES });
    chrome.alarms.onAlarm.addListener(onAlarm);
    fetchGitList(true);
    await ensureKeepAlive();
})();
