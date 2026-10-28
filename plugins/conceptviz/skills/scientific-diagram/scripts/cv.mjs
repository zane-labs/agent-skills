#!/usr/bin/env node
// ConceptViz command-line helper. Zero dependencies, Node.js 18+.
// API reference: https://conceptviz.app/docs/api

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const BASE = (process.env.CONCEPTVIZ_API_BASE || "https://conceptviz.app/api/v1").replace(/\/+$/, "");
const KEY_URL = "https://conceptviz.app/settings/api?utm_source=agent_skill&utm_medium=agent";
const PRICING_URL = "https://conceptviz.app/pricing?utm_source=agent_skill&utm_medium=agent";
const SOURCE_HEADER = { "x-conceptviz-source": "skill_script" };
const POLL_MS = 4000;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

const HELP = `ConceptViz CLI: create scientific and educational diagrams.

Usage:
  node cv.mjs generate --prompt "<text>" [options]
  node cv.mjs edit --prompt "<instructions>" --image <file-or-url> [--image ...] [options]
  node cv.mjs task <taskId> [--wait] [--out <dir>]
  node cv.mjs balance
  node cv.mjs download <imageUrl> [--out <dir>] [--name <file>]

Options for generate and edit:
  --mode standard|max        default: standard
  --quality 2k|4k            default: 2k (max mode defaults to 4k; 1:1 is always 2k)
  --aspect <ratio>           16:9 (default), 4:3, 1:1, 9:16, a4-portrait, a4-landscape
  --out <dir>                where images are saved (default: ./diagrams)
  --name <file>              base file name without extension (default: from the prompt)
  --no-wait                  submit and print the task id without waiting
  --timeout <seconds>        max wait for the result (default: 600)
  --idempotency-key <key>    reuse a key to retry safely without being charged twice

Credits per image: standard 2K = 1, standard 4K = 2, max 2K = 2, max 4K = 4.
Failed generations are refunded automatically.

Environment:
  CONCEPTVIZ_API_KEY  required for every command except download.
                      Create one at ${KEY_URL}
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      let key, value;
      if (eq !== -1) { key = a.slice(2, eq); value = a.slice(eq + 1); }
      else {
        key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) value = true;
        else { value = next; i++; }
      }
      if (key === "image") (flags.image ||= []).push(value);
      else flags[key] = value;
    } else if (a === "-h") flags.help = true;
    else positional.push(a);
  }
  return { positional, flags };
}

class CliError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

function fail(err) {
  const body = {
    ok: false,
    error: { code: err.code || "ERROR", message: err.message, ...(err.extra || {}) },
  };
  process.stderr.write(`Error: ${err.message}\n`);
  if (err.extra?.next_step) process.stderr.write(`Next step: ${err.extra.next_step}\n`);
  process.stdout.write(JSON.stringify(body, null, 2) + "\n");
  process.exit(err.code === "USAGE" ? 2 : 1);
}

function requireKey() {
  const key = (process.env.CONCEPTVIZ_API_KEY || "").trim();
  if (!key) {
    throw new CliError("MISSING_API_KEY", "CONCEPTVIZ_API_KEY is not set.", {
      next_step: `Create an API key at ${KEY_URL} and export CONCEPTVIZ_API_KEY=cvk_... (API access needs a paid plan or a purchased credit pack).`,
    });
  }
  return key;
}

function explainHttpError(status, data, headers) {
  const code = data?.code || `HTTP_${status}`;
  const message = data?.error || data?.message || `Request failed with HTTP ${status}.`;
  const extra = { http_status: status };
  if (status === 401) {
    extra.next_step = `The API key is missing, invalid or revoked. Create a new key at ${KEY_URL}`;
  } else if (status === 402) {
    if (data?.credits_remaining !== undefined) extra.credits_remaining = data.credits_remaining;
    extra.next_step = `Not enough credits. Buy a credit pack or upgrade at ${PRICING_URL}`;
  } else if (status === 403 && code === "API_ACCESS_REQUIRED") {
    extra.next_step = `API access needs an active paid plan or credits from a purchased credit pack (free signup or bonus credits cannot be used through the API). See ${PRICING_URL}`;
  } else if (status === 429) {
    const retry = headers?.get?.("retry-after");
    if (retry) extra.retry_after_seconds = Number(retry);
    extra.next_step = `Rate limited (${code}). Wait ${retry || "a few"} seconds and try again; do not resubmit in a tight loop.`;
  } else if (code === "INPUT_MODERATION_BLOCKED") {
    extra.next_step = "The prompt or image was blocked by safety checks. Nothing was charged. Rephrase the request.";
  } else if (status >= 500) {
    extra.next_step = "Server error. Retry shortly with the same --idempotency-key so you are not charged twice.";
  }
  return new CliError(code, message, extra);
}

async function api(method, path, { key, json, form, idempotencyKey } = {}) {
  const headers = { ...SOURCE_HEADER, Accept: "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let body;
  if (json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
  else if (form) body = form;
  let res;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, body });
  } catch (e) {
    throw new CliError("NETWORK_ERROR", `Could not reach ConceptViz: ${e.cause?.message || e.message}`, {
      next_step: "Check your internet connection and retry (reuse the same --idempotency-key for generate/edit).",
    });
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 300) }; }
  if (!res.ok) throw explainHttpError(res.status, data, res.headers);
  return { data, headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollTask(key, taskId, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = "pending";
  while (Date.now() < deadline) {
    let data;
    try {
      ({ data } = await api("GET", `/task/${encodeURIComponent(taskId)}`, { key }));
    } catch (e) {
      if (e.code === "RATE_LIMITED" && e.extra?.retry_after_seconds) {
        await sleep(e.extra.retry_after_seconds * 1000);
        continue;
      }
      if (e.code === "NETWORK_ERROR") { await sleep(POLL_MS); continue; }
      throw e;
    }
    if (data.status !== last) {
      process.stderr.write(`Task ${taskId}: ${data.status}\n`);
      last = data.status;
    }
    if (data.status === "completed" || data.status === "failed") return data;
    await sleep(POLL_MS);
  }
  throw new CliError("TIMEOUT", `Task ${taskId} did not finish within ${timeoutSec} seconds.`, {
    task_id: taskId,
    next_step: `Check again later with: node cv.mjs task ${taskId} --wait. Do not resubmit; that would be charged again.`,
  });
}

function slugify(s, fallback = "diagram") {
  const slug = String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || fallback;
}

function extFor(url, contentType) {
  const ct = (contentType || "").split(";")[0].trim();
  if (ct === "image/png") return ".png";
  if (ct === "image/jpeg") return ".jpg";
  if (ct === "image/webp") return ".webp";
  if (ct === "image/svg+xml") return ".svg";
  try {
    const e = extname(new URL(url).pathname).toLowerCase();
    if (e) return e;
  } catch {}
  return ".png";
}

function uniquePath(dir, base, ext) {
  let p = join(dir, `${base}${ext}`);
  for (let n = 2; existsSync(p); n++) p = join(dir, `${base}-${n}${ext}`);
  return p;
}

async function downloadTo(url, dir, base) {
  const res = await fetch(url, { headers: SOURCE_HEADER }).catch((e) => {
    throw new CliError("DOWNLOAD_FAILED", `Could not download ${url}: ${e.cause?.message || e.message}`);
  });
  if (!res.ok) throw new CliError("DOWNLOAD_FAILED", `Download failed with HTTP ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dir, { recursive: true });
  const file = uniquePath(dir, base, extFor(url, res.headers.get("content-type")));
  writeFileSync(file, buf);
  return resolve(file);
}

async function saveImages(task, outDir, baseName) {
  const images = task.images || [];
  const files = [];
  for (let i = 0; i < images.length; i++) {
    const base = images.length > 1 ? `${baseName}-${i + 1}` : baseName;
    files.push(await downloadTo(images[i].url, outDir, base));
  }
  return files;
}

function generationOptions(flags) {
  const opts = {};
  if (flags.mode) opts.mode = String(flags.mode).toLowerCase();
  if (flags.quality) opts.quality = String(flags.quality).toLowerCase();
  if (flags.aspect || flags.aspectRatio) opts.aspectRatio = String(flags.aspect || flags.aspectRatio);
  if (opts.mode && !["standard", "max"].includes(opts.mode)) {
    throw new CliError("USAGE", `--mode must be "standard" or "max" (got "${opts.mode}").`);
  }
  if (opts.quality && !["2k", "4k"].includes(opts.quality)) {
    throw new CliError("USAGE", `--quality must be "2k" or "4k" (got "${opts.quality}").`);
  }
  return opts;
}

function requirePrompt(flags) {
  const prompt = typeof flags.prompt === "string" ? flags.prompt.trim() : "";
  if (!prompt) throw new CliError("USAGE", 'Missing --prompt "<text>".');
  if (prompt.length > 8000) throw new CliError("USAGE", "The prompt is longer than 8,000 characters. Shorten it.");
  return prompt;
}

async function finish(key, submitted, flags, baseName) {
  const summary = {
    ok: true,
    task_id: submitted.taskId,
    model: submitted.model,
    mode: submitted.mode,
    quality: submitted.quality,
    aspect_ratio: submitted.aspect_ratio,
    credits_used: submitted.credits_used,
    credits_remaining: submitted.credits_remaining,
  };
  if (submitted.notice) summary.notice = submitted.notice;
  if (flags["no-wait"]) {
    summary.status = submitted.status;
    summary.next_step = `Poll with: node cv.mjs task ${submitted.taskId} --wait`;
    return summary;
  }
  const timeout = Number(flags.timeout) > 0 ? Number(flags.timeout) : 600;
  const task = await pollTask(key, submitted.taskId, timeout);
  summary.status = task.status;
  if (task.status === "failed") {
    return {
      ...summary,
      ok: false,
      error: { code: task.code || "GENERATION_FAILED", message: task.error || "Generation failed." },
      credits_refunded: task.credits_refunded ?? true,
      next_step: "Credits were refunded. Adjust the prompt and try again.",
    };
  }
  summary.images = (task.images || []).map((i) => i.url);
  summary.files = await saveImages(task, resolve(flags.out || "diagrams"), baseName);
  return summary;
}

async function cmdGenerate(flags) {
  const prompt = requirePrompt(flags);
  const opts = generationOptions(flags);
  const key = requireKey();
  const idem = typeof flags["idempotency-key"] === "string" ? flags["idempotency-key"] : randomUUID();
  const { data } = await api("POST", "/generate", { key, json: { prompt, ...opts }, idempotencyKey: idem });
  process.stderr.write(`Submitted task ${data.taskId} (${data.credits_used} credit(s), idempotency key ${idem}).\n`);
  const baseName = typeof flags.name === "string" ? slugify(flags.name) : slugify(prompt);
  return { ...(await finish(key, data, flags, baseName)), idempotency_key: idem };
}

async function cmdEdit(flags) {
  const prompt = requirePrompt(flags);
  const opts = generationOptions(flags);
  const inputs = (flags.image || []).filter((v) => typeof v === "string" && v);
  if (!inputs.length) throw new CliError("USAGE", "Missing --image <file-or-url> (repeat for up to 4 images).");
  if (inputs.length > 4) throw new CliError("USAGE", "At most 4 --image inputs are allowed.");
  const isUrl = (v) => /^(https?:|data:image\/)/i.test(v);
  const locals = inputs.filter((v) => !isUrl(v));
  for (const p of locals) {
    if (!existsSync(p)) throw new CliError("USAGE", `Image file not found: ${p}`);
    const ext = extname(p).toLowerCase();
    if (!MIME[ext]) throw new CliError("USAGE", `Unsupported image type "${ext}". Use PNG, JPEG or WebP.`);
    if (statSync(p).size > MAX_UPLOAD_BYTES) throw new CliError("USAGE", `Image is larger than 20 MB: ${p}`);
  }
  const key = requireKey();
  const idem = typeof flags["idempotency-key"] === "string" ? flags["idempotency-key"] : randomUUID();
  let req;
  if (locals.length) {
    const form = new FormData();
    form.append("prompt", prompt);
    for (const [k, v] of Object.entries(opts)) form.append(k, v);
    for (const v of inputs) {
      if (isUrl(v)) {
        throw new CliError("USAGE", "Do not mix local files and URLs in one edit. Use only files or only URLs.");
      }
      const blob = new Blob([readFileSync(v)], { type: MIME[extname(v).toLowerCase()] });
      form.append("image", blob, basename(v));
    }
    req = { key, form, idempotencyKey: idem };
  } else {
    req = { key, json: { prompt, images: inputs, ...opts }, idempotencyKey: idem };
  }
  const { data } = await api("POST", "/edit", req);
  process.stderr.write(`Submitted edit task ${data.taskId} (${data.credits_used} credit(s), idempotency key ${idem}).\n`);
  const baseName = typeof flags.name === "string" ? slugify(flags.name) : `${slugify(prompt, "edit")}-edit`;
  return { ...(await finish(key, data, flags, baseName)), idempotency_key: idem };
}

async function cmdTask(positional, flags) {
  const taskId = positional[0] || flags.id;
  if (!taskId) throw new CliError("USAGE", "Usage: node cv.mjs task <taskId> [--wait] [--out <dir>]");
  const key = requireKey();
  let task;
  if (flags.wait) {
    const timeout = Number(flags.timeout) > 0 ? Number(flags.timeout) : 600;
    task = await pollTask(key, taskId, timeout);
  } else {
    ({ data: task } = await api("GET", `/task/${encodeURIComponent(taskId)}`, { key }));
  }
  const out = { ok: task.status !== "failed", task_id: taskId, ...task };
  if (task.status === "completed" && (flags.wait || flags.out)) {
    const baseName = typeof flags.name === "string" ? slugify(flags.name) : slugify(task.images?.[0]?.prompt || taskId);
    out.files = await saveImages(task, resolve(typeof flags.out === "string" ? flags.out : "diagrams"), baseName);
  }
  return out;
}

async function cmdBalance() {
  const key = requireKey();
  const { data } = await api("GET", "/balance", { key });
  const out = { ok: true, ...data };
  if (data.api_access === false) {
    out.next_step = `This account no longer has API access. Subscribe or buy a credit pack at ${PRICING_URL}`;
  } else if (data.credits_available === 0) {
    out.next_step = `No credits left. Buy a credit pack or upgrade at ${PRICING_URL}`;
  }
  return out;
}

async function cmdDownload(positional, flags) {
  const url = positional[0] || flags.url;
  if (!url || !/^https?:\/\//i.test(url)) throw new CliError("USAGE", "Usage: node cv.mjs download <imageUrl> [--out <dir>] [--name <file>]");
  let base = typeof flags.name === "string" ? slugify(flags.name) : "";
  if (!base) {
    try { base = slugify(basename(new URL(url).pathname, extname(new URL(url).pathname))); } catch { base = "diagram"; }
  }
  const file = await downloadTo(url, resolve(typeof flags.out === "string" ? flags.out : "diagrams"), base);
  return { ok: true, url, files: [file] };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h" || flags.help) {
    process.stdout.write(HELP);
    return;
  }
  let result;
  switch (cmd) {
    case "generate": result = await cmdGenerate(flags); break;
    case "edit": result = await cmdEdit(flags); break;
    case "task": result = await cmdTask(positional, flags); break;
    case "balance": result = await cmdBalance(); break;
    case "download": result = await cmdDownload(positional, flags); break;
    default: throw new CliError("USAGE", `Unknown command "${cmd}". Run: node cv.mjs --help`);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result && result.ok === false) process.exit(1);
}

main().catch((e) => fail(e instanceof CliError ? e : new CliError("UNEXPECTED", e?.message || String(e))));
