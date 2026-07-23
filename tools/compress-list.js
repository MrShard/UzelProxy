#!/usr/bin/env node
// ============================================================================
//  compress-list.js — сжатие списка доменов-исключений через wildcard-агрегацию.
// ----------------------------------------------------------------------------
//  Группирует домены по корню (последние 2 метки). Если у корня ≥ WILDCARD_THRESHOLD
//  поддоменов — заменяет их все на одну запись "*..<root>" (покрывает весь корень).
//  Пример: 00.img.avito.st ... 99.img.avito.st (100 шт) → *.img.avito.st.
//
//  Использование:
//    node tools/compress-list.js [входной_файл] [выходной_файл] [порог]
//  По умолчанию: blocklist.txt → blocklist.txt (in-place), порог 4.
//
//  Сжатый список затем парсится расширением в trie-дерево (см. buildPac в bg.js),
//  что даёт O(длина домена) поиск вместо O(n).
// ============================================================================
"use strict";

const fs = require("fs");
const path = require("path");

const INPUT = process.argv[2] || path.join(__dirname, "..", "blocklist.txt");
const OUTPUT = process.argv[3] || INPUT;          // по умолчанию in-place
const WILDCARD_THRESHOLD = parseInt(process.argv[4] || "4", 10);

function rootOf(domain) {
    const parts = domain.split(".");
    return parts.slice(-2).join(".");
}

function loadDomains(file) {
    const raw = fs.readFileSync(file, "utf8");
    return raw.split(/\r?\n/)
        .map(s => s.trim().toLowerCase())
        .filter(s => s && !s.startsWith("#") && /^[a-z0-9.*-]+$/.test(s) && s.includes("."));
}

function main() {
    const before = loadDomains(INPUT);
    const byRoot = new Map();           // root → { subdomains:Set, rootItself:bool, wildcards:Set }
    const wildcardsPresent = new Set(); // уже wildcard-записи (*.domain) из входа

    for (const d of before) {
        if (d.startsWith("*.")) {
            wildcardsPresent.add(d.slice(2));      // сохраняем как есть
            continue;
        }
        const root = rootOf(d);
        const parts = d.split(".");
        if (!byRoot.has(root)) byRoot.set(root, { subdomains: new Set(), rootItself: false });
        const entry = byRoot.get(root);
        if (parts.length === 2) entry.rootItself = true;
        else entry.subdomains.add(parts.slice(0, -2).join("."));
    }

    const compressed = new Set(wildcardsPresent); // wildcard-записи переносятся как есть

    for (const [root, { subdomains, rootItself }] of byRoot) {
        const subs = [...subdomains];
        if (subs.length >= WILDCARD_THRESHOLD) {
            // Много поддоменов одного корня → wildcard покрывает их все.
            compressed.add("*." + root);
        } else {
            // Мало — оставляем точные записи.
            if (rootItself) compressed.add(root);
            for (const s of subs) compressed.add(s + "." + root);
        }
    }

    const result = [...compressed].sort();

    // Заголовок + тело.
    const header =
`# ============================================================================
#  UzelProxy — готовый список исключений (сжатый)
# ----------------------------------------------------------------------------
#  Сайты из этого списка открываются НАПРЯМУЮ (DIRECT), минуя ваш прокси.
#  Источник: открытый репозиторий проекта. Обновляется через раздел «Управление».
#
#  Файл сжат wildcard-агрегацией (tools/compress-list.js): поддомены одного
#  корня (≥${WILDCARD_THRESHOLD}) заменены на "*.<root>" для компактности.
#  Расширение парсит список в trie-дерево → поиск O(длина домена).
#
#  Формат: один домен на строку | "*" = wildcard | "#" = комментарий | Punycode для кириллицы.
#  Сжато: ${before.length} → ${result.length} доменов.
# ============================================================================

`;

    fs.writeFileSync(OUTPUT, header + result.join("\n") + "\n");

    console.log(`Сжатие: ${before.length} → ${result.length} доменов ` +
                `(${(before.length / result.length).toFixed(1)}×), порог=${WILDCARD_THRESHOLD}`);
    console.log(`Размер: ${Math.round(fs.statSync(OUTPUT).size / 1024)} KB → ${OUTPUT}`);
}

main();
