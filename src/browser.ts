import { BrowserWorker, Browser as Puppeteer } from '@cloudflare/puppeteer';
import puppeteer from "@cloudflare/puppeteer";
import { Cluster } from 'puppeteer-cluster';
import { Ai } from "@cloudflare/workers-types"
import { crawlPage, searchWeb, streamResponse } from './utils';

const KEEP_BROWSER_ALIVE_IN_SECONDS = 60;
const CUSTOM_USER_AGENT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible;'

const MAX_PAGES_SCRAPPED = 8 as const;
const MAX_PAGES_EMBEDDED = 8 as const;

interface Env {
  CRAWLER_BROWSER: BrowserWorker;
  CRAWLER_PAGE_CACHE: KVNamespace;
  VECTOR_INDEX: Vectorize;
  AI: Ai;
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

    return pageResult;
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

  async crawl(req: Request) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const textEncoder = new TextEncoder();

    const cluster = await Cluster.launch({
      concurrency: Cluster.CONCURRENCY_PAGE,
      maxConcurrency: 2,
      puppeteer: {
        launch: () => this.browser
      },
    });

    const params = new URL(req.url).searchParams;
		const url = params.get("url");
		if (!url) return new Response("No URL provided.", { status: 400 });

    let pageResult;
    const scrapeWebPage = async ({ page, data: url }) => {
      await page.setUserAgent(CUSTOM_USER_AGENT);
      pageResult = await crawlPage(page, url);
      await this.env.CRAWLER_PAGE_CACHE.put(url, JSON.stringify(pageResult));
    }

    cluster.queue(url, scrapeWebPage);

    if (streamResponse(req)) {
      this.state.waitUntil((
        async () => {
          await cluster.idle();
          await writer.write(
            textEncoder.encode(
              `data: ${JSON.stringify({ message: 'scraping complete' })}\n\n`,
            )
          );
          writer.close();
        }
      )());
      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Transfer-Encoding": "chunked",
          "content-encoding": "identity",
        },
      });
    } else {
      await cluster.idle();
      return Response.json(pageResult);
    }
  }

  async search(req: Request) {

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const textEncoder = new TextEncoder();

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

    const params = new URL(req.url).searchParams;
		const query = params.get("query") || "top restaurants los angeles";
		if (!query) return new Response("No query provided.", { status: 400 });

    let results: { url: string, markdown: string }[] = [];

    const crawlWebPage = async ({ page, data: url }) => {
      await page.setUserAgent(CUSTOM_USER_AGENT);
      await writer.write(
        textEncoder.encode(`data: ${JSON.stringify({ message: "crawling link", link: url })}\n\n`)
      );
      const { markdown } = await crawlPage(page, url);
      results.push({ url, markdown });
    }

    const searchWebPage = async ({ page, data: query }) => {
      await page.setUserAgent(CUSTOM_USER_AGENT);
      await writer.write(
        textEncoder.encode(`data: ${JSON.stringify({ message: "searching web" })}\n\n`)
      );
      const { links: l } = await searchWeb(page, query);
      const links = l.slice(0, MAX_PAGES_SCRAPPED);
      await writer.write(
        textEncoder.encode(`data: ${JSON.stringify({ message: "links found", links })}\n\n`)
      );
      links.forEach(link => {
        cluster.queue(link, crawlWebPage)
      })
    }

    cluster.queue(query, searchWebPage);

    console.log("stream?", streamResponse(req))
    if (streamResponse(req)) {
      this.state.waitUntil((
        async () => {
          await cluster.idle();
          await writer.write(
            textEncoder.encode(
              `data: ${JSON.stringify({ 
                message: 'search complete', 
                result: {
                  query,
                  results,
                } 
              })}\n\n`,
            )
          );
          writer.close();
        }
      )());
      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Transfer-Encoding": "chunked",
          "content-encoding": "identity",
        },
      });
    } else {
      await cluster.idle();
      return Response.json({
        query,
        results,
      });
    }
  }

  async embed(webpages: { url: string, content: string }[]) {
    const { data: embeddings } = await this.env.AI.run("@cf/baai/bge-large-en-v1.5", {
      text: webpages.map(page => page.content),
    });

    const vectors = webpages.map((page, i) => ({
      id: page.url,
      values: embeddings[i],
      metadata: {
        url: page.url,
      }
    }));

    return this.env.VECTOR_INDEX.upsert(vectors);
  }

  async query(query: string) {
    const { data: embeddings } = await this.env.AI.run("@cf/baai/bge-base-en-v1.5",{
      text: query,
    });

    const nearest = await this.env.VECTOR_INDEX.query(embeddings[0], {
      topK: MAX_PAGES_EMBEDDED,
      returnValues: false,
      returnMetadata: true,
    })

    const urls: string[] = nearest.matches.map(match => (match.metadata as any).url);
    return urls;
  }
}