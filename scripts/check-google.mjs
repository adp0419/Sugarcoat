// Run explicitly with your server-side key; not a request on the latency path.
import { readConfig } from '../lib/config.mjs';
const config = readConfig();
if (!config.googleKey) throw new Error('Set GOOGLE_API_KEY in .env first.');
const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.googleModel)}`, {
  headers: { 'x-goog-api-key': config.googleKey }, signal: AbortSignal.timeout(10000),
});
if (!response.ok) throw new Error(`Google model access check returned HTTP ${response.status}. Check the key and GOOGLE_MODEL.`);
const model = await response.json();
console.log(JSON.stringify({ name: model.name, supportedGenerationMethods: model.supportedGenerationMethods }, null, 2));
