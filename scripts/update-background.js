import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';

// =============================================
// Claude で箇条書きを整形
// =============================================
async function formatBlock(client, sectionLabel, bullets) {
  const prompt = `以下の箇条書きを、小学校高学年にもわかる言葉で整えてください。

ルール：
・意味・内容は変えない
・難しい言葉は平易に言い換える
・一行40文字以内
・各行は体言止めか短い動詞止め

出力形式（このHTMLのみ返してください。説明不要）：
<ul><li>1行目</li><li>2行目</li><li>3行目</li></ul>

【${sectionLabel}】
${bullets}`;

  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content[0].text.trim();
}

// =============================================
// 既存の background.json を読む
// =============================================
function loadExisting() {
  const path = '../docs/background.json';
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf-8')).cards ?? [];
  } catch {
    return [];
  }
}

// =============================================
// メイン
// =============================================
async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const category = process.env.BG_CATEGORY;
  const title    = process.env.BG_TITLE;
  const overview = process.env.BG_OVERVIEW;
  const issue    = process.env.BG_ISSUE;
  const source   = process.env.BG_SOURCE || '';

  if (!title || !overview || !issue) {
    console.error('BG_TITLE / BG_OVERVIEW / BG_ISSUE が必要です');
    process.exit(1);
  }

  console.log(`Formatting: ${title.slice(0, 40)}...`);

  let overviewHtml, issueHtml;
  try {
    overviewHtml = await formatBlock(client, '概要', overview);
    if (!overviewHtml) throw new Error('empty overview');
  } catch (e) {
    console.warn(`  Overview format failed: ${e.message} — using raw`);
    overviewHtml = '<ul>' + overview.split('\n').filter(Boolean).map(l => `<li>${l.trim()}</li>`).join('') + '</ul>';
  }

  try {
    issueHtml = await formatBlock(client, '問題点', issue);
    if (!issueHtml) throw new Error('empty issue');
  } catch (e) {
    console.warn(`  Issue format failed: ${e.message} — using raw`);
    issueHtml = '<ul>' + issue.split('\n').filter(Boolean).map(l => `<li>${l.trim()}</li>`).join('') + '</ul>';
  }

  const newCard = {
    id:       randomUUID(),
    category: category || '日本の政治',
    title,
    overview: overviewHtml,
    issue:    issueHtml,
    ...(source && { source }),
  };

  const existing = loadExisting();
  const cards    = [newCard, ...existing];

  const output = {
    updatedAt: new Date().toISOString(),
    cards,
  };

  writeFileSync('../docs/background.json', JSON.stringify(output, null, 2), 'utf-8');
  console.log(`Done. ${cards.length} cards saved (1 new).`);
}

main().catch(e => { console.error(e); process.exit(1); });
