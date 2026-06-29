import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = join(root, 'src', 'web');
const dist = join(root, 'dist', 'web');

const assets = ['index.html', 'styles.css', 'favicon.ico'];

if (!existsSync(dist)) {
  mkdirSync(dist, { recursive: true });
}

for (const file of assets) {
  const srcPath = join(src, file);
  const distPath = join(dist, file);
  if (existsSync(srcPath)) {
    copyFileSync(srcPath, distPath);
    console.log(`Copied ${file} to dist/web/`);
  } else {
    console.error(`Warning: ${srcPath} not found`);
  }
}
