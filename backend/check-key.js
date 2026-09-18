'use strict';

// Run with:  npm run check-key   (from the backend folder)
// Talks to Google directly and prints the exact error, so you can tell a
// bad key apart from a bad model name, a quota problem, or no internet.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { describeKey, MODEL_CANDIDATES } = require('./gemini');

const KEY = (process.env.GEMINI_API_KEY || '').trim();
const info = describeKey(KEY);

console.log('\n--- Gemini key check -------------------------');
console.log('.env file :', path.join(__dirname, '.env'));
console.log('key       :', info.masked);
console.log('key type  :', info.kind);

if (!info.present) {
  console.log('\nNo key found. Put this in backend/.env:\n  GEMINI_API_KEY=AQ.your_key_here\n');
  process.exit(1);
}

if (info.kind === 'unknown format') {
  console.log('\nWarning: this does not look like an AI Studio key.');
  console.log('Get one at https://aistudio.google.com/apikey\n');
}

(async () => {
  console.log('\n1) Listing models your key can use...');
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': KEY },
    });

    const raw = await r.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      console.log(`   FAILED — Google did not return JSON (HTTP ${r.status}).`);
      console.log(`   Response: ${raw.slice(0, 200)}`);
      console.log('\n   -> Usually a proxy, VPN or corporate firewall intercepting the request.');
      process.exit(1);
    }

    if (!r.ok) {
      console.log(`   FAILED (HTTP ${r.status})`);
      console.log(`   Google says: ${body?.error?.message || JSON.stringify(body)}`);
      console.log(`   reason: ${body?.error?.details?.[0]?.reason || 'n/a'}`);
      if (r.status === 401) {
        console.log('\n   -> The key itself is being rejected. Regenerate it at');
        console.log('      https://aistudio.google.com/apikey and paste the new one into backend/.env');
      }
      if (r.status === 403) {
        console.log('\n   -> Key is fine, but the Generative Language API is not enabled');
        console.log('      on that Google Cloud project. Enable it, or make a key in a new project.');
      }
      process.exit(1);
    }

    const usable = (body.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''));

    console.log(`   OK — ${usable.length} models available.`);
    console.log('   flash models:', usable.filter((m) => m.includes('flash')).slice(0, 8).join(', ') || '(none)');

    const pick = MODEL_CANDIDATES.find((m) => usable.includes(m)) || usable[0];
    console.log(`\n2) Sending a real test prompt to "${pick}"...`);

    const g = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${pick}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say OK.' }] }] }),
      }
    );
    const gRaw = await g.text();
    let gb;
    try {
      gb = JSON.parse(gRaw);
    } catch {
      console.log(`   FAILED — non-JSON response (HTTP ${g.status}): ${gRaw.slice(0, 200)}`);
      process.exit(1);
    }

    if (!g.ok) {
      console.log(`   FAILED (HTTP ${g.status}): ${gb?.error?.message || JSON.stringify(gb)}`);
      process.exit(1);
    }

    const text = (gb.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    console.log(`   OK — model replied: "${text}"`);
    console.log('\nKey works. Start the app with start.bat.\n');
  } catch (err) {
    console.log(`   NETWORK ERROR: ${err.message}`);
    console.log('   Check your internet connection, VPN or firewall.\n');
    process.exit(1);
  }
})();
