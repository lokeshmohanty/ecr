import type { Draft, Message } from "../api/types";
import { quoteBody, replyAttribution } from "./quote";

/**
 * The draft a reply opens as.
 *
 * Reply-all answers everyone the message reached, which is the To as well as
 * the Cc. Both can name the same person, and either can name one of the
 * sending account's own addresses, so the Cc is gathered against a set seeded
 * with the To list and those identities: writing to yourself is not what
 * replying to a list means.
 */
export function replyDraft(
	message: Message,
	all: boolean,
	original: string,
	self: string[] = [],
): Draft {
	const to = (message.reply_to.length ? message.reply_to : message.from)
		.map((a) => a.email)
		.filter((email) => email.trim() !== "");

	const cc: string[] = [];
	if (all) {
		const seen = new Set(
			[...to, ...self].map((email) => email.trim().toLowerCase()),
		);
		for (const address of [...message.to, ...message.cc]) {
			const email = address.email.trim();
			const key = email.toLowerCase();
			if (key === "" || seen.has(key)) continue;
			seen.add(key);
			cc.push(email);
		}
	}

	return {
		to,
		cc,
		bcc: [],
		subject: prefixed(message.subject, "Re:"),
		body: `\n\n${replyAttribution(message.date, message.from[0]?.email ?? null)}\n${quoteBody(original)}\n`,
		in_reply_to: message.id,
		references: [...message.references, message.id],
		attachments: [],
	};
}

export function forwardDraft(message: Message, original: string): Draft {
	return {
		to: [],
		cc: [],
		bcc: [],
		subject: prefixed(message.subject, "Fwd:"),
		body:
			`\n\n---------- Forwarded message ----------\n` +
			`From: ${message.from.map((a) => a.email).join(", ")}\n` +
			`Date: ${message.date}\n` +
			`Subject: ${message.subject}\n` +
			`To: ${message.to.map((a) => a.email).join(", ")}\n\n${original.trim()}\n`,
		in_reply_to: null,
		references: [],
		attachments: [],
	};
}

export function prefixed(subject: string, prefix: string): string {
	const trimmed = subject.trim();
	return trimmed.toLowerCase().startsWith(prefix.toLowerCase())
		? trimmed
		: `${prefix} ${trimmed}`;
}
