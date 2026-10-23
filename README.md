# OpenCode Free Tier — OpenAI-compatible proxy

**Repository:** <https://github.com/AR-92/opencode-free-proxy>

This project runs a small local server that exposes OpenCode's **free
models** through a standard **OpenAI-compatible API**.

- **Local base URL:** `http://127.0.0.1:8787/v1`
- **LAN base URL:** `http://192.168.100.219:8787/v1`
- **API key:** required — stored in `.env` as `PROXY_API_KEY`
- **Models:** `deepseek-v4.1-flash-free`, `glm-5.3-flash-free`, `big-pickle`,
  `flint-40b-free`, `nemotron-3.5-super-vl-free`, `beam-free`,
  `mimo-v2.6-flash-free`, `nemotron-3.5-lightning-free`,
  `nemotron-3-ultra-free`

## How it works

OpenCode's free tier is served from:

```
https://opencode.ai/inference/openai/v1
```

That endpoint is already OpenAI-compatible, but it rejects requests that do
not look like they came from the OpenCode client. I sniffed real OpenCode
traffic through a local TLS proxy and found the three requirements:

1. **OpenCode headers**
   - `User-Agent: opencode/latest/<version>/cli`
   - `x-opencode-client: cli`
   - `x-opencode-project`, `x-opencode-session`, `x-opencode-session-id`,
     `x-session-affinity`, `x-session-id`
   - `x-opencode-session` must be exactly `ses_` + 12 hex + 14 base62 chars
     (30 characters total), otherwise the server returns `403 FreeTierError`.
2. **`"stream": true`** — non-streaming requests are rejected.
3. **At least one recognized tool definition** in `tools` (e.g. `read`).

The proxy adds all of that automatically. It always streams upstream and
re-assembles the stream into a normal JSON response when the client asked for
`stream: false`. If the caller sends no tools, a harmless `read` tool is
injected with `tool_choice: "none"` so normal chat still works.

The proxy requires an API key on `/v1/models` and `/v1/chat/completions`.
It is generated on first install and stored in `.env`:

```bash
cat .env          # PROXY_API_KEY=sk-oc-...
```

Use it as a normal OpenAI key:

```bash
export PROXY_API_KEY='sk-oc-...'
```

To rotate it, edit `.env` and restart the service:

```bash
systemctl --user restart opencode-free-proxy
```

## Quick test

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $PROXY_API_KEY" | jq .

curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -d '{
    "model": "deepseek-v4.1-flash-free",
    "messages": [{"role": "user", "content": "Say hello in one line"}],
    "max_tokens": 50
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -d '{
    "model": "deepseek-v4.1-flash-free",
    "messages": [{"role": "user", "content": "Count to 5"}],
    "stream": true
  }'
```

## OpenAI SDK example

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key=os.environ["PROXY_API_KEY"],
)

resp = client.chat.completions.create(
    model="deepseek-v4.1-flash-free",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)
```

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: process.env.PROXY_API_KEY,
});

const resp = await client.chat.completions.create({
  model: "deepseek-v4.1-flash-free",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(resp.choices[0].message.content);
```

## Model variants

Suffix a model with `#low`, `#medium`, `#high`, `#xhigh`, or `#max` to set
`reasoning_effort`:

```
deepseek-v4.1-flash-free#high
```

The `opencode/` prefix is also accepted, e.g.
`opencode/deepseek-v4.1-flash-free`.

## Install

```bash
git clone https://github.com/AR-92/opencode-free-proxy.git
cd opencode-free-proxy
./install.sh
```

The installer registers a systemd **user** service and starts it. To keep it
running after you log out:

```bash
loginctl enable-linger "$USER"
```

## Service management

```bash
systemctl --user status opencode-free-proxy
systemctl --user restart opencode-free-proxy
systemctl --user stop opencode-free-proxy
journalctl --user -u opencode-free-proxy -f
```

Logs are also appended to `proxy.log` in this directory.

## Configuration

Set these in the systemd unit or the environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `8787` | Listen port |
| `PROXY_API_KEY` | empty | If set, clients must send `Authorization: Bearer <key>` |
| `UPSTREAM` | `https://opencode.ai/inference/openai/v1` | Upstream base URL |
| `OPENCODE_VERSION` | detected | Version used in the fake User-Agent |
| `REQUEST_TIMEOUT_MS` | `600000` | Upstream timeout |
| `MODELS_REFRESH_MS` | `300000` | How often the model list is refreshed |

The model list is read from the running OpenCode background service
(`opencode service status` + `/api/model`). If OpenCode is not running, a
static list of the free models is used.

## Security / limits

- The free tier is **anonymous**; the proxy simply reproduces the client
  fingerprint. It depends on OpenCode's service staying available.
- By default the server listens on all interfaces so other machines on
  `192.168.100.0/24` can use it. Set `PROXY_API_KEY` if you do not want that.
- Free-tier rate limits and model availability are controlled by OpenCode and
  can change or break at any time.
- This is an unofficial integration. Do not send secrets you would not send to
  OpenCode itself.
