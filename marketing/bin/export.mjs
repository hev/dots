#!/usr/bin/env node
// Public-file allowlist shared by hevdots.com and hev.dev/dots.
import './build-cases.mjs';
import { mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../dist/', import.meta.url));
const dest = resolve(process.argv[2] || '/tmp/hevdots-public');
const files = ['index.html', '404.html', 'style.css', 'robots.txt', 'sitemap.xml', 'assets/hev-mind-paper.png', 'assets/hev-me.png', 'assets/dasha.png', 'assets/twc-paper.png', ...['mind','me','dasha','twc'].map(name => name + '.html'), ...['mind','me','dasha','twc'].flatMap(name => ['app','conversation'].map(state => `assets/screens/${name}-${state}.jpg`))];
for (const file of files) {
  await mkdir(dirname(resolve(dest, file)), { recursive: true });
  await copyFile(resolve(source, file), resolve(dest, file));
}
console.log(`Exported ${files.length} public files to ${dest}`);
