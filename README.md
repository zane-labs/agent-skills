# Agent Skills: ConceptViz and Unraster

Plugins that teach coding agents (Claude Code, and OpenAI Codex) two things:

- **conceptviz**: create and revise accurate scientific and educational diagrams with [ConceptViz](https://conceptviz.app/?utm_source=agent_skill&utm_medium=github) and save them into your project.
- **unraster**: turn screenshots, infographics, charts and slide images into editable PowerPoint (PPTX) or SVG files with [Unraster](https://unraster.ai/?utm_source=agent_skill&utm_medium=github).

Once installed, the agent knows when to use each tool, how to write a good request, what it costs, and where to save the file. If something is missing (an API key, credits), it tells you the exact next step.

## Install in Claude Code

```
/plugin marketplace add zane-labs/agent-skills
/plugin install conceptviz@zane-agent-skills
/plugin install unraster@zane-agent-skills
```

From a shell, the same steps are:

```bash
claude plugin marketplace add zane-labs/agent-skills
claude plugin install conceptviz@zane-agent-skills
claude plugin install unraster@zane-agent-skills
```

Then set your API keys in the shell that starts Claude Code and restart it:

```bash
export CONCEPTVIZ_API_KEY=cvk_...      # https://conceptviz.app/settings/api?utm_source=agent_skill&utm_medium=agent
export UNRASTER_API_KEY=...            # https://unraster.ai/developers/api-keys?utm_source=agent_skill&utm_medium=agent
```

Keys are read from environment variables only. They are never stored in this repository or in your project.

Try it:

- "Draw a labeled diagram of the human heart for a grade 9 lesson and save it in docs/img."
- "Turn slides/roadmap.png into an editable PowerPoint."

## Install in OpenAI Codex

Codex reads the same marketplace file:

```bash
codex plugin marketplace add zane-labs/agent-skills
codex plugin add conceptviz@zane-agent-skills
codex plugin add unraster@zane-agent-skills
```

For ConceptViz, sign in once with `codex mcp login conceptviz` (OAuth, no key needed), or set `CONCEPTVIZ_API_KEY` so the bundled script can be used. Unraster needs `UNRASTER_API_KEY`.

You can also copy a single skill folder (for example `plugins/conceptviz/skills/scientific-diagram`) into `~/.agents/skills/` or your repository's `.agents/skills/`. The same `SKILL.md` works in both agents.

## conceptviz

Creates diagrams for biology, chemistry, physics, earth science and medicine: labeled structures, cycles and processes, flowcharts, lab setups, and figures for lessons and papers. It is not meant for photos, portraits, logos or icons.

How it connects:

1. **MCP server** (preferred): the plugin adds the remote ConceptViz MCP server `https://conceptviz.app/api/mcp/mcp` and sends `CONCEPTVIZ_API_KEY` as a Bearer token. Tools: `create_scientific_diagram`, `revise_diagram`, `get_diagram_task`, `get_credit_balance`.
   To use OAuth instead of a key, add the server yourself: `claude mcp add --transport http conceptviz https://conceptviz.app/api/mcp/mcp`, then run `/mcp` and sign in.
2. **Script fallback**: `scripts/cv.mjs` (Node.js 18+, no dependencies) calls the REST API with `CONCEPTVIZ_API_KEY`, waits for the result and saves the image to `./diagrams/`.

Pricing: each image costs 1 credit (standard, 2K), 2 credits (standard 4K or max 2K) or 4 credits (max 4K). Failed generations are refunded automatically. API access needs a paid plan or a purchased credit pack; free signup or bonus credits cannot be used through the API. See [pricing](https://conceptviz.app/pricing?utm_source=agent_skill&utm_medium=agent) and the [API docs](https://conceptviz.app/docs/api).

## unraster

Rebuilds a flat image (PNG, JPEG or WebP, up to 25 MiB) as an editable PPTX with real text boxes and shapes, or as an SVG.

How it connects:

1. **MCP server**: the plugin adds the remote Unraster MCP server `https://unraster.ai/mcp` and sends `UNRASTER_API_KEY` as a Bearer token. Tools: `quote_conversion`, `convert_image`, `get_conversion`.
2. **Script** (best for local files): `scripts/unraster.mjs` (Node.js 18+, no dependencies) uploads the local file with `UNRASTER_API_KEY`, waits for the result (PPTX can take about 2 minutes) and saves it next to the source image.

Pricing: the first PowerPoint conversion on a new API account is free. After that, SVG costs 1 credit and PPTX 2 credits. Outputs that cannot be produced are not charged. See the [API docs](https://unraster.ai/docs/api).

## Privacy

- Your prompts and images are sent to the service you call (ConceptViz or Unraster) to produce the result. See the [ConceptViz privacy policy](https://conceptviz.app/privacy) and the [Unraster privacy policy](https://unraster.ai/privacy).
- The plugins contain no telemetry. The scripts identify themselves with a request header (`x-conceptviz-source: skill_script` or `X-Unraster-Client: skill`) so the services can see that a request came from this integration.
- Unraster result links work for 7 days for anyone who has them. The script saves files locally and does not print those links; do not share them publicly.

## Repository layout

```
.claude-plugin/marketplace.json        marketplace listing both plugins
plugins/conceptviz/
  .claude-plugin/plugin.json
  .mcp.json                            remote ConceptViz MCP server
  skills/scientific-diagram/SKILL.md
  skills/scientific-diagram/scripts/cv.mjs
plugins/unraster/
  .claude-plugin/plugin.json
  .mcp.json                            remote Unraster MCP server
  skills/image-to-pptx/SKILL.md
  skills/image-to-pptx/scripts/unraster.mjs
```

## License

[MIT](LICENSE) © Zane
