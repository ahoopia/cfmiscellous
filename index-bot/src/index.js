export default {
	async fetch(request, env) {
		// 1. 安全校验：拦截非法请求
		const auth = request.headers.get('Authorization');
		if (auth !== env.AUTHENTICATION_TOKEN) {
			console.error('Unauthorized indexing attempt.');
			return new Response('Forbidden', { status: 403 });
		}

		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', { status: 405 });
		}

		try {
			const { mediaArray, msgId, chatId } = await request.json();

			// 2. 文本提取与清洗
			// 聚合所有 caption 和 file_name，确保语义完整
			let textParts = [];
			mediaArray.forEach((item) => {
				if (item.caption) textParts.push(item.caption);
				if (item.file_name) textParts.push(item.file_name);
			});

			// 处理中文分词
			const fullText = [...new Set(textParts)].join(' | ');

			// 如果没有任何可索引的文字，直接返回
			if (!fullText || fullText.trim() === '') {
				return new Response('No content to index', { status: 200 });
			}

			await env.tg_search_db
				.prepare('INSERT OR REPLACE INTO search_index (id, chat_id, content) VALUES (?, ?, ?)')
				.bind(msgId, chatId, fullText);

			// 同步到 Algolia
			await syncToAlgolia(msgId, fullText, env);

			// // 在写入 FTS 表时使用
			// const ftsContent = segmentCN(fullText);
			// // 4. 原子化写入 D1 和 Vectorize
			// // 使用 batch 确保 D1 的主表和 FTS 虚表同步更新
			// await env.tg_search_db.batch([
			// 	// 在 env.tg_search_db.batch 内部：

			// 	// 写入主表
			// 	env.tg_search_db
			// 		.prepare('INSERT OR REPLACE INTO search_index (id, chat_id, content) VALUES (?, ?, ?)')
			// 		.bind(msgId, chatId, fullText),

			// 	// 写入虚表：手动指定 rowid 为 msgId
			// 	env.tg_search_db.prepare('INSERT OR REPLACE INTO search_index_fts (id, content) VALUES (?, ?)').bind(msgId, ftsContent),
			// ]);

			// // 3. AI 向量化 (Embedding)
			// // 消耗约 10-20 神经元
			// const embeddingResponse = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
			// 	text: [fullText],
			// });
			// const vector = embeddingResponse.data[0];

			// // 5. 写入向量索引
			// await env.VECTORIZE.upsert([
			// 	{
			// 		id: msgId.toString(),
			// 		values: vector,
			// 		metadata: { chatId: chatId },
			// 	},
			// ]);

			return new Response('Indexed Successfully', { status: 200 });
		} catch (error) {
			// 错误处理：如果是主键冲突（重复索引），记录并跳过
			if (error.message.includes('UNIQUE constraint failed')) {
				return new Response('Already Indexed', { status: 200 });
			}
			console.error('Indexing Process Error:', error);
			return new Response('Indexing Failed', { status: 500 });
		}
	},
};
// 去重并限制长度（bge 模型通常限制在 512-1000 字符效果最好）
// 这是一个专门为 SQLite 优化的中文分词转换函数
function segmentCN(text) {
	if (!text) return '';
	// 将中文单字之间强行插入空格，英文单词保持原样
	// 例如 "我的video.mp4" -> "我 的 video.mp4"
	return text
		.replace(/([\u4e00-\u9fa5])/g, ' $1 ')
		.replace(/\s+/g, ' ')
		.trim();
}

async function syncToAlgolia(msgId, fullText, env) {
	const url = `https://${env.ALGOLIA_APP_ID}.algolia.net/1/indexes/${env.ALGOLIA_INDEX_NAME}`;

	// Algolia 的核心是 Object，必须有 objectID 才能更新/去重
	const record = {
		objectID: msgId.toString(),
		content: fullText,
		chat_id: env.TARGET_CHANNEL,
		updated_at: Math.floor(Date.now() / 1000),
	};

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'X-Algolia-Application-Id': env.ALGOLIA_APP_ID,
				'X-Algolia-API-Key': env.ALGOLIA_WRITE_KEY,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(record),
		});
		return await response.json();
	} catch (e) {
		console.error('Algolia Sync Failed:', e);
	}
}
