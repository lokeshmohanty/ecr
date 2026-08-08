import type { Body, Signature } from "../api/types";

/**
 * How one OpenPGP verdict is worded and coloured.
 *
 * Pure, and apart from the pane, because the wording *is* the feature. A
 * padlock that overstates what it knows is worse than no padlock, because it
 * is believed — so what each of the six states says is the thing worth pinning
 * in a test, and a test cannot read a colour off a rendered component.
 */
export interface Badge {
	tone: "pgp-good" | "pgp-caution" | "pgp-bad" | "pgp-quiet";
	label: string;
	/** The long form, on hover and as the accessible description. */
	detail: string;
}

/**
 * What to show above a message, if anything.
 *
 * Answers null for the overwhelming majority of mail, which carries no
 * OpenPGP at all — a badge saying "not signed" on every message is a badge
 * nobody reads, and it would make the one that matters invisible by being
 * ordinary.
 */
export function pgpBadge(body: Body | null | undefined): Badge | null {
	if (!body) return null;

	const signature = body.signature;
	if (!signature) {
		// Encrypted but unsigned is a real combination, and worth saying: it
		// means nobody could read this in transit, and it does *not* mean
		// anyone knows who sent it.
		return body.encrypted
			? {
					tone: "pgp-quiet",
					label: "encrypted",
					detail:
						"this message was encrypted to one of your keys. Nothing here says who sent it",
				}
			: null;
	}

	const badge = describe(signature);
	if (!body.encrypted) return badge;

	return {
		...badge,
		label: `encrypted · ${badge.label}`,
		detail: `${badge.detail}. It was also encrypted to one of your keys`,
	};
}

function describe(signature: Signature): Badge {
	switch (signature.state) {
		case "good":
			return {
				tone: "pgp-good",
				label: `signed by ${signature.signer}`,
				detail: `the signature is good, from key ${signature.key}`,
			};

		// Expired and revoked are the same shape and both take the amber: the
		// message really was signed, by a key that is no longer current. Red
		// would be a lie in the more dangerous direction — it makes red
		// ordinary, and a red that is ordinary is one nobody reads.
		case "expired":
			return {
				tone: "pgp-caution",
				label: `signed by ${signature.signer}, with an expired key`,
				detail: `the signature is good, but key ${signature.key} has expired`,
			};
		case "revoked":
			return {
				tone: "pgp-caution",
				label: `signed by ${signature.signer}, with a revoked key`,
				detail: `the signature is good, but key ${signature.key} has been revoked by its owner`,
			};

		case "bad":
			return {
				tone: "pgp-bad",
				label: "this message has been altered",
				detail: `the signature does not match these bytes. Either the message was changed after it was signed, or it was not signed by key ${signature.key}`,
			};

		// The ordinary state of mail from a stranger, and the quietest of the
		// six. It is a fact about the keyring rather than about the message,
		// and colouring it teaches people that the colours mean nothing.
		case "unknown":
			return {
				tone: "pgp-quiet",
				label: "signed, by a key you do not have",
				detail: `key ${signature.key} is not in your keyring, so nothing can be concluded either way`,
			};

		case "failed":
			return {
				tone: "pgp-quiet",
				label: "signed, but it could not be checked",
				detail: signature.detail,
			};
	}
}
