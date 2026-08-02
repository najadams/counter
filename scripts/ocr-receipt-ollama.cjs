#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const imagePath = process.argv[2] || process.env.COUNTER_RECEIPT_IMAGE;
if (!imagePath) {
  console.error('Usage: ocr-receipt-ollama.cjs <receipt-image-path>');
  process.exit(2);
}

const model = process.env.COUNTER_OLLAMA_MODEL || 'qwen2.5vl:3b';
const host = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const requestedNumCtx = readPositiveInt(process.env.COUNTER_OLLAMA_NUM_CTX, 8192);
const prompt = [
  'Transcribe every visible handwritten product line on this receipt image.',
  'Do not ignore faint or lower lines. Preserve one output line for each handwritten row.',
  'Return valid JSON only:',
  '{"rawText":"line one\\nline two","lines":[{"rawText":"full handwritten row","productText":"product words only","unitText":null,"quantity":null,"unitPricePesewas":null,"confidence":0}]}',
  'Rules:',
  '- Include only handwritten product rows, not printed app UI, headings, totals, balances, signatures, dates, or cashier names.',
  '- rawText has one line per handwritten row.',
  '- productText is product wording only, without quantity or price.',
  '- quantity is the leading number if present, otherwise null.',
  '- unitPricePesewas is null unless a price is written on that row. GH¢8.00 is 800.',
  '- unitText is bottle, crate, pack, can, sachet, or null.',
  '- confidence is an integer 0 to 100.',
].join('\n');

async function main() {
  const abs = path.resolve(imagePath);
  const image = fs.readFileSync(abs).toString('base64');
  const body = await callOllama(image, requestedNumCtx);
  process.stdout.write(normalizeJson(body));
}

async function callOllama(image, numCtx) {
  const response = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      options: {
        temperature: 0,
        num_ctx: numCtx,
        num_predict: 1024,
      },
      messages: [
        {
          role: 'user',
          content: prompt,
          images: [image],
        },
      ],
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    if (shouldRetryWithMoreContext(body, numCtx)) {
      return callOllama(image, 16384);
    }
    throw new Error(`Ollama OCR failed (${response.status}): ${body}`);
  }
  const parsed = JSON.parse(body);
  const content = parsed?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('Ollama OCR returned no message content');
  }
  return content;
}

function readPositiveInt(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function shouldRetryWithMoreContext(body, numCtx) {
  if (process.env.COUNTER_OLLAMA_NUM_CTX) return false;
  if (numCtx >= 16384) return false;
  return /exceed(?:s|ed)?(?:_| )context(?:_| )size|available context size|n_ctx/i.test(body);
}

function normalizeJson(content) {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const parsed = JSON.parse(trimmed);
  const rawText = typeof parsed.rawText === 'string' ? parsed.rawText : '';
  const rawLines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const modelLines = Array.isArray(parsed.lines)
    ? parsed.lines.map((line) => normalizeLine(line, rawLines)).filter(Boolean)
    : [];
  const lines = [...modelLines];
  for (const rawLine of rawLines) {
    if (!lines.some((line) => linesReferToSameText(line.rawText, rawLine) || linesReferToSameText(line.productText, rawLine))) {
      lines.push(lineFromRawText(rawLine));
    }
  }
  return JSON.stringify({
    rawText,
    lines,
  });
}

function normalizeLine(line, rawLines) {
  if (!line || typeof line !== 'object') return null;
  let rawText = stringOrEmpty(line.rawText);
  const productText = stringOrEmpty(line.productText) || rawText;
  if (isPlaceholderText(rawText) || isPlaceholderText(productText)) return null;
  if (!rawText && !productText) return null;
  const matchingRawLine = findMatchingRawLine(rawLines, rawText, productText);
  if (matchingRawLine) rawText = matchingRawLine;
  const quantity = integerOrNull(line.quantity, 1) ?? parseQuantity(rawText);
  const unitPricePesewas = integerOrNull(line.unitPricePesewas, 0) ?? parseLastMoney(rawText, quantity);
  return {
    rawText,
    productText,
    unitText: typeof line.unitText === 'string' && line.unitText.trim() ? line.unitText.trim() : null,
    quantity,
    unitPricePesewas,
    confidence: clampConfidence(line.confidence),
  };
}

function lineFromRawText(rawText) {
  const quantity = parseQuantity(rawText);
  const unitPricePesewas = parseLastMoney(rawText, quantity);
  return {
    rawText,
    productText: productFromRawText(rawText, quantity, unitPricePesewas),
    unitText: null,
    quantity,
    unitPricePesewas,
    confidence: 50,
  };
}

function productFromRawText(rawText, quantity, unitPricePesewas) {
  let product = rawText.trim();
  if (quantity != null) {
    product = product.replace(/^\s*x?\s*\d{1,4}\s+/i, '');
  }
  if (unitPricePesewas != null) {
    product = product.replace(/\s+(?:GHS|GH¢|₵)?\s*\d{1,6}(?:[,.]\d{1,2})?\s*$/i, '');
  }
  return product.trim() || rawText.trim();
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlaceholderText(value) {
  return /^(string|line one|line two|full handwritten row|product words only|full product words only)$/i.test(value.trim());
}

function integerOrNull(value, min) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) return null;
  return value;
}

function clampConfidence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function findMatchingRawLine(rawLines, rawText, productText) {
  const product = normalizeSearch(productText);
  const raw = normalizeSearch(rawText);
  return rawLines.find((line) => {
    const normalized = normalizeSearch(line);
    return (product && normalized.includes(product)) || (raw && normalized.includes(raw));
  }) || null;
}

function normalizeSearch(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function linesReferToSameText(left, right) {
  const a = normalizeSearch(left);
  const b = normalizeSearch(right);
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
}

function parseQuantity(rawText) {
  const match = rawText.match(/(?:^|\s)(?:x\s*)?(\d{1,4})(?=\s|$)/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function parseLastMoney(rawText, quantity) {
  const matches = [...rawText.matchAll(/(?:^|\s)(GHS|GH¢|₵)?\s*(\d{1,6}(?:[,.]\d{1,2})?)(?=\s|$)/gi)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const value = last[2].replace(',', '.');
  const hasCurrency = Boolean(last[1]);
  const hasDecimal = /[,.]/.test(value);
  if (matches.length === 1 && !hasCurrency && !hasDecimal && quantity != null && Number(value) === quantity) {
    return null;
  }
  const [whole, decimal = ''] = value.split('.');
  const pesewas = (Number(whole) * 100) + Number((decimal + '00').slice(0, 2));
  return Number.isInteger(pesewas) && pesewas >= 0 ? pesewas : null;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
