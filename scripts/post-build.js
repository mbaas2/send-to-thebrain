import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(__dirname, '../dist/manifest.json');

try {
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.background) {
      manifest.background.scripts = [manifest.background.service_worker || "service-worker-loader.js"];
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      console.log('Post-build: successfully added background.scripts to dist/manifest.json for Firefox compatibility.');
    }
  }
} catch (err) {
  console.error('Post-build manifest adjustment failed:', err);
}
