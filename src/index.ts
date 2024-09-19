import { BrowserWorker } from "@cloudflare/puppeteer";

import { Browser } from "./browser";
export { Browser };

export interface Env {
  CRAWLER_PAGE_CACHE: KVNamespace;
  CRAWLER_BROWSER: BrowserWorker;
	BROWSER: DurableObjectNamespace;
}

/**
 * Source code:
 * https://developers.cloudflare.com/browser-rendering/get-started/browser-rendering-with-do/
 */

export default {
	// TODO: Emit updates with streams
	// https://developers.cloudflare.com/workers/examples/openai-sdk-streaming/ 
  async fetch(req: Request, env: Env): Promise<Response> {
		if (req.method === "OPTIONS") return handleOptions(req);

		const urlParams = new URL(req.url).searchParams;
		const url = urlParams.get("url");
		if (!url) return new Response("No URL provided.", { status: 400 });

		const json = await env.CRAWLER_PAGE_CACHE.get(url, "json");
		if (json) return Response.json(json);

		let id = env.BROWSER.idFromName("browser");
    let obj = env.BROWSER.get(id);
	
		let resp = await obj.fetch(req);
		resp = new Response(resp.body, resp);
		resp.headers.set("Access-Control-Allow-Origin", "*");
		resp.headers.append("Vary", "Origin");
		return resp;
  }
};


async function handleOptions(req: Request) {
	if (
		req.headers.get("Origin") !== null &&
		req.headers.get("Access-Control-Request-Method") !== null &&
		req.headers.get("Access-Control-Request-Headers") !== null
	) {
		// Handle CORS preflight requests.
		return new Response(null, {
			headers: {
				"Access-Control-Allow-Origin": req.headers.get("Origin") || "*",
				"Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
				"Access-Control-Max-Age": "86400",
				"Access-Control-Allow-Headers": req.headers.get("Access-Control-Request-Headers")!,
			},
		});
	} else {
		// Handle standard OPTIONS request.
		return new Response(null, {
			headers: {
				Allow: "GET,HEAD,POST,OPTIONS",
			},
		});
	}
}