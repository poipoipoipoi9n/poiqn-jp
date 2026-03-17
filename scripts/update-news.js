import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';

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
// Claude で整形
// =============================================
async function format(client, title, facts) {
  const prompt = `以下のニュースの事実から、起きた出来事を
小学校高学年にもわかる言葉で箇条書き3行にまとめてください。

ルール：
・元記事の言葉や表現をそのまま使わない
・意見・論評・予測は含めない
・難しい言葉は使わない
・一行30文字以内
・語尾は「〜だよ」「〜なんだって」など話しかける口調で

出力形式（このHTMLのみ返してください。説明不要）：
<ul><li>1行目</li><li>2行目</li><li>3行目</li></ul>

タイトル：${title}
【ファクト】
${facts}`;

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

  // input.json を読み込む
  const inputs = JSON.parse(readFileSync('./input.json', 'utf-8'));
  const articles = [];

  for (const entry of inputs) {
    const { title, source, url, publishedAt = '', facts } = entry;
    if (!title || !facts) {
      console.warn(`Skip (title or facts missing): ${title}`);
      continue;
    }

    console.log(`Formatting: ${title.slice(0, 40)}...`);
    let summary;
    try {
      summary = await format(client, title, facts);
      if (!summary) throw new Error('empty response');
    } catch (e) {
      console.warn(`  Failed: ${e.message}`);
      summary = facts.slice(0, 120);
    }

    articles.push({
      id:          randomUUID(),
      title,
      summary,
      source,
      url,
      category:    detectCategory(title + facts),
      publishedAt,
    });
  }

  const output = {
    updatedAt: new Date().toISOString(),
    articles,
  };

  writeFileSync('../docs/news.json', JSON.stringify(output, null, 2), 'utf-8');
  console.log(`Done. ${output.articles.length} articles saved to news.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
