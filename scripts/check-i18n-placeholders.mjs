#!/usr/bin/env node
/**
 * Fails the build when a compiled Lingui message carries a RENAMED placeholder
 * such as "{pct_2}" or "{profileName_0}".
 *
 * The React Compiler renames shadowed bindings (pct → pct_2) before the Lingui
 * SWC macro runs, so `<Trans>{pct}%</Trans>` compiles to a message whose id is
 * not in the extracted catalogs. Production Lingui does not compile messages at
 * runtime and prints such a message raw — placeholder included — while dev
 * looks fine. Fix: keep a single binding of that name in the component.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? '.next/static/chunks';
const pattern = /message:"([^"]*\{[A-Za-z]+_\d+\}[^"]*)"/g;

function* walk(dir) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) yield* walk(p);
        else if (p.endsWith('.js')) yield p;
    }
}

const hits = new Set();
for (const file of walk(root)) {
    for (const m of readFileSync(file, 'utf8').matchAll(pattern)) hits.add(m[1]);
}

if (hits.size) {
    console.error('[check-i18n-placeholders] messages with compiler-renamed placeholders:');
    for (const h of hits) console.error(`  ${h}`);
    console.error('Keep a single binding of each placeholder name in the component (see script header).');
    process.exit(1);
}
console.log('[check-i18n-placeholders] ok');
