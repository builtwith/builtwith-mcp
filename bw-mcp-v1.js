import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { z } from "zod";


export const server = new McpServer({
    name: "builtwith",
    version: "1.2.0",
  });


const BUILTWITH_API_KEY = process.env.BUILTWITH_API_KEY;
const BUILTWITH_API_HOSTNAME = "api.builtwith.com";

var _tools = function (){

    const buildResponse = (payload) => ({
      content: [{ type: "text", text: JSON.stringify(payload) }],
    });

    const missingKeyResponse = () =>
      buildResponse({ error: "Missing BUILTWITH_API_KEY environment variable." });

    const requestBuiltWithJson = async (path, params) => {
      if (!BUILTWITH_API_KEY) {
        return { ok: false, error: { error: "Missing BUILTWITH_API_KEY." } };
      }

      const url = new URL(`https://${BUILTWITH_API_HOSTNAME}/${path}`);
      url.searchParams.set("KEY", BUILTWITH_API_KEY);
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
      } catch (error) {
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
    };

    const handleBuiltWithJson = async (path, params) => {
      const result = await requestBuiltWithJson(path, params);
      if (!result.ok) {
        return buildResponse(result.error);
      }
      return buildResponse(result.data);
    };

    const extractTechnologies = (data) => {
      const extracted = [];
      const paths = data?.Results?.[0]?.Result?.Paths;
      if (!Array.isArray(paths)) {
        return extracted;
      }

      for (const path of paths) {
        const technologies = path?.Technologies;
        if (!Array.isArray(technologies)) {
          continue;
        }
        for (const tech of technologies) {
          if (!tech) {
            continue;
          }
          extracted.push({
            Name: tech.Name || "",
            Description: tech.Description || "",
            Tag: tech.Tag || "",
            Link: tech.Link || "",
          });
        }
      }

      return extracted;
    };

    const registerJsonTool = (name, description, schema, path, buildParams) => {
      server.tool(name, description, schema, async (input) =>
        handleBuiltWithJson(path, buildParams(input))
      );
    };

    server.tool(
      "domain-lookup",
      "Returns the live web technologies use on the root domain name.",
      { domain: z.string(), liveOnly: z.boolean().optional() },
      async ({ domain, liveOnly }) => {
        if (!BUILTWITH_API_KEY) {
          return missingKeyResponse();
        }

        const result = await requestBuiltWithJson("v22/api.json", {
          LOOKUP: domain,
          LIVEONLY: liveOnly === false ? undefined : "yes",
        });

        if (!result.ok) {
          return buildResponse(result.error);
        }

        const extractedData = extractTechnologies(result.data);
        if (extractedData.length === 0) {
          return buildResponse({ error: "No technologies found" });
        }

        return buildResponse(extractedData);
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



export async function main() {

    _tools();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("BuiltWith MCP Server running on stdio");
}


main();
  
