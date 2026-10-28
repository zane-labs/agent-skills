#!/usr/bin/env node
// Unraster command-line helper. Zero dependencies, Node.js 18+.
// API reference: https://unraster.ai/docs/api

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const BASE = (process.env.UNRASTER_API_BASE || "https://unraster.ai").replace(/\/+$/, "");
const KEY_URL = "https://unraster.ai/developers/api-keys?utm_source=agent_skill&utm_medium=agent";
const PRICING_URL = "https://unraster.ai/?utm_source=agent_skill&utm_medium=agent#pricing";
const CLIENT_HEADER = { "X-Unraster-Client": "skill" };
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const FORMATS = ["svg", "pptx"];
const TERMINAL = new Set(["completed", "needs_review", "failed", "deleted"]);

const HELP = `Unraster CLI: turn an image (slide, infographic, chart, poster) into editable PPTX or SVG.

Usage:
  node unraster.mjs quote
  node unraster.mjs convert <image> [--outputs pptx|svg|svg,pptx] [--out <path>] [options]
  node unraster.mjs get <conversionId> [--wait] [--out <path>]

Options for convert:
  --outputs <list>           pptx (default), svg, or svg,pptx
  --out <path>               output file (single format) or directory (default: next to the input,
                             same name, new extension)
  --no-wait                  upload and print the conversion id without waiting
  --timeout <seconds>        max wait for the result (default: 600)
  --idempotency-key <key>    reuse the key from a failed attempt so a retry is not charged twice

Credits: SVG = 1, PPTX = 2, both = 3. Unavailable outputs are not charged.
Input: one static PNG, JPEG or WebP, up to 25 MiB and 25 million pixels.
Result links stay valid for 7 days and anyone with the link can download the file. Keep them private.

Environment:
  UNRASTER_API_KEY  required. Create one at ${KEY_URL}
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; i++; }
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
  const body = { ok: false, error: { code: err.code || "ERROR", message: err.message, ...(err.extra || {}) } };
  process.stderr.write(`Error: ${err.message}\n`);
  if (err.extra?.next_step) process.stderr.write(`Next step: ${err.extra.next_step}\n`);
  process.stdout.write(JSON.stringify(body, null, 2) + "\n");
  process.exit(err.code === "USAGE" ? 2 : 1);
}

function requireKey() {
  const key = (process.env.UNRASTER_API_KEY || "").trim();
  if (!key) {
    throw new CliError("MISSING_API_KEY", "UNRASTER_API_KEY is not set.", {
      next_step: `Create an API key at ${KEY_URL} and export UNRASTER_API_KEY=<your key>.`,
    });
  }
  return key;
}

function explainHttpError(status, data, headers, idempotencyKey) {
  const code = data?.error?.code || `http_${status}`;
  const message = data?.error?.message || `Request failed with HTTP ${status}.`;
  const extra = { http_status: status };
  if (status === 401) extra.next_step = `The API key is missing or invalid. Create a key at ${KEY_URL}`;
  else if (status === 403) extra.next_step = `This key lacks the needed permission (conversions:read to check, conversions:write to convert). Create a key with both at ${KEY_URL}`;
  else if (status === 402) extra.next_step = `Not enough credits. Buy credits at ${PRICING_URL}`;
  else if (status === 409) extra.next_step = "This idempotency key was already used with a different file or outputs. Drop --idempotency-key to start a new conversion.";
  else if (status === 413) extra.next_step = "The image is too large. Use an image up to 25 MiB and 25 million pixels.";
  else if (status === 415) extra.next_step = "Unsupported format. Use a static PNG, JPEG or WebP.";
  else if (status === 429) {
    const retry = headers?.get?.("retry-after");
    if (retry) extra.retry_after_seconds = Number(retry);
    extra.next_step = `Rate limited. Wait ${retry || "a few"} seconds before retrying.`;
  } else if (status >= 500) {
    extra.next_step = idempotencyKey
      ? `Server busy. Retry later with --idempotency-key ${idempotencyKey} so you are not charged twice.`
      : "Server busy. Retry later.";
  }
  return new CliError(code, message, extra);
}

async function api(method, path, { key, form, idempotencyKey } = {}) {
  const headers = { ...CLIENT_HEADER, Accept: "application/json", Authorization: `Bearer ${key}` };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let res;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, body: form });
  } catch (e) {
    throw new CliError("network_error", `Could not reach Unraster: ${e.cause?.message || e.message}`, {
      next_step: idempotencyKey
        ? `Check your connection and retry with --idempotency-key ${idempotencyKey}.`
        : "Check your connection and retry.",
    });
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: { message: text.slice(0, 300) } }; }
  if (!res.ok) throw explainHttpError(res.status, data, res.headers, idempotencyKey);
  return { data, status: res.status };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseOutputs(value) {
  const list = String(value === undefined || value === true ? "pptx" : value)
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unique = [...new Set(list)];
  if (!unique.length || unique.some((f) => !FORMATS.includes(f))) {
    throw new CliError("USAGE", '--outputs must be "pptx", "svg" or "svg,pptx".');
  }
  return FORMATS.filter((f) => unique.includes(f));
}

async function pollConversion(key, id, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = "";
  let delay = 3000;
  while (Date.now() < deadline) {
    let data;
    try {
      ({ data } = await api("GET", `/v1/conversions/${encodeURIComponent(id)}`, { key }));
    } catch (e) {
      if (e.extra?.retry_after_seconds) { await sleep(e.extra.retry_after_seconds * 1000); continue; }
      if (e.code === "network_error" || (e.extra?.http_status ?? 0) >= 500) { await sleep(delay); continue; }
      throw e;
    }
    const label = data.stage ? `${data.status} (${data.stage})` : data.status;
    if (label !== last) { process.stderr.write(`Conversion ${id}: ${label}\n`); last = label; }
    if (TERMINAL.has(data.status)) return data;
    await sleep(delay);
    delay = Math.min(delay + 1000, 8000);
  }
  throw new CliError("timeout", `Conversion ${id} did not finish within ${timeoutSec} seconds.`, {
    conversion_id: id,
    next_step: `Check again later with: node unraster.mjs get ${id} --wait. Do not upload again; that would be charged again.`,
  });
}

function targetPath(format, { input, out, multi }) {
  if (typeof out === "string") {
    const looksLikeFile = extname(out).toLowerCase() === `.${format}`;
    if (!multi && looksLikeFile) return resolve(out);
    if (!multi && extname(out) && !looksLikeFile) {
      throw new CliError("USAGE", `--out "${out}" does not end in .${format}. Pass a .${format} path or a directory.`);
    }
    const stem = input ? basename(input, extname(input)) : "unraster";
    return resolve(join(out, `${stem}.${format}`));
  }
  if (input) return resolve(join(dirname(input), `${basename(input, extname(input))}.${format}`));
  return resolve(`unraster.${format}`);
}

async function downloadOutput(output, key, dest) {
  const url = new URL(output.url, BASE);
  const headers = { ...CLIENT_HEADER };
  // Relative links are account-authenticated; the key must only ever go to the API origin.
  if (url.origin === new URL(BASE).origin) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(url, { headers }).catch((e) => {
    throw new CliError("download_failed", `Could not download the ${output.format}: ${e.cause?.message || e.message}`);
  });
  if (!res.ok) {
    throw new CliError("download_failed", `Downloading the ${output.format} failed with HTTP ${res.status}.`, {
      next_step: "Fetch the conversion again with `get <id> --out <path>` to refresh the link.",
    });
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

async function collect(task, key, { input, out }) {
  const outputs = task.outputs || [];
  const ready = outputs.filter((o) => o.status === "ready" && o.url);
  const multi = outputs.length > 1;
  const files = [];
  for (const o of ready) {
    let dest = targetPath(o.format, { input, out, multi });
    if (input && resolve(input) === dest) dest = dest.replace(/(\.[^.]+)$/, `-unraster$1`);
    files.push({ format: o.format, path: await downloadOutput(o, key, dest), expires_at: o.expires_at });
  }
  const summary = {
    ok: task.status === "completed" || (task.status === "needs_review" && files.length > 0),
    conversion_id: task.id,
    status: task.status,
    files,
    outputs: outputs.map((o) => ({ format: o.format, status: o.status, ...(o.expires_at ? { expires_at: o.expires_at } : {}) })),
  };
  if (task.status === "needs_review") {
    summary.note = "Some outputs could not be produced reliably. Only ready outputs were downloaded and charged.";
  }
  if (task.status === "failed") {
    summary.error = task.error || { code: "conversion_failed", message: "The conversion failed. Nothing was charged for unavailable outputs." };
    summary.next_step = "Try a sharper or larger source image, or a different output format.";
  }
  if (files.length) {
    summary.privacy = "Download links stay valid for 7 days and work for anyone who has them. Do not share them publicly.";
  }
  return summary;
}

async function cmdQuote() {
  const key = requireKey();
  const { data } = await api("GET", "/v1/conversions/quote", { key });
  const out = { ok: true, ...data };
  if (data.available_credits !== undefined && data.prices && data.available_credits < Math.min(...Object.values(data.prices))) {
    out.next_step = `Not enough credits for a conversion. Buy credits at ${PRICING_URL}`;
  }
  return out;
}

async function cmdConvert(positional, flags) {
  const input = positional[0] || flags.file;
  if (!input || typeof input !== "string") throw new CliError("USAGE", "Usage: node unraster.mjs convert <image> [--outputs pptx] [--out <path>]");
  if (/^https?:\/\//i.test(input)) {
    throw new CliError("USAGE", "convert takes a local file. Download the image first, then pass its path.");
  }
  if (!existsSync(input) || !statSync(input).isFile()) throw new CliError("USAGE", `File not found: ${input}`);
  const ext = extname(input).toLowerCase();
  if (!MIME[ext]) throw new CliError("USAGE", `Unsupported file type "${ext || "(none)"}". Use a PNG, JPEG or WebP image.`);
  const size = statSync(input).size;
  if (size > MAX_UPLOAD_BYTES) throw new CliError("USAGE", `The image is ${(size / 1048576).toFixed(1)} MiB; the limit is 25 MiB.`);
  const outputs = parseOutputs(flags.outputs);
  if (typeof flags.out === "string" && outputs.length > 1 && extname(flags.out)) {
    throw new CliError("USAGE", "With more than one output format, --out must be a directory.");
  }
  if (typeof flags.out === "string") targetPath(outputs[0], { input, out: flags.out, multi: outputs.length > 1 });
  const key = requireKey();
  const idem = typeof flags["idempotency-key"] === "string" ? flags["idempotency-key"] : randomUUID();

  const form = () => {
    const f = new FormData();
    f.append("file", new Blob([readFileSync(input)], { type: MIME[ext] }), basename(input));
    f.append("outputs", outputs.join(","));
    return f;
  };
  let created;
  for (let attempt = 1; ; attempt++) {
    try {
      ({ data: created } = await api("POST", "/v1/conversions", { key, form: form(), idempotencyKey: idem }));
      break;
    } catch (e) {
      const transient = e.code === "network_error" || e.extra?.http_status === 503;
      if (!transient || attempt >= 3) throw e;
      await sleep((e.extra?.retry_after_seconds || 2 * attempt) * 1000);
    }
  }
  process.stderr.write(`Uploaded ${basename(input)} as conversion ${created.id} (idempotency key ${idem}).\n`);
  if (flags["no-wait"]) {
    return {
      ok: true,
      conversion_id: created.id,
      status: created.status,
      idempotency_key: idem,
      next_step: `Check with: node unraster.mjs get ${created.id} --wait --out <path>`,
    };
  }
  if (outputs.includes("pptx")) process.stderr.write("PPTX conversions can take about 2 minutes.\n");
  const timeout = Number(flags.timeout) > 0 ? Number(flags.timeout) : 600;
  const task = TERMINAL.has(created.status) ? created : await pollConversion(key, created.id, timeout);
  return { ...(await collect(task, key, { input, out: flags.out })), idempotency_key: idem };
}

async function cmdGet(positional, flags) {
  const id = positional[0] || flags.id;
  if (!id || typeof id !== "string") throw new CliError("USAGE", "Usage: node unraster.mjs get <conversionId> [--wait] [--out <path>]");
  const key = requireKey();
  let task;
  if (flags.wait) {
    const timeout = Number(flags.timeout) > 0 ? Number(flags.timeout) : 600;
    task = await pollConversion(key, id, timeout);
  } else {
    ({ data: task } = await api("GET", `/v1/conversions/${encodeURIComponent(id)}`, { key }));
  }
  if (!TERMINAL.has(task.status) || task.status === "deleted" || (!flags.wait && flags.out === undefined)) {
    const ok = task.status !== "failed" && task.status !== "deleted";
    return { ok, ...task, outputs: (task.outputs || []).map(({ url, ...rest }) => ({ ...rest, has_link: Boolean(url) })) };
  }
  return collect(task, key, { input: null, out: typeof flags.out === "string" ? flags.out : "." });
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
    case "quote": result = await cmdQuote(); break;
    case "convert": result = await cmdConvert(positional, flags); break;
    case "get": result = await cmdGet(positional, flags); break;
    default: throw new CliError("USAGE", `Unknown command "${cmd}". Run: node unraster.mjs --help`);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result && result.ok === false) process.exit(1);
}

main().catch((e) => fail(e instanceof CliError ? e : new CliError("unexpected", e?.message || String(e))));
