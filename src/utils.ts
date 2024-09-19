import { Page } from '@cloudflare/puppeteer';
import { parseHTML } from "linkedom";
import { findAllInMarkdownAST, htmlToMarkdownAST, markdownASTToString, SemanticMarkdownAST } from 'dom-to-semantic-markdown';

export const crawlPage = async (page: Page, url: string) => {
  await page.goto(url, {
    waitUntil: "load",
  });

  const html = await page.content();
  const { document: doc } = parseHTML(html);
  const body = doc.body || doc.documentElement;

  const markdownAST = htmlToMarkdownAST(body);
  const markdown = markdownASTToString(markdownAST);
  const text = markdownASTToText(markdownAST);

  return {
    markdown,
    text,
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
    links: [...new Set(linksHref)],
  };
};


export function markdownASTToText(nodes: SemanticMarkdownAST[]) {
  return findAllInMarkdownAST(nodes, node => node.type === "text")
    .map(node => node.content)
    .join(" ")
    .replace(/[^\p{L}\p{N}\s]/gu, '') // Remove non-alphanumeric characters.
    .replace(/  +/g, ' ') // Remove consecutive spaces.
}

export function streamResponse(req: Request) {
  const params = new URL(req.url).searchParams;
  const stream = params.get("stream");
  return stream === "true" ? true : false
}
