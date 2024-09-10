import { BrowserWorker, Page, Browser as Puppeteer } from '@cloudflare/puppeteer';
import puppeteer from "@cloudflare/puppeteer";
import { convertHtmlToMarkdown } from 'dom-to-semantic-markdown';
import { DOMParser } from "linkedom";

const KEEP_BROWSER_ALIVE_IN_SECONDS = 60;

interface Env {
  CRAWLER_BROWSER: BrowserWorker;
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

    const page = await this.browser.newPage();

    const urlParams = new URL(req.url).searchParams;
		const url = urlParams.get("url");
		if (!url) return new Response("No URL provided.", { status: 400 });

    const pageResult = await crawlPage(page, url);

    // Close tab when there is no more work to be done on the page
    await page.close();

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
}

const crawlPage = async (page: Page, url: string) => {
  await page.goto(url, {
    waitUntil: "load",
  });

  const html = await page.content();
  const markdown = convertHtmlToMarkdown(html, { overrideDOMParser: new DOMParser() });
  return {
    html,
    markdown,
  };
};