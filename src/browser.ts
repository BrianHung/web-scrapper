import { BrowserWorker, Page, Browser as Puppeteer } from '@cloudflare/puppeteer';
import puppeteer from "@cloudflare/puppeteer";
import { Cluster } from 'puppeteer-cluster';
import { DOMParser, parseHTML } from "linkedom";
import { convertHtmlToMarkdown } from 'dom-to-semantic-markdown';

const KEEP_BROWSER_ALIVE_IN_SECONDS = 60;
const CUSTOM_USER_AGENT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible;'

const MAX_PAGES_SCRAPPED = 8 as const;
const MAX_PAGES_EMBEDDED = 8 as const;

interface Env {
  CRAWLER_BROWSER: BrowserWorker;
  CRAWLER_PAGE_CACHE: KVNamespace;
}


export class Browser {

  state: DurableObjectState;
  env: Env;

  keptAliveInSeconds: number;
  browser?: Puppeteer;

  storage: DurableObjectStorage;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.keptAliveInSeconds = 0;
    this.storage = this.state.storage;
  }

  async fetch(req: Request) {
    if (!this.browser || !this.browser.isConnected()) {
      console.log(`Browser DO: Starting new instance`);
      try {
        this.browser = await puppeteer.launch(this.env.CRAWLER_BROWSER);
      } catch (e) {
        console.log(
          `Browser DO: Could not start browser instance. Error: ${e}`,
        );

        return new Response(
        JSON.stringify({ error: "Could not start browser instance." }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      }
    }

    // Reset keptAlive after each call to the DO
    this.keptAliveInSeconds = 0;

    const pageResult = this.crawl(req);

    // Reset keptAlive after performing tasks to the DO.
    this.keptAliveInSeconds = 0;

    // set the first alarm to keep DO alive
    let currentAlarm = await this.storage.getAlarm();
    if (currentAlarm == null) {
      const TEN_SECONDS = 10 * 1000;
      await this.storage.setAlarm(Date.now() + TEN_SECONDS);
    }

    return Response.json(pageResult);
  }

  async crawl(req: Request) {
    const cluster = await Cluster.launch({
      concurrency: Cluster.CONCURRENCY_PAGE,
      maxConcurrency: 2,
      puppeteer: {
        launch: () => this.browser
      },
    });

    const urlParams = new URL(req.url).searchParams;
		const url = urlParams.get("url");
		if (!url) return new Response("No URL provided.", { status: 400 });

    let pageResult;
    const scrapeWebPage = async ({ page, data: url }) => {
      await page.setUserAgent(CUSTOM_USER_AGENT);
      pageResult = await crawlPage(page, url);
      await this.env.CRAWLER_PAGE_CACHE.put(url, JSON.stringify(pageResult));
    }

    cluster.queue(url, scrapeWebPage);
    await cluster.idle();

    return Response.json(pageResult);
  }

  async alarm() {
    this.keptAliveInSeconds += 10;

    // Extend browser DO life
    if (this.keptAliveInSeconds < KEEP_BROWSER_ALIVE_IN_SECONDS) {
      console.log(
        `Browser DO: has been kept alive for ${this.keptAliveInSeconds} seconds. Extending lifespan.`,
      );
      await this.storage.setAlarm(Date.now() + 10 * 1000);
    } else {
      console.log(
        `Browser DO: exceeded life of ${KEEP_BROWSER_ALIVE_IN_SECONDS}s.`,
      );
      if (this.browser) {
        console.log(`Closing browser.`);
        await this.browser.close();
      }
    }
  }

  async search(req: Request) {
    const cluster = await Cluster.launch({
      concurrency: Cluster.CONCURRENCY_PAGE,
      maxConcurrency: 5,
      puppeteer: {
        launch: () => this.browser
      },
    });

    cluster.on('taskerror', (error, data) => {
      console.log(`Error crawling ${data}: ${error.message}`);
    });

    const urlParams = new URL(req.url).searchParams;
		const query = urlParams.get("query") || "top restaurants chicago";
		if (!query) return new Response("No query provided.", { status: 400 });

    let linkResults: { url: string, markdown: string }[] = [];

    const crawlWebPage = async ({ page, data: url }) => {
      await page.setUserAgent(CUSTOM_USER_AGENT);
      console.log("crawling", url)
      const { markdown } = await crawlPage(page, url);
      linkResults.push({ url, markdown });
    }

    const searchWebPage = async ({ page, data: query }) => {
      await page.setUserAgent(CUSTOM_USER_AGENT);
      console.log("searching", query)
      const { links } = await searchWeb(page, query);
      links.forEach(link => {
        cluster.queue(link, crawlWebPage)
      })
    }

    cluster.queue(query, searchWebPage);
    await cluster.idle();

    // TODO: Text embedding for scrapped pages to find most relevant pages.
    // https://github.com/huggingface/chat-ui/blob/main/src/lib/server/websearch/runWebSearch.ts
    const pageResult = {
      query: "top restaurants chicago",
      results: linkResults,
    }

    return Response.json(pageResult);
  }
}

export const crawlPage = async (page: Page, url: string) => {
  await page.goto(url, {
    waitUntil: "load",
  });

  const html = await page.content();
  const markdown = convertHtmlToMarkdown(html, { overrideDOMParser: new DOMParser() });
  
  return {
    markdown,
  };
};

export function isURL(url: string) {
	try {
		new URL(url);
		return true;
	} catch (e) {
		return false;
	}
}

export const searchWeb = async (page: Page, query: string) => {
  const url = "https://www.google.com/search?hl=en&q=" + encodeURIComponent(query);

  await page.goto(url, {
    waitUntil: "load",
  });

  const html = await page.content();
  const { document } = parseHTML(html);

  const links = document.querySelectorAll("a");
	if (!links.length) throw new Error(`webpage doesn't have any "a" element`);

	const linksHref: string[] = Array.from(links)
		.map((el) => el.href)
		.filter((link) => link.startsWith("/url?q=") && !link.includes("google.com/"))
		.map((link) => link.slice("/url?q=".length, link.indexOf("&sa=")))
		.filter(isURL);

  return {
    links: [...new Set(linksHref)].slice(0, MAX_PAGES_SCRAPPED),
  };
};