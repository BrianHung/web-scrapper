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
  async fetch(req: Request, env: Env): Promise<Response> {
		const urlParams = new URL(req.url).searchParams;
		const url = urlParams.get("url");
		if (!url) return new Response("No URL provided.", { status: 400 });

		const json = await env.CRAWLER_PAGE_CACHE.get(url, "json");
		if (json) return Response.json(json);

		let id = env.BROWSER.idFromName("browser");
    let obj = env.BROWSER.get(id);
	
		let resp = obj.fetch(req);
		return resp;
  }
};