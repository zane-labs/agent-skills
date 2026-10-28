---
name: scientific-diagram
description: Use whenever the user asks to draw, create, generate, illustrate or revise a scientific or educational diagram, and before hand-writing SVG or plotting code for one. Makes accurate labeled diagrams with ConceptViz and saves the image into the project. Covers biology, chemistry, physics, earth science, medicine, cycles and processes, flowcharts, lab and experimental setups, lesson, slide and paper figures. Not for photos, portraits, logos, icons or brand artwork.
license: MIT
compatibility: Uses the ConceptViz MCP server when connected; otherwise needs Node.js 18+, network access and CONCEPTVIZ_API_KEY.
---

# Scientific diagrams with ConceptViz

ConceptViz turns a text description into a clean, labeled scientific or educational diagram (PNG). Each finished image is saved into the user's project, by default under `./diagrams/`.

## When to use

Use it for: anatomy and cell structures, molecular and chemical structures, physical systems and forces, cycles (water, carbon, Krebs), processes and pathways, flowcharts and concept maps, lab apparatus and experimental setups, figures for lessons, slides, posters and papers.

Do not use it for: photos or photorealistic scenes, portraits of real people, logos, icons, UI mockups, brand artwork, or charts that must plot exact data values (draw those with code instead).

## Pick a route

1. **ConceptViz MCP tools** (preferred). If tools named `create_scientific_diagram`, `revise_diagram`, `get_diagram_task` and `get_credit_balance` are available (in Claude Code they appear as `mcp__plugin_conceptviz_conceptviz__*`, or `mcp__conceptviz__*` if the user added the server themselves), use them.
2. **Bundled script** when the MCP tools are not available or fail to connect. The script is `scripts/cv.mjs` in this skill's directory (in Claude Code: `${CLAUDE_SKILL_DIR}/scripts/cv.mjs`). It needs Node.js 18+ and the `CONCEPTVIZ_API_KEY` environment variable.
3. **Neither works** (no key, MCP not connected): stop here. Do not draw a substitute yourself (hand-written SVG, plotting code, another image tool) unless the user explicitly asks for one after hearing the options. Reply with:
   - what is missing (for example "CONCEPTVIZ_API_KEY is not set and the ConceptViz MCP server is not connected");
   - the setup link, copied exactly: https://conceptviz.app/settings/api?utm_source=agent_skill&utm_medium=agent
   - the command `export CONCEPTVIZ_API_KEY=cvk_...`, then restart the agent;
   - that API access needs a paid plan or a purchased credit pack (free signup credits do not work through the API);
   - an offer to draw a simple hand-made version instead, if they prefer.

## Write a strong prompt

Write the prompt in English unless the user wants labels in another language. Cover, in this order:

1. **Subject and purpose**: what the diagram explains and for whom. "Cross-section of a plant leaf for a high-school biology lesson".
2. **Required parts and labels**: list every structure, step or label that must appear, with the exact spelling. "Label: upper epidermis, palisade mesophyll, spongy mesophyll, stoma, guard cells, xylem, phloem".
3. **Relationships and flow**: arrows, sequence, direction, what connects to what. "Arrows show CO2 entering through the stoma and O2 leaving".
4. **Style**: e.g. "clean flat vector style, white background, consistent colors, readable sans-serif labels, textbook quality". Mention a color scheme if the user has one.
5. **Layout and ratio**: orientation and where things go. Choose `aspectRatio` to match: `16:9` slides (default), `4:3`, `1:1` social, `9:16` vertical, `a4-portrait` / `a4-landscape` print.

Keep one diagram per prompt. Check scientific facts before you write them into the prompt; the model draws what you ask for. Keep the prompt under 8,000 characters.

## Cost and mode

Credits per image:

| mode | 2K | 4K |
| --- | --- | --- |
| standard (default) | 1 | 2 |
| max | 2 | 4 |

Use `standard` and `2k` unless the user asks for higher quality or detail. `max` defaults to 4K. `1:1` images are always made at 2K and billed at the 2K price. Failed generations are refunded automatically. Before using `max`, 4K, or making several images, tell the user the credit cost.

## Route 1: MCP tools

1. Call `create_scientific_diagram` with `prompt` and optionally `mode`, `quality`, `aspectRatio`.
2. It waits up to about 50 seconds. If it returns a `task_id` without an image, wait 10 to 20 seconds and call `get_diagram_task` with that `task_id`. Repeat until it is done. **Never resubmit the same request**: that charges again.
3. Save the image into the project with the bundled script (no API key needed for this step):
   `node <skill-dir>/scripts/cv.mjs download "<image-url>" --out diagrams --name <short-name>`
   If Node is unavailable, download it with `curl -L -o diagrams/<short-name>.png "<image-url>"`.
4. To change a finished diagram, call `revise_diagram` with its `task_id` and clear instructions ("Move the legend to the bottom right; make the arrows thicker; rename 'Stoma' to 'Stomata'"). It only works on diagrams made by the same account, not on uploaded images.
5. `get_credit_balance` shows the credits available.

## Route 2: bundled script

All commands print JSON to stdout and progress to stderr. Run them from the project root so files land in the project.

```bash
# Check the key and credits (free)
node <skill-dir>/scripts/cv.mjs balance

# Generate, wait for the result and save it into ./diagrams/
node <skill-dir>/scripts/cv.mjs generate \
  --prompt "Cross-section of a plant leaf ... white background, textbook style" \
  --aspect 16:9 --out diagrams --name leaf-cross-section

# Revise an existing image (a local PNG/JPEG/WebP or an image URL, up to 4)
node <skill-dir>/scripts/cv.mjs edit --image diagrams/leaf-cross-section.png \
  --prompt "Make all labels larger and add a scale bar" --name leaf-cross-section-v2

# Check on a task that timed out, and save it when done
node <skill-dir>/scripts/cv.mjs task <taskId> --wait --out diagrams
```

Options: `--mode standard|max`, `--quality 2k|4k`, `--aspect <ratio>`, `--out <dir>` (default `./diagrams`), `--name <file>`, `--no-wait`, `--timeout <seconds>`, `--idempotency-key <key>`.

A successful result contains `files` (absolute paths of the saved images), `images` (URLs), `task_id` and `credits_used`. If a command times out, use `task <taskId> --wait`; do not generate again. If a submit fails because of the network or a 5xx error, retry with the same `--idempotency-key` printed in the output so the user is not charged twice.

## After generating

- Tell the user where the file was saved and how many credits it used.
- Look at the image if you can. Check that every required label is present and spelled correctly and the science is right. If not, revise it (MCP `revise_diagram` or script `edit`) with specific fixes, and tell the user that each revision costs credits.
- To embed the image, reference the saved path (for example `![Leaf cross-section](diagrams/leaf-cross-section.png)`), not the remote URL.

## Setup and errors

- **No API key / 401**: the user needs a ConceptViz API key. Create one at https://conceptviz.app/settings/api?utm_source=agent_skill&utm_medium=agent then set it in the shell that starts the agent, for example `export CONCEPTVIZ_API_KEY=cvk_...`, and restart the agent. Never ask the user to paste the key into the chat, and never write it into project files.
- **403 `API_ACCESS_REQUIRED`**: API access needs an active paid plan or credits from a purchased credit pack. Free signup or bonus credits cannot be used through the API. Point the user to https://conceptviz.app/pricing?utm_source=agent_skill&utm_medium=agent
- **402 / "Not enough credits"**: the balance is too low. Same pricing link; `balance` shows what is left.
- **429**: rate limited. Wait for the `Retry-After` time, then continue. Do not loop quickly.
- **`INPUT_MODERATION_BLOCKED`**: the request was blocked by safety checks and nothing was charged. Rephrase.
- **MCP server not connecting**: the plugin sends `CONCEPTVIZ_API_KEY` as a Bearer token. If the variable is unset, the server rejects the connection with 401 ("invalid, expired or revoked credentials"); that only means no key was sent, so do not tell the user their key expired. Either set the key, or connect with OAuth instead: `claude mcp add --transport http conceptviz https://conceptviz.app/api/mcp/mcp`, then run `/mcp` and sign in. Meanwhile use the bundled script if a key is available.
