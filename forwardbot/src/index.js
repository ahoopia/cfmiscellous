import { DurableObject } from 'cloudflare:workers';

export default {
	async fetch(request, env) {
		const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
		if (secret !== env.WEBHOOK_SECRET) return new Response('Unauthorized', { status: 403 });

		if (request.method !== 'POST') return new Response('OK');

		let update;
		try {
			update = await request.json();
			const userId = update.message?.from?.id || update.inline_query?.from?.id;
			if (userId?.toString() !== env.USER_ID) return new Response('OK');
		} catch (e) {
			return new Response('Invalid JSON', { status: 400 });
		}

		const msg = update.message;
		if (!msg) return new Response('OK');

		// --- 核心重构：统一路由逻辑 ---
		// 如果是媒体组，用 media_group_id；如果是单条，用 chat_id + message_id (或者固定前缀)
		// 这样可以保证单条消息也能利用 DO 的稳定出站连接
		const grouperKey = msg.media_group_id || `single_${msg.chat.id}_${msg.message_id}`;

		const id = env.MEDIA_GROUPER.idFromName(grouperKey);
		const obj = env.MEDIA_GROUPER.get(id);

		// 将请求转发给 DO，但不 await handleSingleMessage
		// 我们让 DO 的 fetch 来处理转发逻辑
		return obj.fetch(
			new Request(request.url, {
				method: 'POST',
				body: JSON.stringify(update),
			}),
		);
	},
};

/**

 * 统一的索引触发函数

 */

async function triggerIndexer(mediaArray, msgId, env) {
	// 检查是否有索引器 URL 变量

	if (!env.INDEXER_URL) return;

	try {
		await fetch(env.INDEXER_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: env.AUTHENTICATION_TOKEN, // 这里的 Token 就是你的暗号
			},
			body: JSON.stringify({
				mediaArray,
				msgId,
				chatId: env.TARGET_CHANNEL,
			}),
		});
	} catch (e) {
		console.error('Indexing trigger failed:', e);
	}
}

export class MediaGrouper extends DurableObject {
	constructor(state, env) {
		super(state, env);
		this.env = env;
		this.state = state;
	}

	async fetch(request) {
		const update = await request.json();
		const msg = update.message;

		// 识别是否为单条消息（没有 media_group_id）
		const isSingle = !msg.media_group_id;

		// 1. 提取元数据
		const type = msg.photo ? 'photo' : msg.video ? 'video' : msg.audio ? 'audio' : 'document';
		const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.video?.file_id || msg.document?.file_id || msg.audio?.file_id;
		const textContent = msg.caption || msg.text || '';

		// 2. 存储数据
		const mediaKey = `m:${msg.message_id}`;
		await this.state.storage.put(mediaKey, {
			type,
			media: fileId,
			caption: textContent,
			file_name: msg.document?.file_name || msg.audio?.title || '',
			// 记录原始信息用于 copyMessage (如果是单条)
			isSingle,
			original_chat_id: msg.chat.id,
			original_msg_id: msg.message_id,
		});

		// 3. 设置闹钟 (单条消息给 200ms 缓冲，媒体组给 1500ms)
		const delay = isSingle ? 200 : 1500;
		await this.state.storage.setAlarm(Date.now() + delay);

		return new Response('Buffered OK');
	}

	async alarm() {
		const storedMedia = await this.state.storage.list({ prefix: 'm:' });
		const items = Array.from(storedMedia.values());
		if (items.length === 0) return;

		try {
			let targetMsgId;
			const firstItem = items[0];

			if (firstItem.isSingle && items.length === 1) {
				// --- A. 执行单条 copyMessage ---
				const params = new URLSearchParams({
					chat_id: this.env.TARGET_CHANNEL,
					from_chat_id: firstItem.original_chat_id,
					message_id: firstItem.original_msg_id,
				});
				const res = await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/copyMessage?${params}`);
				const result = await res.json();
				if (result.ok) targetMsgId = result.result.message_id;
			} else {
				// --- B. 执行媒体组 sendMediaGroup ---
				const res = await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/sendMediaGroup`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						chat_id: this.env.TARGET_CHANNEL,
						media: items.map((i) => ({ type: i.type, media: i.media, caption: i.caption })),
					}),
				});
				const result = await res.json();
				if (result.ok) targetMsgId = result.result[0].message_id;
			}

			// --- C. 统一触发索引 ---
			if (targetMsgId) {
				await triggerIndexer(items, targetMsgId, this.env);
			}
		} catch (e) {
			console.error('DO Alarm Error:', e);
		} finally {
			await this.state.storage.deleteAll();
		}
	}
}
