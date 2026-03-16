import Anthropic from '@anthropic-ai/sdk';
import { XMLParser } from 'fast-xml-parser';
import { writeFileSync } from 'fs';
import { randomUUID } from 'crypto';

// =============================================
// ニュースソース設定
// =============================================
const RSS_FEEDS = [
  { name: '時事通信', url: 'https://www.jiji.com/rss/pol.rss' },
  { name: '47NEWS',   url: 'https://assets.wor.jp/rss/rdf/ynnews/news.rdf' },
  { name: 'Reuters',  url: 'https://feeds.reuters.com/reuters/JPpoliticsNews' },
];

// 1ソースから取得する最大記事数
const MAX_PER_FEED = 3;
// 最終的に保存する記事数
const MAX_ARTICLES = 6;

// =============================================
// キーワードフィルター
// =============================================
const FILTER_KEYWORDS = [
  // 法案・立法
  '法案', '改正案', '法律', '立法', '国会', '審議', '可決', '否決', '成立', '施行', '条例',
  // 税金・財政
  '税', '増税', '減税', '消費税', '所得税', '法人税', '税制', '課税', '財政', '予算', '補正',
  // 外交
  '外交', '外務', '条約', '首脳会談', '外相', '大使', '制裁', '協定', '国連', '安保理',
  // 首相・閣僚の発言・行動
  '首相', '総理', '官房長官', '発言', '声明', '記者会見', '所信表明', '閣議',
  // 世界情勢・戦争
  'イラン', 'イスラエル', 'アメリカ', '米国', '米軍', 'ガザ', '中東', '停戦', '攻撃', '空爆',
  '戦争', '紛争', 'ウクライナ', 'ロシア', '軍事', 'NATO', '核', '弾道', 'トランプ',
  // 国内デモ・抗議
  'デモ', '抗議', '集会', 'デモ行進', '抗議活動', '市民運動', '反対運動',
  // 選挙・政党
  '選挙', '解散', '総選挙', '衆院選', '参院選', '補選', '自民党', '立憲', '維新', '公明党', '共産党',
  // 安全保障・防衛
  '防衛費', '自衛隊', '安保', 'ミサイル', '北朝鮮', '集団的自衛権',
  // 経済・生活への影響
  '物価', '円安', '円高', '賃上げ', '最低賃金', '給付金', '補助金', '社会保険料',
  // 政治スキャンダル・資金問題
  '裏金', '政治資金', 'パーティー券', '疑惑', '不正', '汚職',
  // 憲法・制度
  '憲法', '改憲', '9条', '選択的夫婦別姓', '同性婚',
  // 社会課題
  '少子化', '移民', '外国人労働者', '人口減少',
];

function matchesFilter(text) {
  return FILTER_KEYWORDS.some(k => text.includes(k));
}

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
  const root  = parsed?.rss ?? parsed?.feed ?? parsed?.['rdf:RDF'] ?? parsed?.RDF ?? {};
  const items = root?.channel?.item ?? root?.item ?? root?.entry ?? [];
  return (Array.isArray(items) ? items : [items]).slice(0, MAX_PER_FEED);
}

function extractItem(item) {
  const title       = item.title?.['#text'] ?? item.title ?? '';
  const description = item.description?.['#text'] ?? item.description ?? item.summary ?? '';
  const link        = item.link?.['@_href'] ?? item.link ?? item.guid ?? '';
  const pubDate     = item.pubDate ?? item['dc:date'] ?? item.updated ?? item.published ?? '';
  return { title: String(title).trim(), description: String(description).replace(/<[^>]+>/g, '').trim(), link: String(link).trim(), pubDate };
}

// =============================================
// Claude で要約
// =============================================
async function summarize(client, title, description) {
  const prompt = `以下のニュースを中学生でも分かる平易な日本語で2〜3文に要約してください。
難しい政治用語は避け、「わたしたちの生活にどう関係するか」という視点で書いてください。

【出力ルール】
- 各文の主語（〜は、〜が にあたる部分）を <span class="subj">主語</span> で囲む
- 各文の述語（文末の動詞・形容詞にあたる部分）を <span class="pred">述語</span> で囲む
- 「誰と・誰に・何と」にあたる相手・対象（〜と、〜に）を <span class="partner">相手</span> で囲む
- HTMLタグ以外の説明・前置きは不要。要約文のみ返してください。

タイトル：${title}
内容：${description ? description.slice(0, 500) : '（本文なし。タイトルから推測して要約してください）'}`;

  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 350,
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

      if (!matchesFilter(title + description)) {
        console.log(`  Skip (filter): ${title.slice(0, 40)}`);
        continue;
      }

      console.log(`  Summarizing: ${title.slice(0, 40)}...`);
      let summary;
      try {
        summary = await summarize(client, title, description);
        if (!summary) throw new Error('empty response');
      } catch (e) {
        console.warn(`  Summary failed: ${e.message}`, e.status ?? '');
        summary = description.slice(0, 120) || title;
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

  writeFileSync('../docs/news.json', JSON.stringify(output, null, 2), 'utf-8');
  console.log(`Done. ${output.articles.length} articles saved to news.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
