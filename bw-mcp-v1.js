import express from "express";
import { AsyncLocalStorage } from "node:async_hooks";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const server = new McpServer({
  name: "builtwith",
  version: "1.10.0",
});

const BUILTWITH_API_KEY = process.env.BUILTWITH_API_KEY || null;
const BUILTWITH_API_HOSTNAME = process.env.BUILTWITH_API_HOSTNAME || "api.builtwith.com";
const MCP_TRANSPORT = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();

// Optional origin allowlist (comma-separated).
const MCP_ALLOWED_ORIGINS = (process.env.MCP_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Per-request store: { apiKey: string | null, req: Request | null }
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

function isOpenAiRequest() {
  const req = als.getStore()?.req;
  if (!req) return false;
  const ua = String(req.headers?.["user-agent"] || "");
  return /openai|chatgpt/i.test(ua);
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

async function requestPaymentJson(path, { body } = {}) {
  const apiKey = getCurrentApiKey();
  if (!apiKey) {
    return { ok: false, error: { error: "Missing BuiltWith API key." } };
  }

  const url = new URL(`https://payments.builtwith.com/${path}`);
  url.searchParams.set("KEY", apiKey);

  const options = body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : { method: "GET" };

  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    return { ok: false, error: { error: "Failed to reach BuiltWith Payments API.", details: error?.message || String(error) } };
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, error: { error: "BuiltWith Payments API did not return JSON.", status: response.status } };
  }

  if (!response.ok) {
    return { ok: false, error: { error: "BuiltWith Payments API error.", status: response.status, data } };
  }

  return { ok: true, data };
}

async function requestAgentAuthJson(path, body) {
  const url = new URL(`https://${BUILTWITH_API_HOSTNAME}/${path}`);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      return { ok: false, error: { error: "Agent auth API did not return JSON.", status: response.status } };
    }
    if (!response.ok) {
      return { ok: false, error: { error: "Agent auth API error.", status: response.status, data } };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: { error: "Failed to reach agent auth API.", details: error?.message || String(error) } };
  }
}

function firstText(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const first = value.find(item => item !== undefined && item !== null && String(item).trim());
      if (first !== undefined) return String(first).trim();
      continue;
    }
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function firstArray(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (!Array.isArray(value)) continue;
    return value.map(item => String(item || "").trim()).filter(Boolean);
  }
  return [];
}

function domainApiPathLabel(path, rootDomain) {
  const url = String(path?.Url || path?.Path || "").trim();
  const domain = String(path?.Domain || "").trim();
  const subDomain = String(path?.SubDomain || "").trim();
  const host = subDomain || domain;

  if (host && rootDomain && host.toLowerCase() !== rootDomain) {
    return url ? `${host}${url.startsWith("/") ? "" : "/"}${url}` : host;
  }

  if (url) return url;
  return "/";
}

function extractTechnologies(data) {
  const extracted = [];
  const rootDomain = String(data?.Results?.[0]?.Lookup || "").trim().toLowerCase();
  const paths = data?.Results?.[0]?.Result?.Paths;
  if (!Array.isArray(paths)) return extracted;

  for (const p of paths) {
    const technologies = p?.Technologies;
    if (!Array.isArray(technologies)) continue;
    const path = domainApiPathLabel(p, rootDomain);

    for (const tech of technologies) {
      if (!tech) continue;
      extracted.push({
        Name: tech.Name || "",
        Description: tech.Description || "",
        Tag: tech.Tag || "",
        Link: tech.Link || "",
        Path: path,
        PathDomain: p?.Domain || "",
        SubDomain: p?.SubDomain || "",
        Categories: Array.isArray(tech.Categories) ? tech.Categories.filter(Boolean) : [],
        IsPremium: tech.IsPremium || "",
        FirstDetected: Number(tech.FirstDetected || 0),
        LastDetected: Number(tech.LastDetected || 0),
        PathLastIndexed: Number(p?.LastIndexed || 0),
      });
    }
  }

  return extracted;
}

function extractAskSites(data) {
  const results = Array.isArray(data?.Results) ? data.Results : [];
  return results.map((item) => {
    const domain = firstText(item, ["D", "Domain", "domain", "Url", "URL", "Website"]);
    const country = firstText(item, ["Country", "C", "CountryCode"]);
    const locationParts = [
      firstText(item, ["City"]),
      firstText(item, ["State", "Region"]),
      country,
    ].filter(Boolean);

    return {
      Domain: domain,
      Title: firstText(item, ["Title", "T", "Name"]),
      Description: firstText(item, ["Description", "Desc", "MetaDescription"]),
      Company: firstText(item, ["Company", "CompanyName", "LegalName", "Name"]),
      Location: locationParts.join(", "),
      Country: country,
      Vertical: firstText(item, ["Vertical", "Industry", "Category"]),
      Spend: Number(firstText(item, ["Spend", "EstimatedSpend"]) || 0),
      Technologies: firstArray(item, ["Technologies", "Tech", "Tags", "Categories"]),
      LinkedOnSites: firstArray(item, ["LOS", "LinkedOnSites", "LocationsOnSite"]),
    };
  }).filter(site => site.Domain);
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

const listAttributeFilterKeys = [
  "SPEND", "REVENUE", "SKU", "FOLLOWERS", "EMPLOYEES", "SITEMAP",
  "PAGERANK", "BWRANK", "TRANCO", "MAJESTIC", "BWS", "ECAT",
  "AIM", "AIO", "AIR", "AIV",
];

function buildListApiParams(input) {
  const params = {
    TECH: input.tech,
    OTHERTECHS: input.otherTechs,
    META: input.meta ? "yes" : undefined,
    COUNTRY: input.country,
    OFFSET: input.offset,
    SINCE: input.since,
    ALL: input.all ? "yes" : undefined,
  };

  for (const key of listAttributeFilterKeys) {
    const inputKey = key.toLowerCase();
    if (input[inputKey] !== undefined) params[key] = input[inputKey];
  }

  for (const [key, value] of Object.entries(input.filters || {})) {
    params[key.toUpperCase()] = value;
  }

  return params;
}

function registerPrompts() {
  promptCatalog.push(
    { name: "analyze-tech-stack", description: "Analyze the technology stack of a domain", parameters: { domain: "string" } },
    { name: "find-related-websites", description: "Find websites related to a domain", parameters: { domain: "string" } },
    { name: "get-technology-recommendations", description: "Get technology recommendations for a domain", parameters: { domain: "string" } },
    { name: "research-company", description: "Research a company's web presence by name", parameters: { company: "string" } },
    { name: "check-domain-trust", description: "Check the trust score of a domain", parameters: { domain: "string" } },
    { name: "discover-technologies-by-concept", description: "Search for technologies matching a concept, then explore adoption", parameters: { concept: "string" } },
  );

  server.prompt(
    "analyze-tech-stack",
    "Analyze the technology stack of a domain",
    { domain: z.string() },
    ({ domain }) => ({
      messages: [{
        role: "user",
        content: { type: "text", text: `Use the domain-lookup tool to retrieve the live technologies used on "${domain}". Summarize the tech stack by category (e.g. analytics, hosting, frameworks, CMS, CDN, widgets) and highlight any notable or unusual choices.` },
      }],
    })
  );

  server.prompt(
    "find-related-websites",
    "Find websites related to a domain",
    { domain: z.string() },
    ({ domain }) => ({
      messages: [{
        role: "user",
        content: { type: "text", text: `Use the relationships-api tool to find websites related to "${domain}". Summarize the relationships found, grouping them by type (e.g. shared analytics, shared hosting, same owner).` },
      }],
    })
  );

  server.prompt(
    "get-technology-recommendations",
    "Get technology recommendations for a domain",
    { domain: z.string() },
    ({ domain }) => ({
      messages: [{
        role: "user",
        content: { type: "text", text: `Use the recommendations-api tool to get technology recommendations for "${domain}". Present the recommendations clearly, explaining what each suggested technology does and why it might be a good fit.` },
      }],
    })
  );

  server.prompt(
    "research-company",
    "Research a company's web presence by name",
    { company: z.string() },
    ({ company }) => ({
      messages: [{
        role: "user",
        content: { type: "text", text: `First use the company-to-url tool to find domains associated with "${company}". Then use the domain-lookup tool on the primary domain to analyze their tech stack. Provide a summary of the company's web presence and the technologies they use.` },
      }],
    })
  );

  server.prompt(
    "check-domain-trust",
    "Check the trust score of a domain",
    { domain: z.string() },
    ({ domain }) => ({
      messages: [{
        role: "user",
        content: { type: "text", text: `Use the trust-api tool to look up the trust score for "${domain}". Explain the trust score, what factors contribute to it, and any concerns or positive signals found.` },
      }],
    })
  );

  server.prompt(
    "discover-technologies-by-concept",
    "Search for technologies matching a concept, then explore adoption",
    { concept: z.string() },
    ({ concept }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Use the vector-api tool to search for technologies matching "${concept}". Take the top results and for each relevant technology name found, use the trends-api tool to show adoption trends. Summarize which technologies best match the concept and how widely they are used.`,
        },
      }],
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
      const result = await requestBuiltWithJson("v23/api.json", {
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
    "v23/api.json",
    ({ lookup }) => ({ LOOKUP: lookup })
  );
  registerJsonTool(
    "domain-api-json",
    "Raw Domain API JSON lookup for technology and metadata by domain.",
    { lookup: z.string() },
    "v23/api.json",
    ({ lookup }) => ({ LOOKUP: lookup })
  );
  registerJsonTool(
    "domain-api-json",
    "Raw Domain API JSON lookup for technology and metadata by domain.",
    { lookup: z.string() },
    "v22/api.json",
    ({ lookup }) => ({ LOOKUP: lookup })
  );
  registerJsonTool(
    "change-api",
    "Change API JSON lookup for technology additions and removals by domain. Supports one or more comma-separated domains and optional natural language SINCE values such as 'last month'.",
    {
      lookup: z.string().describe("Domain name, or comma-separated domain names, to check for technology changes"),
      since: z.string().optional().describe("Optional natural language date range such as 'last month'; defaults to 3 months"),
    },
    "change1/api.json",
    ({ lookup, since }) => ({ LOOKUP: lookup, SINCE: since })
  );
  registerJsonTool(
    "lists-api",
    "Lists API JSON lookup for sites using a technology. Supports OTHERTECHS and numeric filters such as SPEND=100|GT, REVENUE=100000|GT, EMPLOYEES=50|GTE, and additional filters.",
    {
      tech: z.string(),
      otherTechs: z.string().optional(),
      meta: z.boolean().optional(),
      country: z.string().optional(),
      offset: z.string().optional(),
      since: z.string().optional(),
      all: z.boolean().optional(),
      spend: z.string().optional(),
      revenue: z.string().optional(),
      sku: z.string().optional(),
      followers: z.string().optional(),
      employees: z.string().optional(),
      sitemap: z.string().optional(),
      pagerank: z.string().optional(),
      bwrank: z.string().optional(),
      tranco: z.string().optional(),
      majestic: z.string().optional(),
      bws: z.string().optional(),
      ecat: z.string().optional(),
      aim: z.string().optional(),
      aio: z.string().optional(),
      air: z.string().optional(),
      aiv: z.string().optional(),
      filters: z.record(z.string()).optional(),
    },
    "lists12/api.json",
    buildListApiParams
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
    "keywords-search-api",
    "Keyword Search API — find websites containing a specific keyword. Returns a list of matching domains and a NextOffset value for pagination. Costs API credits per query.",
    {
      keyword: z.string().describe("The keyword to search for (e.g. 'perfume')"),
      limit: z.number().int().min(16).max(1000).optional().describe("Results per request (16–1000, default 100)"),
      offset: z.string().optional().describe("Domain name from the previous response's NextOffset for pagination"),
    },
    "kws1/api.json",
    ({ keyword, limit, offset }) => ({ KEYWORD: keyword, LIMIT: limit, OFFSET: offset })
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
    "vat-api",
    "VAT API JSON lookup for VAT, GST, CNPJ, ABN, and other publicly displayed company registration numbers associated with websites. Accepts 1-16 comma-separated domains. Uses 1 API credit only for each domain that returns registration data; domains with no results use no credits.",
    { lookup: z.string().describe("1 to 16 comma-separated domains") },
    "vat1/api.json",
    ({ lookup }) => ({ LOOKUP: lookup })
  );
  registerJsonTool(
    "vat-types-api",
    "List every company registration type that the VAT API may return, including its code, friendly name, and description. Public endpoint; no API key or credits required.",
    {},
    "vat1/types.json",
    () => ({})
  );
  registerJsonTool(
    "mcp-registry-api",
    "Search and browse the BuiltWith MCP registry of other remote MCP servers BuiltWith has discovered (not an MCP protocol endpoint itself). Returns each server's endpoint URL(s) and the tools (methods) they support with descriptions. SEARCH matches domain, description, endpoint URL, and tool names/descriptions. Especially useful for AI agents/MCP clients discovering remote MCP servers and methods to connect to. Free; no API credits used; rate limited to 1 request per second per API key.",
    {
      search: z.string().optional().describe("Text to search for (matches domain, description, endpoint URL, and tool names/descriptions)"),
      category: z.string().optional().describe("Category to filter by (e.g. 'developer-tools')"),
      offset: z.number().int().min(0).optional().describe("Offset for pagination"),
    },
    "mcp1/api.json",
    ({ search, category, offset }) => ({ SEARCH: search, CATEGORY: category, OFFSET: offset })
  );
  registerJsonTool(
    "vector-api",
    "Search BuiltWith technologies and categories by text query using vector similarity. Returns ranked results with similarity scores (0–1), descriptions, and category info. Useful for discovering what technologies match a concept or description (e.g. 'react framework', 'payment gateway', 'live chat'). Costs 1 API credit per query.",
    {
      query: z.string().describe("Text to search for (e.g. 'javascript framework', 'email marketing')"),
      limit: z.number().int().min(1).max(100).optional().describe("Max results to return (default 10, max 100)"),
    },
    "vector/v1/api.json",
    ({ query, limit }) => ({ QUERY: query, LIMIT: limit })
  );
  registerJsonTool(
    "whoami-api",
    "WhoAmI API JSON lookup for account limits, credit costs, privacy flags, max batch sizes, and endpoint inventory. Uses no API credits. Call this first to make account-aware decisions.",
    {},
    "whoamiv1/api.json",
    () => ({})
  );
  registerJsonTool(
    "usage-api",
    "Usage API JSON lookup for current credit balance (used, purchased, remaining). Uses no API credits.",
    {},
    "usagev2/api.json",
    () => ({})
  );

  toolCatalog.push({
    name: "ask-api",
    description: "Ask API lookup for natural language website list queries. OpenAI requests are served as preview results and do not commit full reports.",
    parameters: { query: "string", commit: "boolean (optional)", nextOffset: "string (optional)", meta: "boolean (optional)" },
  });
  server.tool(
    "ask-api",
    "Ask API lookup for natural language website list queries. OpenAI requests are served as preview results and do not commit full reports.",
    {
      query: z.string().describe("The natural language query (e.g. 'Magento websites in Spain')"),
      commit: z.boolean().optional().describe("Ignored for OpenAI/ChatGPT requests; use ask-api-json outside ChatGPT for committed reports"),
      nextOffset: z.string().optional().describe("Pagination offset from the previous response's NextOffset"),
      meta: z.boolean().optional().describe("Set to true to include metadata in the results"),
    },
    async ({ query, commit, nextOffset, meta }) => {
      const openAiPreview = isOpenAiRequest();
      const shouldCommit = Boolean(commit) && !openAiPreview;
      const result = await requestBuiltWithJson("ask1/api.json", {
        QUERY: query,
        COMMIT: shouldCommit ? "true" : undefined,
        NEXTOFFSET: nextOffset,
        META: meta ? "yes" : undefined,
      });
      if (!result.ok) return buildResponse(result.error);
      const sites = extractAskSites(result.data);
      const nextOffsetVal = String(result.data?.NextOffset || result.data?.nextOffset || "");
      return buildResponse({
        query,
        count: sites.length,
        committed: shouldCommit,
        requestedCommit: Boolean(commit),
        openAiPreview,
        nextOffset: nextOffsetVal,
        sites,
      });
    }
  );

  registerJsonTool(
    "ask-api-json",
    "Raw Ask API JSON lookup for natural language website list queries. Allows COMMIT=true for non-OpenAI clients.",
    {
      query: z.string().describe("The natural language query (e.g. 'Magento websites in Spain')"),
      commit: z.boolean().optional().describe("Set to true to run a full report returning up to 1000 results"),
      nextOffset: z.string().optional().describe("Pagination offset from the previous response's NextOffset"),
      meta: z.boolean().optional().describe("Set to true to include metadata in the results"),
    },
    "ask1/api.json",
    ({ query, commit, nextOffset, meta }) => ({
      QUERY: query,
      COMMIT: commit ? "true" : undefined,
      NEXTOFFSET: nextOffset,
      META: meta ? "yes" : undefined,
    })
  );

  toolCatalog.push({
    name: "payment-balance",
    description: "Check your BuiltWith Agent Payment API credit balance. Returns credits_total, credits_used, and credits_available.",
    parameters: {},
  });
  server.tool(
    "payment-balance",
    "Check your BuiltWith Agent Payment API credit balance. Returns credits_total, credits_used, and credits_available.",
    {},
    async () => {
      const result = await requestPaymentJson("v1/billing/api-discovery");
      if (!result.ok) return buildResponse(result.error);
      return buildResponse(result.data);
    }
  );

  toolCatalog.push({
    name: "payment-config",
    description: "Retrieve your BuiltWith Agent Payment API configuration. Returns max_per_purchase, max_monthly, monthly_purchased, monthly_remaining, and cost_per_2000_credits_usd.",
    parameters: {},
  });
  server.tool(
    "payment-config",
    "Retrieve your BuiltWith Agent Payment API configuration. Returns max_per_purchase, max_monthly, monthly_purchased, monthly_remaining, and cost_per_2000_credits_usd.",
    {},
    async () => {
      const result = await requestPaymentJson("v1/billing/api-configuration");
      if (!result.ok) return buildResponse(result.error);
      return buildResponse(result.data);
    }
  );

  toolCatalog.push({
    name: "payment-purchase",
    description: "Purchase BuiltWith API credits using your saved Stripe payment method. Minimum 2,000 credits per purchase. Returns success, credits_purchased, cost_usd, payment_id, and credits_available.",
    parameters: { credits: "number" },
  });
  server.tool(
    "payment-purchase",
    "Purchase BuiltWith API credits using your saved Stripe payment method. Minimum 2,000 credits per purchase. Returns success, credits_purchased, cost_usd, payment_id, and credits_available.",
    { credits: z.number().int().min(2000).describe("Number of credits to purchase (minimum 2000)") },
    async ({ credits }) => {
      const result = await requestPaymentJson("v1/billing/api-purchase", { body: { credits } });
      if (!result.ok) return buildResponse(result.error);
      return buildResponse(result.data);
    }
  );

  toolCatalog.push({
    name: "agent-auth-start",
    description: "Start the Agent Device-Code Authorization flow. Returns a device_code and verification_uri. Direct the user to open the verification_uri in their browser to approve access. Then poll agent-auth-token every 5 seconds until approved or denied.",
    parameters: {},
  });
  server.tool(
    "agent-auth-start",
    "Start the Agent Device-Code Authorization flow. Returns a device_code and verification_uri. Direct the user to open the verification_uri in their browser to approve access. Then poll agent-auth-token every 5 seconds until approved or denied.",
    {},
    async () => {
      const result = await requestAgentAuthJson("agent-auth/start");
      if (!result.ok) return buildResponse(result.error);
      return buildResponse(result.data);
    }
  );

  toolCatalog.push({
    name: "agent-auth-token",
    description: "Poll for the result of an Agent Device-Code Authorization flow. Call every 5 seconds after agent-auth-start. Returns { access_token, token_type, expires_in } on approval, { error: 'authorization_pending' } while waiting, or { error: 'access_denied' } if denied. Use access_token as the API key on any BuiltWith endpoint.",
    parameters: { device_code: "string" },
  });
  server.tool(
    "agent-auth-token",
    "Poll for the result of an Agent Device-Code Authorization flow. Call every 5 seconds after agent-auth-start. Returns { access_token, token_type, expires_in } on approval, { error: 'authorization_pending' } while waiting, or { error: 'access_denied' } if denied. Use access_token as the API key on any BuiltWith endpoint.",
    { device_code: z.string().describe("Device code received from agent-auth-start") },
    async ({ device_code }) => {
      const result = await requestAgentAuthJson("agent-auth/token", { device_code });
      if (!result.ok) return buildResponse(result.error);
      return buildResponse(result.data);
    }
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
      version: "1.10.0",
      description:
        "BuiltWith MCP Server — technology lookup, trends, trust scores, vector search and more. https://api.builtwith.com/mcp is a valid MCP endpoint you are currently accessing it with a GET request.",
      authentication: "Pass your BuiltWith API key as Authorization: Bearer <key>",
      tools: toolCatalog,
      prompts: promptCatalog,
    });
  });

  app.all("/mcp", async (req, res) => {
    if (!validateOrigin(req, res)) return;

    const apiKey = extractBearerApiKeyOptional(req);

    als.run({ apiKey, req }, async () => {
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
