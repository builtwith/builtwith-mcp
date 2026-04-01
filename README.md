# 🔍 BuiltWith MCP Server 🚀

## 🌟 Overview

**BuiltWith MCP** is a Model Context Protocol (MCP) server that allows AI assistants (Claude, Cursor, IDE agents, etc.) to query BuiltWith’s technology detection data **directly and natively**.

It enables natural-language questions like:

> “What technologies does example.com use?”
> “Does this site run Shopify or Magento?”
> “What analytics stack is used by nytimes.com?”

BuiltWith MCP supports **bring-your-own BuiltWith API key** and can be used either as a **hosted service** or **self-hosted**.

---

## Claude DEMO

Shows how to get this working in Claude as a Connector 

https://github.com/user-attachments/assets/1199362a-c813-497e-8569-15b9a3ce9713

## 🌐 Hosted MCP (Recommended)

BuiltWith provides a **hosted MCP endpoint** — no local Node process required.

### Endpoint

```
https://api.builtwith.com/mcp
```

### Authentication

Bring your own BuiltWith API key:

```
Authorization: Bearer YOUR_BUILTWITH_API_KEY
```

### Example MCP request

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list"
}
```

---

## 🧩 Supported Tools

The hosted MCP exposes the following tools:

* `domain-lookup` – Live technology detection for a domain
* `domain-api` – Full domain metadata
* `relationships-api` – Related websites
* `free-api` – Category and group counts
* `company-to-url` – Company → domain discovery
* `tags-api` – IP / attribute based discovery
* `recommendations-api` – Technology recommendations
* `redirects-api` – Live and historical redirects
* `keywords-api` – Keyword intelligence
* `trends-api` – Technology trend data
* `product-api` – Ecommerce product search
* `trust-api` – Trust scoring
* `financial-api` – Financial data
* `social-api` – Social profile associations
* `vector-search` – Semantic similarity search across technologies and categories
* `payment-balance` – Check your API credit balance
* `payment-config` – Retrieve your payment configuration
* `payment-purchase` – Purchase API credits using your saved Stripe payment method

---

## ⚙️ Client Configuration (Claude, Cursor, IDEs)

Add BuiltWith MCP to your MCP-compatible client configuration.

### Example

```json
{
  "mcpServers": {
    "builtwith": {
      "url": "https://api.builtwith.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_BUILTWITH_API_KEY"
      }
    }
  }
}
```

### Configuration locations

* **Claude Desktop**

  * macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
  * Windows: `%APPDATA%\Claude\claude_desktop_config.json`
* **Cursor / Claude Dev (VS Code)**

  * macOS: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
  * Windows: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`

---

## 🛠️ Self-Hosting (Optional)

You can also run the BuiltWith MCP server locally or inside your own infrastructure.

### What changed (February 14, 2026)

The local server now supports both standard MCP transports:

* `stdio` (default) for local MCP clients like Claude Desktop/Cursor
* `http` for remote/connector style MCP usage on `/mcp`

### Installation

```bash
git clone https://github.com/builtwith/builtwith-mcp.git
cd builtwith-mcp
npm install
```

### Local (stdio) MCP configuration

```json
{
  "mcpServers": {
    "builtwith": {
      "command": "node",
      "args": ["[PATH-TO]/bw-mcp-v1.js"],
      "env": {
        "BUILTWITH_API_KEY": "YOUR_BUILTWITH_API_KEY"
      }
    }
  }
}
```

> Note: The hosted endpoint is recommended for most users. Self-hosting is useful if you need custom routing, rate-limiting, or private network access.

### Local HTTP MCP endpoint

Run in HTTP mode:

```bash
MCP_TRANSPORT=http PORT=8787 node bw-mcp-v1.js
```

MCP endpoint:

```text
http://127.0.0.1:8787/mcp
```

Optional headers/environment:

* `Authorization: Bearer YOUR_BUILTWITH_API_KEY` (per-request API key for HTTP mode)
* `BUILTWITH_API_KEY` (used by stdio mode, and as fallback when no HTTP bearer token is provided)
* `MCP_ALLOWED_ORIGINS` (comma-separated CORS/origin allowlist for HTTP mode)

Health check:

```text
http://127.0.0.1:8787/health
```

---

## 🚀 Usage Examples

Once configured, try asking your AI assistant:

* “What technologies is example.com using?”
* “What CMS does nytimes.com run on?”
* “Does amazon.com use Google Analytics?”
* “What JavaScript frameworks are used by spotify.com?”
* “What hosting provider does netflix.com use?”
* “Compare the technology stacks of facebook.com and twitter.com”

---

## 🧠 How It Works

1. 🗣️ User asks a technology question in an AI assistant
2. 🔌 The assistant calls the BuiltWith MCP server
3. 🔍 MCP translates intent into BuiltWith API calls
4. 📊 BuiltWith returns structured technology data
5. 💬 The AI assistant presents human-friendly insights

---

## 📖 BuiltWith API Documentation

* [https://api.builtwith.com/](https://api.builtwith.com/)
* [https://api.builtwith.com/domain-api](https://api.builtwith.com/domain-api)

---

## 📄 License

MIT License — see the LICENSE file for details.

---


Built for AI-native workflows by <a href="https://builtwith.com">BuiltWith</a>

Just say which.
