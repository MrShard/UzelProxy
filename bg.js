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

// Источник последней версии расширения. Кнопка «Проверить обновление» в экране
// «Управление» сравнивает установленную версию со значением version из этого файла.
const VERSION_URL = "https://cdn.jsdelivr.net/gh/MrShard/UzelProxy@main/version.json";

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
//  force=true — игнорировать TTL-кеш и обновить по запросу (кнопка «Обновить список»).
//  Возвращает { ok, count, dtime, error } для отчёта в UI.
// ============================================================================
let fetchInFlight = false;
let checkInFlight = false;

async function fetchGitList(force) {
    const b = await get(["dtime", "gitTrie", "gitDomainsCount"]);
    const prevCount = b.gitDomainsCount || 0;

    // Недельный TTL-гейт: если список свежий — просто применяем кеш.
    if (!force && b.dtime && (Date.now() - new Date(b.dtime).getTime() < TTL_MS)) {
        applyPac();
        return { ok: true, count: prevCount, dtime: b.dtime, error: null, cached: true };
    }
    if (fetchInFlight) {
        return { ok: false, count: prevCount, dtime: b.dtime, error: "inflight", cached: true };
    }
    fetchInFlight = true;

    try {
        const resp = await fetch(BLOCKLIST_URL, {
            method: "GET",
            headers: new Headers({ "If-Modified-Since": b.dtime || epochUTC(), "Cache-Control": "no-cache" })
        });
        if (resp.status === 304) {           // список не изменился
            await set({ dtime: nowUTC() });
            applyPac();
            return { ok: true, count: prevCount, dtime: nowUTC(), error: null, unchanged: true };
        }
        if (!resp.ok) {                      // прочие ошибки — работаем на кеше
            applyPac();
            return { ok: false, count: prevCount, dtime: b.dtime, error: "http_" + resp.status };
        }
        const text = await resp.text();
        const domains = text.split(/\r?\n/)
            .map(s => s.trim())
            .filter(s => s && !s.startsWith("#") && /^[a-zA-Z0-9.*-]+$/.test(s));
        // Строим trie один раз при загрузке → поиск O(длина домена), храним компактно (~11KB).
        const trie = buildTrieFromList(domains);
        await set({ gitTrie: trie, gitDomainsCount: domains.length, dtime: nowUTC() });
        applyPac();
        return { ok: true, count: domains.length, dtime: nowUTC(), error: null };
    } catch (e) {                            // сеть недоступна — оставляем кеш
        applyPac();
        return { ok: false, count: prevCount, dtime: b.dtime, error: "network" };
    } finally {
        fetchInFlight = false;
    }
}

// ============================================================================
//  Проверка обновления расширения по version.json
//  Возвращает { current, latest, hasUpdate, url, notes, error }.
// ============================================================================
async function checkVersion() {
    const current = chrome.runtime.getManifest().version;
    try {
        const resp = await fetch(VERSION_URL, {
            method: "GET",
            headers: new Headers({ "Cache-Control": "no-cache" })
        });
        if (!resp.ok) return { current, error: "http_" + resp.status };
        const data = await resp.json();
        const latest = data.version;
        const hasUpdate = compareVersions(latest, current) > 0;
        return {
            current, latest, hasUpdate,
            url: data.url || "https://github.com/MrShard/UzelProxy/releases/latest",
            notes: data.notes || null,
            error: null
        };
    } catch (e) {
        return { current, error: "network" };
    }
}

// Сравнение семантических версий: >0 если a новее b, <0 если старее, 0 при равенстве.
function compareVersions(a, b) {
    const pa = String(a).split(".").map(Number);
    const pb = String(b).split(".").map(Number);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const da = pa[i] || 0, db = pb[i] || 0;
        if (da !== db) return da - db;
    }
    return 0;
}

// ============================================================================
//  Построение и применение PAC
// ----------------------------------------------------------------------------
//  Списки доменов хранятся как trie (префиксное дерево по развёрнутым меткам):
//  {"ru":{"yandex":{"_":1,"mail":{"_":1}}}}. Поиск O(длина домена) вместо O(n).
//  Маркер "_" на узле = совпадение (домен или *.родитель в списке).
// ============================================================================
function buildTrieFromList(domains) {
    const trie = {};
    if (!Array.isArray(domains)) return trie;
    for (const raw of domains) {
        const d = String(raw).toLowerCase().trim();
        if (!d) continue;
        const labels = d.replace(/^\*\./, "").split(".").reverse();
        let node = trie;
        for (const l of labels) {
            if (!l) continue;
            if (!node[l]) node[l] = {};
            node = node[l];
        }
        node._ = 1; // маркер совпадения; wildcard: родитель в списке → любой поддомен
    }
    return trie;
}

function buildPac(o) {
    // o.userProxyString — bare-директива вида "PROXY 1.2.3.4:8080;" (без кавычек)
    // o.gitTrie / noProxyTrie / onlyProxyTrie / addProxyTrie — сериализованные trie-объекты.
    return `function FindProxyForURL(url, host) {
\tconst GIT_TRIE        = ${JSON.stringify(o.gitTrie)};
\tconst NOPROXY_TRIE    = ${JSON.stringify(o.noProxyTrie)};
\tconst ONLYPROXY_TRIE  = ${JSON.stringify(o.onlyProxyTrie)};
\tconst ADDPROXY_TRIE   = ${JSON.stringify(o.addProxyTrie)};
\tconst USER_OWN_PROXY  = ${o.userProxy};
\tconst PROXY_STR       = ${JSON.stringify(o.userProxyString)};
\tconst NO_PROXY        = ${o.noProxy};
\tconst ONLY_PROXY      = ${o.onlyProxy};
\tconst ADD_PROXY       = ${o.addProxy};
\tconst ALL_PROXY       = ${o.allProxy};
\tfunction inList(h, trie){
\t\tconst labels = h.split(".");
\t\tlet node = trie;
\t\tfor (let i = labels.length - 1; i >= 0; i--) {
\t\t\tif (node._) return true;          // родитель в списке → поддомен тоже (wildcard)
\t\t\tnode = node[labels[i]];
\t\t\tif (!node) return false;
\t\t}
\t\treturn !!(node && node._);
\t}
\t// 1. готовые исключения из git-списка → напрямую
\tif (inList(host, GIT_TRIE)) return 'DIRECT';
\t// 2. пользовательские исключения → напрямую
\tif (NO_PROXY && inList(host, NOPROXY_TRIE)) return 'DIRECT';
\t// 3. проксировать только домены из списка (остальное напрямую)
\tif (ONLY_PROXY && USER_OWN_PROXY) {
\t\tif (inList(host, ONLYPROXY_TRIE)) return PROXY_STR;
\t\treturn 'DIRECT';
\t}
\t// 4. добавить домены к проксируемым (аддитивно)
\tif (ADD_PROXY && USER_OWN_PROXY && inList(host, ADDPROXY_TRIE)) return PROXY_STR;
\t// 5. проксировать весь трафик (режим VPN)
\tif (ALL_PROXY && USER_OWN_PROXY) return PROXY_STR;
\t// 6. по умолчанию: напрямую (вшитого прокси нет)
\treturn 'DIRECT';
}`;
}

// ============================================================================
//  Проверка соединения прокси: временно ставим PAC с тестируемым прокси,
//  делаем fetch к cdn-cgi/trace (отдаёт ip=... loc=...), затем ВСЕГДА
//  восстанавливаем нормальный PAC. За время проверки трафик браузера идёт
//  через тестируемый прокси — сознательный trade-off (см. тултип в UI).
//  Возвращает { ok, ip, country, error }.
// ============================================================================
const PROBE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const PROBE_TIMEOUT_MS = 8000;

async function checkProxy(type, host, port) {
    // Sanitize: разрешаем только безопасные символы, иначе отказ (защита от инъекции в PAC).
    const safeHost = /^[A-Za-z0-9.\-]+$/.test(host) && host.length < 255;
    const safePort = /^[0-9]{1,5}$/.test(String(port)) && +port > 0 && +port <= 65535;
    const safeType = type === "PROXY" || type === "SOCKS5" || type === "SOCKS" || type === "HTTPS";
    if (!safeHost || !safePort || !safeType) {
        return { ok: false, error: "invalid" };
    }
    // Защита от параллельных проверок (race на chrome.proxy.settings).
    if (checkInFlight) return { ok: false, error: "inflight" };
    checkInFlight = true;

    // 1. Установка временного PAC: весь трафик через тестируемый прокси.
    // Данные безопасны после sanitize — интерполяция допустима.
    const probePac =
        `function FindProxyForURL(url, host){return '${type} ${host}:${port};'}`;
    const probeValue = { mode: "pac_script", pacScript: { data: probePac } };

    const setProbe = () => new Promise(resolve => {
        // dummy-DIRECT захватывает контроль, затем ставим проверочный PAC.
        chrome.proxy.settings.set({
            value: { mode: "pac_script", pacScript: { data: `function FindProxyForURL(url, host){return 'DIRECT';}` } }
        }, () => {
            chrome.proxy.settings.get({}, s => {
                if (s.levelOfControl === "controlled_by_this_extension") {
                    chrome.proxy.settings.set({ value: probeValue }, () => resolve(true));
                } else {
                    resolve(false);
                }
            });
        });
    });

    const controlled = await setProbe();
    if (!controlled) {
        await applyPac();
        return { ok: false, error: "controlled_by_other" };
    }

    // 2. fetch с таймаутом.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        const resp = await fetch(PROBE_URL, {
            method: "GET",
            cache: "no-store",
            signal: controller.signal
        });
        if (!resp.ok) {
            return { ok: false, error: "http_" + resp.status };
        }
        const text = await resp.text();
        const parsed = parseTrace(text);
        return { ok: true, ip: parsed.ip, country: parsed.country, error: null };
    } catch (e) {
        if (e?.name === "AbortError") return { ok: false, error: "timeout" };
        return { ok: false, error: "network" };
    } finally {
        clearTimeout(timer);
        checkInFlight = false;       // освобождаем блокировку
        await applyPac();            // ВСЕГДА восстанавливаем нормальный PAC
    }
}

// Парсинг ответа cdn-cgi/trace: строки вида "ip=1.2.3.4", "loc=RU".
function parseTrace(text) {
    const map = {};
    text.split(/\r?\n/).forEach(line => {
        const idx = line.indexOf("=");
        if (idx > 0) map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    return { ip: map.ip || null, country: map.loc || map.country || null };
}

async function applyPac() {
    chrome.proxy.settings.clear({});
    if (!(await hasAllUrls())) {
        setIcon("icon-128-off.png", "Выкл");
        return true;
    }
    const a = await get();

    if (!a.isEnabled) {
        chrome.proxy.settings.clear({});
        setIcon("icon-128-off.png", "Выкл");
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

    // Списки доменов → trie. git-список хранится уже trie-объектом (gitTrie),
    // пользовательские списки — массивы, строим trie на лету (обычно короткие).
    const gitTrie = (a.useGitList && a.gitTrie) ? a.gitTrie
        : (a.useGitList && Array.isArray(a.gitDomains)) ? buildTrieFromList(a.gitDomains)
        : {};

    const pac = buildPac({
        userProxy: a.user_proxy ? true : false,
        userProxyString,
        noProxy: a.noProxy ? true : false,
        onlyProxy: a.onlyProxy ? true : false,
        addProxy: a.addProxy ? true : false,
        allProxy: a.allProxy ? true : false,
        noProxyTrie: buildTrieFromList(a.noProxyDomains),
        onlyProxyTrie: buildTrieFromList(a.onlyProxyDomains),
        addProxyTrie: buildTrieFromList(a.addProxyDomains),
        gitTrie
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
                setIcon("icon-128-off.png", "err");
                chrome.action.setBadgeText({ text: "err" });
                chrome.action.setBadgeBackgroundColor({ color: "#f21a1a" });
            }
        });
    });

    setIcon("icon-128-on.png", "Вкл");
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
        setIcon("icon-128-off.png", "Выкл");
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
        } else if (msg?.apply === "updateList") {
            // Ручное обновление списка исключений (кнопка «Обновить список»).
            const result = await fetchGitList(true);
            sendResponse(result);
        } else if (msg?.apply === "checkUpdate") {
            // Проверка обновления расширения по version.json.
            const result = await checkVersion();
            sendResponse(result);
        } else if (msg?.apply === "listInfo") {
            // Текущее состояние списка для экрана «Управление».
            const s = await get(["gitDomainsCount", "dtime", "useGitList"]);
            const count = s.gitDomainsCount || 0;
            sendResponse({ count, dtime: s.dtime || null, useGitList: !!s.useGitList });
        } else if (msg?.apply === "checkProxy") {
            // Проверка соединения конкретного прокси (PAC + fetch + откат).
            const result = await checkProxy(msg.type, msg.host, msg.port);
            sendResponse(result);
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
        setIcon("icon-128-off.png", "Выкл");
        applyPac();
    }
}

async function onProxyChange(settings) {
    const { isEnabled } = await get("isEnabled");
    const loc = settings?.levelOfControl;
    if (isEnabled && loc === "controlled_by_other_extensions") {
        chrome.proxy.settings.clear({});
        await disableConflictingExtensions();
        setIcon("icon-128-off.png", "err");
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
        isEnabled: false,            // выключен по умолчанию: без добавленного прокси пассивен
        icon: true,
        userDomains: false,
        useGitList: false,
        gitTrie: {},
        gitDomainsCount: 0,
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
