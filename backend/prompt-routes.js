'use strict';

const path = require('path');
const express = require('express');
const { GoogleGenAI } = require('@google/genai');

const { MODEL_CANDIDATES, describeKey, generatePrompt, SYSTEM_INSTRUCTION } = require('./gemini');

const router = express.Router();

const API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const keyInfo = describeKey(API_KEY);
const ai = keyInfo.present ? new GoogleGenAI({ apiKey: API_KEY }) : null;

function logStartupState() {
  if (!keyInfo.present) {
    console.warn('⚠️  GEMINI_API_KEY is not set — the Prompt Ideas page will not work.');
    console.warn(`    Add it to ${path.join(__dirname, '.env')}`);
  } else {
    console.log(`✅ Gemini key loaded: ${keyInfo.masked} (${keyInfo.kind})`);
  }
}

// POST /api/prompt/generate
router.post('/generate', async (req, res) => {
  if (!ai) {
    return res.status(500).json({
      error: 'Server is missing GEMINI_API_KEY. Add it to backend/.env and restart.',
      detail: `Expected file: ${path.join(__dirname, '.env')}`,
    });
  }

  const loop = req.body?.loop !== false; // default true
  const previousIdeas = Array.isArray(req.body?.previousIdeas)
    ? req.body.previousIdeas.slice(0, 6)
    : [];

  try {
    const { text, model } = await generatePrompt({ ai, apiKey: API_KEY, loop, previousIdeas });
    res.json({ prompt: text, model });
  } catch (err) {
    const status = err.httpStatus || 500;
    console.error(`[prompt] Gemini error (${status}): ${err.detail || err.message}`);

    res.status(status === 401 || status === 403 ? status : 502).json({
      error: err.friendly || 'Gemini request failed.',
      detail: err.detail || err.message,
      hint: err.hint,
    });
  }
});

// GET /api/prompt/health — is the key loaded, and what kind is it?
router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    keyPresent: keyInfo.present,
    keyMasked: keyInfo.masked,
    keyKind: keyInfo.kind,
    models: MODEL_CANDIDATES,
    envFile: path.join(__dirname, '.env'),
  });
});

// GET /api/prompt/models — which model names this key can actually use.
router.get('/models', async (_req, res) => {
  if (!API_KEY) return res.status(500).json({ error: 'No Gemini API key loaded.' });
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': API_KEY },
    });
    const raw = await r.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: 'Non-JSON response from Google', detail: raw.slice(0, 200) });
    }
    if (!r.ok) return res.status(r.status).json(body);

    const models = (body.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''));
    res.json({ count: models.length, models });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/prompt/system-instruction — handy when tweaking the prompt rules.
router.get('/system-instruction', (_req, res) => res.type('text/plain').send(SYSTEM_INSTRUCTION));

module.exports = { promptRouter: router, logPromptStartupState: logStartupState };
