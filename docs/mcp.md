# MCP servers

Add servers in **Settings → Integrations → Tools**. Choose **MCP** as the type, enable the server, then
select it from the tools menu in Open WebUI. Both Tether and Open WebUI need the
MCP relay implementation; use matching versions. Open WebUI's external tools setting must be enabled.

## Local commands (stdio)

Install the MCP server and its runtime on your computer first. For a JavaScript server:

```text
Transport: Local command (stdio)
Executable: /absolute/path/to/node
Arguments: ["/absolute/path/to/server.js"]
Working directory: /absolute/path/to/workspace
Environment: {"API_TOKEN": "your-token"}
```

Arguments are a JSON array of separate strings. Tether launches the executable
directly, without a shell: shell syntax, pipes and `~` expansion are not supported.
On Windows use an executable such as `node.exe`, with the server's script in the
arguments, rather than a `.cmd` wrapper. An empty working directory uses your home
directory. Only basic system environment variables are inherited; add any credentials
or additional variables the server needs in Environment.

Tether starts one process per MCP session and exchanges newline-delimited MCP
messages over its stdin/stdout through the existing relay. No HTTP bridge or local
listening port is involved. Tool calls share that session; cancelling one call does
not terminate it. Session close, disconnect, disabling or editing the server stops
its process. A later connection starts a fresh session. Interrupted calls are not
automatically replayed.

Commands run with your account's permissions; Open Terminal's workspace sandbox
does not apply. Enabled servers are available to your user on your signed-in WebUIs.

## Streamable HTTP

```text
Transport: Streamable HTTP
URL: http://127.0.0.1:8000/mcp
Key: optional bearer token
```

The URL is reached from the Tether computer. Use the exact MCP endpoint, including
any required trailing slash. Tether forwards MCP HTTP requests and streaming
responses through the existing relay. Alternate paths, query strings and redirects
are rejected. The older separate SSE transport and OAuth setup are not supported
by this editor.

## Saved settings

Commands, arguments and URLs stay in local configuration. Put secrets in Environment
or Key: these use encrypted storage when available, and otherwise last only until
Tether quits. Blank secret fields preserve existing values; `{}` clears the
environment and **Remove saved key** clears the bearer token. Secrets are not sent
to WebUI as connection metadata. MCP tool results themselves are sent to WebUI.

## Development checks

In Tether, run `npm test` and `npm run build`. In the matching Open WebUI checkout,
run `python -m pytest backend/tests/test_tether_mcp.py`. The tests cover direct stdio,
HTTP streaming, SDK negotiation, cancellation, endpoint restrictions and session
ownership. Windows process cleanup still needs a native Windows check.
