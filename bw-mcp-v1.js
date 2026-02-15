import express from "express";
import { AsyncLocalStorage } from "node:async_hooks";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const server = new McpServer({
  name: "builtwith",
  version: "1.2.0",
});

const BUILTWITH_API_KEY = process.env.BUILTWITH_API_KEY || null;
const BUILTWITH_API_HOSTNAME = process.env.BUILTWITH_API_HOSTNAME || "api.builtwith.com";
const MCP_TRANSPORT = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();

// Optional origin allowlist (comma-separated).
const MCP_ALLOWED_ORIGINS = (process.env.MCP_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Per-request store: { api_key: string | null }
const als = new AsyncLocalStorage();

const toolCatalog = [];
const promptCatalog = [];

function buildResponse(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function validateOrigin(req, res) {
  if (MCP_ALLOWED_ORIGINS.length === 0) return true;

  const origin = req.headers.origin;
  // Non-browser clients often omit Origin; only enforce when present.
  if (!origin) return true;

  if (!MCP_ALLOWED_ORIGINS.includes(origin)) {
    res.status(403).json({ error: "Forbidden origin" });
    return false;
  }

  return true;
}

function extractBearerApiKeyOptional(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;

  const apiKey = match[1].trim();
  if (apiKey.length < 10 || apiKey.length > 256) return null;

  return apiKey;
}

function getCurrentApiKey() {
  const store = als.getStore();
  // HTTP mode: per-request key, stdio mode: env key fallback.
  return store?.apiKey || BUILTWITH_API_KEY;
}

async function requestBuiltWithJson(path, params) {
  const apiKey = getCurrentApiKey();
  if (!apiKey) {
    return { ok: false, error: { error: "Missing BuiltWith API key." } };
  }

  const url = new URL(`https://${BUILTWITH_API_HOSTNAME}/${path}`);
  url.searchParams.set("KEY", apiKey);

  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && String(value).length > 0) {
      url.searchParams.set(key, String(value));
    }
  }

  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    return {
      ok: false,
      error: {
        error: "Failed to reach BuiltWith API.",
        details: error?.message || String(error),
      },
    };
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return {
      ok: false,
      error: {
        error: "BuiltWith API did not return JSON.",
        status: response.status,
      },
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: {
        error: "BuiltWith API error.",
        status: response.status,
        data,
      },
    };
  }

  return { ok: true, data };
}

async function handleBuiltWithJson(path, params) {
  const result = await requestBuiltWithJson(path, params);
  if (!result.ok) return buildResponse(result.error);
  return buildResponse(result.data);
}

function extractTechnologies(data) {
  const extracted = [];
  const paths = data?.Results?.[0]?.Result?.Paths;
  if (!Array.isArray(paths)) return extracted;

  for (const p of paths) {
    const technologies = p?.Technologies;
    if (!Array.isArray(technologies)) continue;

    for (const tech of technologies) {
      if (!tech) continue;
      extracted.push({
        Name: tech.Name || "",
        Description: tech.Description || "",
        Tag: tech.Tag || "",
        Link: tech.Link || "",
      });
    }
  }

  return extracted;
}

function zodSchemaToJson(schema) {
  if (!schema || typeof schema !== "object") return {};

  const out = {};
  for (const [key, val] of Object.entries(schema)) {
    if (val?._def) {
      const inner = val._def.innerType?._def?.typeName || val._def.typeName || "string";
      const type = inner.replace("Zod", "").toLowerCase();
      const optional = val._def.typeName === "ZodOptional" || val.isOptional?.();
      out[key] = optional ? `${type} (optional)` : type;
    } else {
      out[key] = "string";
    }
  }

  return out;
}

function registerJsonTool(name, description, schema, path, buildParams) {
  toolCatalog.push({ name, description, parameters: zodSchemaToJson(schema) });
  server.tool(name, description, schema, async (input) => handleBuiltWithJson(path, buildParams(input)));
}

function registerPrompts() {
  promptCatalog.push(
    {
      name: "analyze-tech-stack",
      description: "Analyze the technology stack of a domain",
      parameters: { domain: "string" },
    },
    {
      name: "find-related-websites",
      description: "Find websites related to a domain",
      parameters: { domain: "string" },
    },
    {
      name: "get-technology-recommendations",
      description: "Get technology recommendations for a domain",
      parameters: { domain: "string" },
    },
    {
      name: "research-company",
      description: "Research a company's web presence by name",
      parameters: { company: "string" },
    },
    {
      name: "check-domain-trust",
      description: "Check the trust score of a domain",
      parameters: { domain: "string" },
    }
  );

  server.prompt(
    "analyze-tech-stack",
    "Analyze the technology stack of a domain",
    { domain: z.string() },
    ({ domain }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Use the domain-lookup tool to retrieve the live technologies used on "${domain}". Summarize the tech stack by category (e.g. analytics, hosting, frameworks, CMS, CDN, widgets) and highlight any notable or unusual choices.`,
          },
        },
      ],
    })
  );

  server.prompt(
    "find-related-websites",
    "Find websites related to a domain",
    { domain: z.string() },
    ({ domain }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Use the relationships-api tool to find websites related to "${domain}". Summarize the relationships found, grouping them by type (e.g. shared analytics, shared hosting, same owner).`,
          },
        },
      ],
    })
  );

  server.prompt(
    "get-technology-recommendations",
    "Get technology recommendations for a domain",
    { domain: z.string() },
    ({ domain }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Use the recommendations-api tool to get technology recommendations for "${domain}". Present the recommendations clearly, explaining what each suggested technology does and why it might be a good fit.`,
          },
        },
      ],
    })
  );

  server.prompt(
    "research-company",
    "Research a company's web presence by name",
    { company: z.string() },
    ({ company }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `First use the company-to-url tool to find domains associated with "${company}". Then use the domain-lookup tool on the primary domain to analyze their tech stack. Provide a summary of the company's web presence and the technologies they use.`,
          },
        },
      ],
    })
  );

  server.prompt(
    "check-domain-trust",
    "Check the trust score of a domain",
    { domain: z.string() },
    ({ domain }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Use the trust-api tool to look up the trust score for "${domain}". Explain the trust score, what factors contribute to it, and any concerns or positive signals found.`,
          },
        },
      ],
    })
  );
}

function registerTools() {
  toolCatalog.push({
    name: "domain-lookup",
    description: "Returns the live web technologies used on the root domain name.",
    parameters: { domain: "string", liveOnly: "boolean (optional)" },
  });

  server.tool(
    "domain-lookup",
    "Returns the live web technologies used on the root domain name.",
    { domain: z.string(), liveOnly: z.boolean().optional() },
    async ({ domain, liveOnly }) => {
      const result = await requestBuiltWithJson("v22/api.json", {
        LOOKUP: domain,
        LIVEONLY: liveOnly === false ? undefined : "yes",
      });

      if (!result.ok) return buildResponse(result.error);

      const extracted = extractTechnologies(result.data);
      if (extracted.length === 0) return buildResponse({ error: "No technologies found" });

      return buildResponse(extracted);
    }
  );

  registerJsonTool(
    "domain-api",
    "Domain API JSON lookup for technology and metadata by domain.",
    { lookup: z.string() },
    "v22/api.json",
    ({ lookup }) => ({ LOOKUP: lookup })
  );
  registerJsonTool(
    "relationships-api",
    "Relationships API JSON lookup for related websites by domain.",
    { lookup: z.string() },
    "rv4/api.json",
    ({ lookup }) => ({ LOOKUP: lookup })
  );
  registerJsonTool(
    "free-api",
    "Free API JSON lookup for category/group counts by domain.",
    { lookup: z.string() },
    "free1/api.json",
    ({ lookup }) => ({ LOOKUP: lookup })
  );
  registerJsonTool(
    "company-to-url",
    "Company to URL API JSON lookup for domains from a company name.",
    { company: z.string() },
    "ctu3/api.json",
    ({ company }) => ({ COMPANY: company })
  );
  registerJsonTool(
    "tags-api",
    "Tags API JSON lookup for related domains from IP or attributes.",
    { lookup: z.string() },
    "tag1/api.json",
    ({ lookup }) => ({ LOOKUP: lookup })
  );
  registerJsonTool(
    "recommendations-api",
    "Recommendations API JSON lookup for technology recommendations by domain.",
    { lookup: z.string() },
    "rec1/api.json",
    ({ lookup }) => ({ LOOKUP: lookup })
  );
  registerJsonTool(
    "redirects-api",
    "Redirects API JSON lookup for live and historical redirects by domain.",
    { lookup: z.string() },
    "redirect1/api.json",
    ({ lookup }) => ({ LOOKUP: lookup })
  );
  registerJsonTool(
    "keywords-api",
    "Keywords API JSON lookup for keyword data by domain.",
    { lookup: z.string() },
    "kw2/api.json",
    ({ lookup }) => ({ LOOKUP: lookup })
  );
  registerJsonTool(
    "trends-api",
    "Trends API JSON lookup for technology trend data.",
    { tech: z.string() },
    "trends/v6/api.json",
    ({ tech }) => ({ TECH: tech })
  );
  registerJsonTool(
    "product-api",
    "Product API JSON lookup for ecommerce product searches.",
    { query: z.string() },
    "productv1/api.json",
    ({ query }) => ({ QUERY: query })
  );
  registerJsonTool(
    "trust-api",
    "Trust API JSON lookup for trust scoring by domain.",
    { lookup: z.string() },
    "trustv1/api.json",
    ({ lookup }) => ({ LOOKUP: lookup })
  );
  registerJsonTool(
    "financial-api",
    "Financial API JSON lookup for financial data by domain.",
    { lookup: z.string() },
    "financial1/api.json",
    ({ lookup }) => ({ LOOKUP: lookup })
  );
  registerJsonTool(
    "social-api",
    "Social API JSON lookup for domains related to social profiles.",
    { lookup: z.string() },
    "social1/api.json",
    ({ lookup }) => ({ LOOKUP: lookup })
  );
}

async function startStdio() {
  await server.connect(new StdioServerTransport());
  console.error("BuiltWith MCP Server running on stdio");
}

async function startHttp() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/mcp", (req, res) => {
    res.json({
      name: "builtwith",
      version: "1.2.0",
      description:
        "BuiltWith MCP Server — technology lookup, trends, trust scores and more. https://api.builtwith.com/mcp is a valid MCP endpoint you are currently accessing it with a GET request.",
      authentication: "Pass your BuiltWith API key as Authorization: Bearer <key>",
      tools: toolCatalog,
      prompts: promptCatalog,
    });
  });

  app.all("/mcp", async (req, res) => {
    if (!validateOrigin(req, res)) return;

    const apiKey = extractBearerApiKeyOptional(req);

    als.run({ apiKey }, async () => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      res.on("close", () => {
        try {
          transport.close();
        } catch {}
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch {
        res.status(500).json({ error: "MCP server error" });
      }
    });
  });

  app.get("/health", (req, res) => res.json({ ok: true }));

  const port = parseInt(process.env.PORT || "8787", 10);
  app.listen(port, "127.0.0.1", () => {
    console.error(`BuiltWith MCP (HTTP) listening on http://127.0.0.1:${port}/mcp`);
  });
}

async function main() {
  registerTools();
  registerPrompts();

  if (MCP_TRANSPORT === "http") {
    await startHttp();
    return;
  }

  await startStdio();
}

main();
