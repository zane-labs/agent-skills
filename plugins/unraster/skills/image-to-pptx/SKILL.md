---
name: image-to-pptx
description: Use whenever the user wants an image of a slide, infographic, chart, diagram, poster or screenshot turned into an editable PowerPoint (PPTX) or SVG, and before rebuilding it by hand with code. Converts the PNG, JPEG or WebP with Unraster and saves the file next to the source image. Not for photos that should stay photos, multi-page PDFs, or new slides from scratch.
license: MIT
compatibility: Needs Node.js 18+, network access and UNRASTER_API_KEY.
---

# Image to editable PPTX or SVG with Unraster

Unraster rebuilds a flat image as an editable file: a PowerPoint with real text boxes and shapes, or an SVG with vector paths. The result is saved into the user's project, by default next to the source image with the same name and the new extension.

## When to use

Use it for: screenshots of slides, infographics, charts and graphs, flowcharts and diagrams, posters and flyers, whiteboard-style graphics, AI-generated diagrams the user wants to edit.

Do not use it for: photos meant to stay photographic, PDFs or multi-page documents (export a page to PNG first), animated images, or building a new presentation from text (write the PPTX with code instead).

Pick the output:
- **PPTX** (default): the user wants to change words, move boxes, or reuse the content in PowerPoint, Keynote or Google Slides.
- **SVG**: the user wants a scalable vector graphic for the web, print or a design tool.
- **Both**: only if the user asks; it costs more.

## Cost and limits

- SVG = 1 credit, PPTX = 2 credits, both = 3. Only outputs that are ready to download are charged; failed or unavailable outputs are not.
- Checking credits, checking progress and downloading are free.
- Input: one static PNG, JPEG or WebP, up to 25 MiB and 25 million pixels.
- PPTX conversions can take about 2 minutes.

## How to convert

Use the bundled script `scripts/unraster.mjs` in this skill's directory (in Claude Code: `${CLAUDE_SKILL_DIR}/scripts/unraster.mjs`). It needs Node.js 18+ and the `UNRASTER_API_KEY` environment variable, uploads the local file directly, waits for the result and downloads it. Run it from the project root.

```bash
# Check the key and credits (free)
node <skill-dir>/scripts/unraster.mjs quote

# Convert to PPTX; saves slides/overview.pptx next to slides/overview.png
node <skill-dir>/scripts/unraster.mjs convert slides/overview.png

# SVG instead, or both formats into a folder
node <skill-dir>/scripts/unraster.mjs convert chart.webp --outputs svg
node <skill-dir>/scripts/unraster.mjs convert poster.jpg --outputs svg,pptx --out exports/

# Check on a conversion that timed out, and download it when ready
node <skill-dir>/scripts/unraster.mjs get <conversionId> --wait --out exports/
```

Options: `--outputs pptx|svg|svg,pptx` (default `pptx`), `--out <file-or-dir>`, `--no-wait`, `--timeout <seconds>`, `--idempotency-key <key>`.

All commands print JSON to stdout and progress to stderr. A successful result lists `files` with each saved `path` and `format`.

If the key is missing or the script fails, stop. Do not rebuild the slide by hand with python-pptx or other code unless the user asks for that after hearing the options. Tell the user what is missing, give the setup link exactly as written under "Setup and errors", and offer the manual route as an alternative.

If the image is only at a URL, download it into the project first (for example `curl -L -o source.png "<url>"`), then convert the local file.

Rules:
- If `convert` times out, run `get <conversionId> --wait`. Do not upload the same image again; that is charged again.
- If an upload fails because of the network or a 503, the script retries with the same idempotency key. If it still fails, retry the same command with `--idempotency-key <key>` from the error output.
- Status `needs_review` means some outputs could not be produced reliably. Ready outputs are still downloaded and charged; unavailable ones are free. Tell the user which formats are missing.

## Privacy

Finished files are served from links that work for 7 days without an API key. Anyone holding a link can download the file. The script saves the files locally and does not print these links. Do not paste result links into public places, commits, issues or chat logs.

## After converting

- Tell the user the saved path(s) and the credits used.
- Mention that complex artwork, photos inside the image, or unusual fonts may come out as pictures or need small manual fixes.

## Setup and errors

- **No API key / 401**: the user needs an Unraster API key with `conversions:read` and `conversions:write`. Create one at https://unraster.ai/developers/api-keys?utm_source=agent_skill&utm_medium=agent then set it in the shell that starts the agent, for example `export UNRASTER_API_KEY=...`, and restart the agent. Never ask the user to paste the key into the chat, and never write it into project files.
- **403**: the key lacks a permission. Create a key with both permissions.
- **402**: not enough credits. The user can buy credits at https://unraster.ai/?utm_source=agent_skill&utm_medium=agent#pricing
- **413 / 415**: the file is too large or not a PNG, JPEG or WebP. Resize or re-export it.
- **409**: the idempotency key was already used with a different file or format. Run without `--idempotency-key`.
- **429 / 503**: wait for the `Retry-After` time and retry.
