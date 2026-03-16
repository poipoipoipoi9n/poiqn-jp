import Anthropic from '@anthropic-ai/sdk';
import { XMLParser } from 'fast-xml-parser';
import { writeFileSync } from 'fs';
import { randomUUID } from 'crypto';

// =============================================
// ニュースソース設定
// =============================================
const RSS_FEEDS = [
  { name: '時事通信',  url: 'https://www.jiji.com/rss/pol.rss' },
  { name: 'NHK',       url: 'https://www3.nhk.or.jp/rss/news/cat4.xml' },
  { name: 'Reuters',   url: 'https://feeds.reuters.com/reuters/JPpoliticsNews' },
];

// 1ソースから取得する最大記事数
const MAX_PER_FEED = 3;
// 最終的に保存する記事数
const MAX_ARTICLES = 6;

// =============================================
// カテゴリ推定
// =============================================
const CATEGORY_MAP = [
  { keywords: ['経済', '物価', '賃金', '税', '財政', 'GDP', '円', '株', '金利', '予算'], label: '経済' },
  { keywords: ['選挙', '投票', '国会', '議会', '政党', '政権', '首相', '大臣'],           label: '政治' },
  { keywords: ['外交', '外務', '安保', '防衛', '条約', '米国', '中国', '北朝鮮'],         label: '外交' },
  { keywords: ['社会', '少子化', '人口', '医療', '福祉', '年金', '教育', '子ども'],        label: '社会' },
  { keywords: ['環境', 'エネルギー', '原発', '再生可能', '気候'],                           label: '環境' },
];

function detectCategory(text) {
  for (const { keywords, label } of CATEGORY_MAP) {
    if (keywords.some(k => text.includes(k))) return label;
  }
  return '政治';
}

// =============================================
// RSS フェッチ
// =============================================
async function fetchRss(feed) {
  const res = await fetch(feed.url, {
    headers: { 'User-Agent': 'poiqn-news-bot/1.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${feed.url}`);
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);
  const items = parsed?.rss?.channel?.item ?? parsed?.feed?.entry ?? [];
  return (Array.isArray(items) ? items : [items]).slice(0, MAX_PER_FEED);
}

function extractItem(item) {
  const title       = item.title?.['#text'] ?? item.title ?? '';
  const description = item.description?.['#text'] ?? item.description ?? item.summary ?? '';
  const link        = item.link?.['@_href'] ?? item.link ?? item.guid ?? '';
  const pubDate     = item.pubDate ?? item.updated ?? item.published ?? '';
  return { title: String(title).trim(), description: String(description).replace(/<[^>]+>/g, '').trim(), link: String(link).trim(), pubDate };
}

// =============================================
// Claude で要約
// =============================================
async function summarize(client, title, description) {
  const prompt = `以下のニュースを中学生でも分かる平易な日本語で2〜3文に要約してください。
難しい政治用語は避け、「わたしたちの生活にどう関係するか」という視点で書いてください。
要約文のみ返してください（説明や前置き不要）。

タイトル：${title}
内容：${description.slice(0, 500)}`;

  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content[0].text.trim();
}

// =============================================
// メイン
// =============================================
async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const articles = [];

  for (const feed of RSS_FEEDS) {
    console.log(`Fetching: ${feed.name}`);
    let items;
    try {
      items = await fetchRss(feed);
    } catch (e) {
      console.warn(`  Skip (${e.message})`);
      continue;
    }

    for (const raw of items) {
      const { title, description, link, pubDate } = extractItem(raw);
      if (!title) continue;

      console.log(`  Summarizing: ${title.slice(0, 40)}...`);
      let summary;
      try {
        summary = await summarize(client, title, description);
      } catch (e) {
        console.warn(`  Summary failed: ${e.message}`);
        summary = description.slice(0, 120);
      }

      articles.push({
        id:          randomUUID(),
        title,
        summary,
        source:      feed.name,
        url:         link,
        category:    detectCategory(title + description),
        publishedAt: pubDate,
      });
    }
  }

  // 記事数を絞り、更新日時を付与
  const output = {
    updatedAt: new Date().toISOString(),
    articles:  articles.slice(0, MAX_ARTICLES),
  };

  writeFileSync('../poiqn-jp/news.json', JSON.stringify(output, null, 2), 'utf-8');
  console.log(`Done. ${output.articles.length} articles saved to news.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
