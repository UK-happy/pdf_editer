/**
 * postinstall script — copies pdfjs-dist CMap and standard font data
 * into public/ so they can be served as static assets.
 * Works cross-platform (macOS, Linux, Windows).
 */
import { cpSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const src = (sub) => resolve(root, 'node_modules', 'pdfjs-dist', sub);
const dst = (sub) => resolve(root, 'public', sub);

mkdirSync(dst('cmaps'), { recursive: true });
mkdirSync(dst('standard_fonts'), { recursive: true });

cpSync(src('cmaps'), dst('cmaps'), { recursive: true });
cpSync(src('standard_fonts'), dst('standard_fonts'), { recursive: true });

console.log('✔ Copied cmaps and standard_fonts to public/');
