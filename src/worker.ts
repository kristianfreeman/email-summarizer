import { Ai } from '@cloudflare/ai'
import PostalMime from 'postal-mime'

interface EmailMessage<Body = unknown> {
	readonly from: string;
	readonly to: string;
	readonly headers: Headers;
	readonly raw: ReadableStream;
	readonly rawSize: number;
	setReject(reason: String): void;
	forward(rcptTo: string, headers?: Headers): Promise<void>;
}

export interface Env {
	AI: any;
	DB: D1Database;
	QUEUE: Queue;
	VECTORIZE_INDEX: VectorizeIndex;
}

export default {
	async email(message: EmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
		const reader = message.raw.getReader();

		const decoder = new TextDecoder("utf-8");

		let body = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) { break; }
			body += decoder.decode(value);
		}

		const Parser = new PostalMime()
		const parsedEmail = await Parser.parse(body)
		const emailBody = parsedEmail.text || parsedEmail.html

		await env.QUEUE.send(JSON.stringify({ type: 'email', body: emailBody }))
	},

	async scheduled(env: Env, ctx: ExecutionContext): Promise<void> {
		const summary = await this.generateSummary(env);

		const body = JSON.stringify({
			from: {
				name: "Email Summarizer",
				email: "no-reply@email-summarizer.signalnerve.workers.dev"
			},
			subject: "Your email summary for today",
			content: [{
				type: "text/plain",
				value: summary
			}]
		})

		const mailchannelsUrl = "https://api.mailchannels.net/tx/v1/send"
		await fetch(mailchannelsUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body
		})
	},

	async generateSummary(env: Env) {
		const { results: emails } = await env.DB.prepare('SELECT * FROM messages').all()

		const messages = [
			{ role: 'system', content: "You are an AI that summarizes emails." },
			{ role: 'system', content: "You will receive a list of emails - take the details of each email and summarize them." },
			{ role: 'system', content: "Don't repeat the prompt back to me, just return the summary." },
			{ role: 'system', content: `Here are the emails for today: ${emails.map(email => email.message).join("\n")}` },
			{ role: 'user', content: "Summarize my emails from today." },
		]

		const ai = new Ai(env.AI);
		const { response } = await ai.run(
			'@cf/meta/llama-2-7b-chat-int8',
			{ messages }
		)

		return response
	},

	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === "/") {
			try {
				const now = new Date()
				const oneDayAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000))

				const todayEmailsQuery = `
			SELECT * FROM messages
			WHERE created_at > '${oneDayAgo.toISOString()}'
		`
				const { results: emails } = await env.DB.prepare(todayEmailsQuery).run()
				return new Response(JSON.stringify(emails));
			} catch (err: any) {
				return new Response(err.message)
			}
		} else {
			const summary = await this.generateSummary(env)
			return Response.json({ summary })
		}
	},

	async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
		for (const message of batch.messages) {
			const { body, type } = JSON.parse(message.body as string)
			if (type !== 'email') {
				console.log(`Unknown message type: ${type}`)
				continue
			}

			const { success, results } = await env.DB.prepare('INSERT INTO messages (message) VALUES (?) RETURNING id')
				.bind(body)
				.run()

			if (!success) {
				console.log(`Failed to insert message: ${body}`)
				continue
			}

			const id = String(results[0].id)

			const ai = new Ai(env.AI)
			const { data } = await ai.run("@cf/baai/bge-base-en-v1.5", { text: [body] })
			const values = data[0]

			await env.VECTORIZE_INDEX.upsert([{ id, values }])
		}
	}
};
