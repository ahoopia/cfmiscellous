export default {
	async fetch(request, env) {
		// 1. 安全校验：确保请求来自 Telegram 官方 Webhook
		const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
		if (secret !== env.WEBHOOK_SECRET) {
			return new Response('Unauthorized', { status: 403 });
		}

		if (request.method !== 'POST') return new Response('OK');

		try {
			const update = await request.json();

			// 2. 权限校验：只允许你自己使用（防止他人消耗 AI 额度）
			// 建议：直接在 vars 中定义 ADMIN_ID，或通过日志获取你的 ID 后手动写死
			const userId = update.message?.from?.id || update.inline_query?.from?.id;
			if (userId?.toString() !== env.USER_ID) return new Response('OK');

			// 3. 处理搜索请求
			if (update.inline_query) {
				return await handleInlineQuery(update.inline_query, env);
			}

			if (update.message?.text) {
				return await handlePrivateSearch(update.message, env);
			}
		} catch (error) {
			console.error('Search Error:', error);
		}

		return new Response('OK');
	},
};

/**
 * 混合检索核心逻辑：FTS5关键词 + Vectorize语义
 */
async function performHybridSearch(query, env) {
	if (!query) return [];

	// 1. FTS5 尝试
	const ftsResults = await env.tg_search_db
		.prepare(
			`
        SELECT id, content FROM search_index_fts WHERE content MATCH ? LIMIT 5
    `,
		)
		.bind(query)
		.all();

	if (ftsResults.results.length > 0) {
		return ftsResults.results.map((r) => ({ id: r.id, content: r.content.replace(/\s*/g, ''), source: 'exact' }));
	}

	// 2. FTS5 没中，启动 AI (此时才消耗神经元)
	const embeddingResponse = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [query] });
	const vectorMatches = await env.VECTORIZE.query(embeddingResponse.data[0], { topK: 5 });

	if (vectorMatches.matches.length === 0) return [];

	// 3. 性能优化：一次性从主表拉取所有内容，不要在循环里写 await
	const ids = vectorMatches.matches.map((m) => m.id);
	const { results } = await env.tg_search_db
		.prepare(`SELECT id, content FROM search_index WHERE id IN (${ids.map(() => '?').join(',')})`)
		.bind(...ids)
		.all();

	return results.map((r) => ({ id: r.id, content: r.content, source: 'semantic' }));
}
/**
 * 处理私聊搜索
 */
async function handlePrivateSearch(msg, env) {
	try {
		const results = await performSearch(msg.text, env);

		// 1. 确认 Algolia 真的吐出了数据
		if (!results || results.length === 0) {
			await sendTelegram(env, 'sendMessage', {
				chat_id: msg.chat.id,
				text: '❌ 未找到相关内容。',
			});
			return new Response('OK');
		}

		// 2. 暴力清理内容：去掉所有会让 Markdown 报错的特殊字符
		const text =
			`🔎 找到以下匹配内容：\n\n` +
			results
				.map((r, i) => {
					const safeContent = (r.content || '')
						.replace(/[_*`\[\]()]/g, ' ') // 强制替换所有特殊符号为空格
						.substring(0, 100);
					return `${i + 1}. ${safeContent}...\n🔗 [点击跳转](https://t.me/c/3546651461/${r.id})`;
				})
				.join('\n\n');

		// 3. 捕捉 Telegram 的报错真相
		const response = await sendTelegram(env, 'sendMessage', {
			chat_id: msg.chat.id,
			text: text,
			parse_mode: 'Markdown',
			disable_web_page_preview: false,
		});

		const tgData = await response.json();
		if (!tgData.ok) {
			// 如果这里报错，你会看到到底是因为 Markdown 还是 Token 错误
			throw new Error(`TELEGRAM_API_ERROR: ${tgData.description}`);
		}

		console.log('✅ Message sent successfully');
	} catch (err) {
		// 这里的报错会直接出现在 Cloudflare Logs 里
		console.error('CRITICAL_FAILURE:', err.message);

		// 兜底方案：如果 Markdown 发不出，就发纯文本，确保你一定能看到结果
		await sendTelegram(env, 'sendMessage', {
			chat_id: msg.chat.id,
			text: `⚠️ 报错回退: ${err.message}`,
		});
	}
	return new Response('OK');
}
/**
 * 处理 Inline Query (最推荐的交互方式)
 */
async function handleInlineQuery(inlineQuery, env) {
	const results = await performHybridSearch(inlineQuery.query, env);

	const articles = results.map((r) => ({
		type: 'article',
		id: r.id.toString(),
		title: r.source === 'exact' ? `✅ 精确匹配: ${r.id}` : `🤖 语义相关: ${r.id}`,
		description: r.content,
		input_message_content: {
			message_text: `🎯 **搜索结果**\n\n${r.content}\n\n🔗 [查看详情](https://t.me/c/你的频道ID/${r.id})`,
			parse_mode: 'Markdown',
		},
	}));

	await sendTelegram(env, 'answerInlineQuery', {
		inline_query_id: inlineQuery.id,
		results: articles,
		cache_time: 300,
	});
	return new Response('OK');
}

async function sendTelegram(env, method, body) {
	return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function performSearch(query, env) {
	const url = `https://${env.ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/${env.ALGOLIA_INDEX_NAME}/query`;

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'X-Algolia-Application-Id': env.ALGOLIA_APP_ID,
			'X-Algolia-API-Key': env.ALGOLIA_SEARCH_KEY, // 安全：search-bot只拿搜索Key
		},
		body: JSON.stringify({
			params: `query=${encodeURIComponent(query)}&hitsPerPage=5`,
		}),
	});

	const data = await response.json();
	const hits = data.hits || [];

	// Algolia 的强大之处：它会自动返回 _highlightResult 告诉你哪里匹配了
	return hits.map((hit) => ({
		id: hit.objectID,
		content: hit.content,
		// Algolia 自带排名算法，第一个通常就是最准的
	}));
}
