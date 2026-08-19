import {
	Match,
	Show,
	Switch,
	createEffect,
	createSignal,
	on,
	onCleanup,
	onMount,
} from "solid-js";
import { Keymap, type Action } from "./keymap/engine";
import { createAppStore } from "./state/store";
import { Sidebar } from "./ui/Sidebar";
import { ThreadList } from "./ui/ThreadList";
import { ReadingPane } from "./ui/ReadingPane";
import { Palette } from "./ui/Palette";
import { ComposePane, emptyDraft } from "./ui/ComposePane";
import { SettingsPane } from "./ui/settings/SettingsPane";
import {
	AuthAlert,
	ConnectionSetup,
	DoctorAlert,
	Help,
	ServerAlert,
	StatusBar,
	TopBar,
} from "./ui/Chrome";
import type { Draft, Message } from "./api/types";
import { quoteBody, replyAttribution } from "./state/quote";
import { parseMailto } from "./state/mailto";
import { takeLaunchMailto } from "./api/platform";
import { isNarrow } from "./ui/narrow";
import { ActionBar } from "./ui/ActionBar";
import { AccountSwitcher } from "./ui/AccountSwitcher";
import { accountKeys } from "./state/account-keys";
import { withSignature } from "./state/signature";

/** A key belongs to a text field whenever one of these has focus. */
function isEditing(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

/**
 * The chords the app may take out of a text field's mouth.
 *
 * Ctrl chords are matched before the "is a text field focused" check, which is
 * what makes it possible to leave an open composer without discarding it. The
 * cost of that is every *other* chord: `C-u` rubs out a line and `C-e` goes to
 * the end of it for anyone who has ever used a shell, and both were bound to
 * scrolling the message behind the composer — so the pane moved while the
 * caret sat in a textarea that never saw the keystroke. Nothing on screen
 * connects that to a binding for the pane underneath; it reads as the composer
 * dropping keys.
 *
 * So mid-edit the app keeps only what moves the keyboard's owner — the panes,
 * the pinned split, the conversation cursor — and everything that acts on
 * content is the editor's. An allowlist rather than a list of exclusions,
 * because a chord added later should fail by staying out of the way of
 * somebody typing rather than by stealing their key.
 */
const ESCAPE_HATCHES = new Set<Action["kind"]>([
	"focusLeft",
	"focusRight",
	"togglePinned",
	"focusPinned",
	"nextMessage",
	"prevMessage",
]);

/** The actions a count in front of them means something for. */
const REPEATABLE = new Set<Action["kind"]>([
	"next",
	"prev",
	"nextMessage",
	"prevMessage",
	"scrollDown",
	"scrollUp",
	"toggleSelectNext",
	"nextAccount",
	"prevAccount",
]);

export function App() {
	const store = createAppStore();
	const keymap = new Keymap(store.settings().bindings);

	const [showHelp, setShowHelp] = createSignal(false);
	const [switching, setSwitching] = createSignal(false);
	const accountRows = () => accountKeys(store.accounts() ?? []);

	const configured = () => store.connection().baseUrl !== "";
	const composing = () => store.right().kind === "compose";
	/** Settings takes the whole pane; compose is pinned below the thread. */
	const fullPane = () => store.right().kind === "settings";

	// Custom bindings take effect as soon as settings are applied.
	createEffect(() => keymap.replace(store.settings().bindings));

	onMount(() => {
		document.addEventListener("keydown", onKeyDown);
		onCleanup(() => document.removeEventListener("keydown", onKeyDown));
	});

	/**
	 * Android hands its back gesture to the webview's history — `WryActivity`
	 * calls `goBack()` while `canGoBack()`, and closes the app when it cannot. A
	 * single-page client has no history, so back quit from inside a thread rather
	 * than returning to the list. The phone's panes *are* a stack: the list, with
	 * the sidebar or a thread laid over it, so one entry is enough to describe it.
	 */
	let pushed = false;

	createEffect(
		on(store.pane, (pane, previous) => {
			if (previous === undefined || pane === previous || !isNarrow()) return;

			if (pane !== "list" && !pushed) {
				pushed = true;
				history.pushState({ pane }, "");
			} else if (pane === "list" && pushed) {
				pushed = false;
				history.back();
			}
		}),
	);

	onMount(() => {
		const onPop = () => {
			pushed = false;
			store.setPane("list");
		};
		window.addEventListener("popstate", onPop);
		onCleanup(() => window.removeEventListener("popstate", onPop));
	});

	// The desktop shell supplies the server URL after the first render, so the
	// event stream has to follow the connection rather than be opened once.
	createEffect(() => {
		store.connection().baseUrl;
		const unsubscribe = store.subscribe();
		onCleanup(unsubscribe);
	});

	/**
	 * A `mailto:` handed to the app from outside it.
	 *
	 * Collected on mount, which covers being launched *by* a link, and again on
	 * focus, which covers one arriving while ecr was already running: following
	 * a link raises the window, so the focus event is the moment a URL is
	 * waiting. The shell yields each one exactly once, so this cannot reopen a
	 * draft the reader already dismissed.
	 */
	async function collectMailto() {
		const url = await takeLaunchMailto();
		if (!url) return;
		const draft = parseMailto(url);
		if (draft) store.composeDraft(draft, "compose");
	}

	onMount(() => {
		void collectMailto();
		const onFocus = () => void collectMailto();
		window.addEventListener("focus", onFocus);
		onCleanup(() => window.removeEventListener("focus", onFocus));
	});

	function onKeyDown(event: KeyboardEvent) {
		// Ctrl chords always reach the app, even mid-edit, so focus can leave an
		// open composer without discarding it — but only the ones that are about
		// leaving. See ESCAPE_HATCHES.
		if (event.ctrlKey && !event.metaKey && !event.altKey) {
			const outcome = keymap.handle(
				{ key: event.key, ctrl: true },
				"normal",
				false,
				store.pane(),
			);
			if (
				outcome.type === "action" &&
				(!isEditing(event.target) || ESCAPE_HATCHES.has(outcome.action.kind))
			) {
				event.preventDefault();
				void dispatch(outcome.action);
				return;
			}
		}

		// Otherwise the editor owns every key while it is open.
		if (composing() && store.pane() === "detail" && store.pinnedOpen()) return;

		// Settings covers the pane, so every binding behind it would act on a
		// thread nobody can see — but swallowing the lot took the way out with
		// it, and the page says `q` closes it. The key that closes the pane is
		// the one exception; a field with focus still owns its own typing.
		if (fullPane()) {
			if (isEditing(event.target)) return;

			const outcome = keymap.handle(
				{
					key: event.key,
					ctrl: event.ctrlKey,
					alt: event.altKey,
					meta: event.metaKey,
				},
				store.mode(),
				false,
				store.pane(),
			);
			store.setPendingKeys(keymap.sequence);

			if (outcome.type === "action" && outcome.action.kind === "closeRight") {
				event.preventDefault();
				closeRight();
			}
			return;
		}

		if (event.key === "Escape" && showHelp()) {
			event.preventDefault();
			setShowHelp(false);
			return;
		}

		// The switcher is one keystroke wide: while it is up, a letter it lists
		// is that account and nothing else. It is read before the keymap
		// deliberately — `m` is not bound to anything today, but a menu whose
		// keys can be shadowed by a future binding is a menu that lies.
		if (switching() && !isEditing(event.target)) {
			if (event.key === "Escape") {
				event.preventDefault();
				setSwitching(false);
				return;
			}
			const row = accountRows().find((r) => r.key === event.key);
			if (row) {
				event.preventDefault();
				setSwitching(false);
				store.selectAccount(row.id);
				return;
			}
		}

		// A range being drawn is abandoned by Escape. The keymap reports Escape in
		// normal mode as ignored, so it never reaches the cancelled branch below.
		if (event.key === "Escape" && store.visualAnchor() !== null) {
			event.preventDefault();
			store.clearVisual();
			return;
		}

		// With no range on screen, Escape clears what Space picked and what is
		// staged — but only in normal mode, where no palette is open and no
		// pending sequence waits. The keymap still owns those, and view mode's
		// own Escape handler stops propagation before this can run.
		if (
			event.key === "Escape" &&
			store.mode() === "normal" &&
			!isEditing(event.target) &&
			keymap.sequence === "" &&
			(store.picked().length > 0 || Object.keys(store.marks).length > 0)
		) {
			event.preventDefault();
			store.clearSelection();
			return;
		}

		const outcome = keymap.handle(
			{
				key: event.key,
				ctrl: event.ctrlKey,
				alt: event.altKey,
				meta: event.metaKey,
			},
			store.mode(),
			isEditing(event.target),
			store.pane(),
		);

		store.setPendingKeys(keymap.sequence);

		if (outcome.type === "cancelled") {
			event.preventDefault();
			if (showHelp()) setShowHelp(false);
			store.setMode("normal");
			store.setPalette("");
			store.clearVisual();
			if (isEditing(event.target)) (event.target as HTMLElement).blur();
			return;
		}

		if (outcome.type === "action") {
			event.preventDefault();
			void repeat(outcome.action, outcome.count);
		}
	}

	/**
	 * `4j` is four moves, and `4d` is one delete.
	 *
	 * A count means *do this again* only where doing it again means something.
	 * Staging a tag toggles, so four of them stage nothing at all; opening a
	 * thread four times opens it once and looks like a hang. The motions and
	 * the scrolls are the actions where repetition is the whole point, so they
	 * are the ones that honour it, and everything else quietly ignores the
	 * count rather than doing something surprising with it.
	 */
	async function repeat(action: Action, count?: number) {
		const times = count && REPEATABLE.has(action.kind) ? Math.min(count, 999) : 1;
		for (let i = 0; i < times; i++) await dispatch(action);
	}

	function threadMessages(): Message[] {
		return store.thread()?.messages ?? [];
	}

	/**
	 * The one way a composer opens — compose, reply, forward and a `mailto:`
	 * link all arrive here, which is why the signature goes in at this point
	 * rather than in each of them.
	 *
	 * It goes into the *text*, not onto the message at send time, so what is on
	 * screen is what is sent and one message can go without it by deleting it
	 * there. The address it belongs to is the one the draft names, falling back
	 * to whichever account the reply is being sent from.
	 */
	function openCompose(draft: Draft, label: string) {
		const from = draft.from ?? store.sendingAccount()?.address ?? undefined;
		const signed = {
			...draft,
			body: withSignature(draft.body, store.signature(from)),
		};

		store.setRight({ kind: "compose", draft: signed, label });
		store.setPinnedOpen(true);
		store.setPane("detail");
	}

	function closeRight() {
		store.setRight({ kind: "reading" });
		store.setMode("normal");
	}

	async function dispatch(action: Action) {
		const pane = store.pane();

		switch (action.kind) {
			case "focusLeft":
				store.focusPane(-1);
				break;
			case "focusRight":
				store.focusPane(1);
				break;

			case "togglePinned":
				store.setPinnedOpen(!store.pinnedOpen());
				break;
			case "focusPinned":
				if (composing()) {
					store.setPinnedOpen(true);
					store.setPane("detail");
				}
				break;

			case "next":
				if (pane === "sidebar") store.moveSidebar(1);
				else if (pane === "list") store.move(1);
				else store.focusMessage(1);
				break;
			case "prev":
				if (pane === "sidebar") store.moveSidebar(-1);
				else if (pane === "list") store.move(-1);
				else store.focusMessage(-1);
				break;
			case "first":
				if (pane === "sidebar") store.setSidebarIndex(0);
				else if (pane === "list") store.setSelected(0);
				else store.setMessageIndex(0);
				break;
			case "last":
				if (pane === "sidebar")
					store.setSidebarIndex(store.sidebarRows().length - 1);
				else if (pane === "list")
					store.setSelected(Math.max(store.items().length - 1, 0));
				else store.setMessageIndex(Math.max(threadMessages().length - 1, 0));
				break;

			case "select":
				// On a phone the sidebar *is* the screen, so picking a view has to hand
				// over to the list or the choice looks like it did nothing. Folding a
				// section stays put, and on a desktop all three panes are already up.
				if (store.activateSidebar() && isNarrow()) store.setPane("list");
				break;

			// Same rule as `select`, and for the same reason: `i` loaded the inbox,
			// so on a phone the inbox has to be what is on screen afterwards.
			// Opening a section is not a mailbox and stays where it is.
			case "jump":
				if (store.jumpSidebar(action.to) && isNarrow()) store.setPane("list");
				break;

			case "open": {
				const thread = store.current();
				if (thread) {
					store.setOpenThread(thread.id);
					store.leaveRightPane();
					store.setMessageIndex(0);
					store.setPane("detail");
				}
				break;
			}

			case "scrollDown":
				store.scrollPane(1, action.half);
				break;
			case "scrollUp":
				store.scrollPane(-1, action.half);
				break;

			case "nextMessage":
				store.focusMessage(1);
				break;
			case "prevMessage":
				store.focusMessage(-1);
				break;

			case "enterView": {
				// The cursor goes into the message under the conversation cursor, so
				// that message has to be showing.
				const messages = threadMessages();
				const message = messages[store.messageIndex()];
				if (!message) break;

				if (
					!store.messageOpen(
						message.id,
						store.messageIndex() === messages.length - 1,
					)
				) {
					store.toggleCollapsed(message.id, false);
				}
				store.setPane("detail");
				store.setViewing(true);
				break;
			}

			case "toggleFold": {
				if (pane === "sidebar") {
					store.activateSidebar();
					break;
				}
				const messages = threadMessages();
				const message = messages[store.messageIndex()];
				if (message) {
					store.toggleCollapsed(
						message.id,
						store.messageIndex() === messages.length - 1,
					);
				}
				break;
			}
			case "foldAll":
				store.setAllCollapsed(
					threadMessages().map((m) => m.id),
					true,
				);
				break;
			case "unfoldAll":
				store.setAllCollapsed(
					threadMessages().map((m) => m.id),
					false,
				);
				break;

			case "loadRemote":
				store.setAllowRemote(true);
				store.setStatus("remote images loaded");
				break;

			case "togglePlain": {
				const message = threadMessages()[store.messageIndex()];
				if (message) store.setStatus(store.toggleFormat(message.id));
				break;
			}

			// Straight through `setSettings`, never `withValue`: this one is
			// device-scoped, and routing a client-scoped change through the shared
			// file's text discards the very change being made.
			case "togglePreferHtml": {
				const settings = store.settings();
				const next = !settings.preferences.preferHtml;
				store.setSettings({
					...settings,
					preferences: { ...settings.preferences, preferHtml: next },
				});
				store.setStatus(next ? "html preferred" : "plain text preferred");
				break;
			}

			// What `s` does is ask the server to talk to the provider, which is
			// minutes of network for a reader who only wanted to see the row
			// that has just arrived. `r` asks the list again and nothing else.
			case "refresh":
				store.refreshList();
				store.setStatus("refreshed");
				break;

			case "switchAccount":
				setSwitching(true);
				break;

			case "archive":
				store.mark("archive");
				break;
			case "delete":
				store.mark("delete");
				break;
			case "toggleRead": {
				const thread = store.current();
				if (!thread) break;

				const unread = thread.tags.includes("unread");
				const count = await store.applyNow(
					unread ? [] : ["unread"],
					unread ? ["unread"] : [],
				);
				if (count > 0)
					store.setStatus(`${count} marked ${unread ? "read" : "unread"}`);
				break;
			}
			case "toggleFlag": {
				const thread = store.current();
				if (!thread) break;

				const flagged = thread.tags.includes("flagged");
				const count = await store.applyNow(
					flagged ? [] : ["flagged"],
					flagged ? ["flagged"] : [],
				);
				if (count > 0)
					store.setStatus(`${count} ${flagged ? "unflagged" : "flagged"}`);
				break;
			}
			case "executeMarks":
				await store.executeMarks();
				break;
			case "clearMarks":
				store.clearSelection();
				break;
			case "toggleSelect":
				store.toggleSelect();
				break;
			case "toggleSelectNext":
				store.toggleSelectNext();
				break;
			case "visualSelect":
				store.startVisual();
				break;
			case "tagPrompt":
				store.setMode("tag");
				store.setPalette("");
				break;
			case "sync":
				await store.sync();
				break;

			case "compose":
				openCompose(emptyDraft(), "compose");
				break;

			case "reply":
			case "forward": {
				// Replying from the list is the common case: the thread the cursor is
				// on has usually not been opened yet, so fetch it rather than telling
				// the user to press Enter first.
				let messages = threadMessages();
				if (messages.length === 0) {
					const selected = store.current();
					if (selected) {
						store.setStatus("loading thread…");
						const fetched = await store.api
							.thread(selected.id)
							.catch(() => null);
						messages = fetched?.messages ?? [];
						if (messages.length > 0) store.setOpenThread(selected.id);
					}
				}

				const message =
					messages[store.messageIndex()] ?? messages[messages.length - 1];
				if (!message) {
					store.setStatus("nothing to reply to");
					break;
				}
				const all =
					action.kind === "reply" &&
					(action.all || store.settings().preferences.replyAll);

				// The quote comes from the real body, so a reply has something to
				// answer against rather than just the subject line.
				const original = await store.api
					.body(message.id, false, false)
					.then((b) => b.content)
					.catch(() => "");

				openCompose(
					action.kind === "forward"
						? forwardDraft(message, original)
						: replyDraft(message, all, original),
					action.kind === "forward" ? "forward" : all ? "reply all" : "reply",
				);
				break;
			}

			case "nextAccount":
				store.cycleAccount(1);
				break;
			case "prevAccount":
				store.cycleAccount(-1);
				break;

			case "linkHints":
				store.setHinting(true);
				break;

			case "settings":
				store.setRight({ kind: "settings" });
				store.setPane("detail");
				break;

			case "closeRight":
				closeRight();
				break;

			case "toggleFullscreen":
				store.toggleFullscreen();
				break;

			case "enterCommand":
				store.setMode("command");
				break;
			case "saveQuery":
				// The command it would have been typed as, so the one grammar stays
				// the only way a query is saved. Only the name is left to type.
				store.setPalette("save ");
				store.setMode("command");
				break;
			case "enterSearch":
				// Prefilled with the mailbox's own query so it can be refined rather
				// than retyped. The palette selects it on open, so the first keystroke
				// still replaces — that selection is what makes prefilling safe.
				// The value goes in before the mode: opening is what the palette reads
				// the prefill on, so setting the mode first shows it an empty one.
				store.setPalette(store.query());
				store.setMode("search");
				break;
			case "help":
				setShowHelp(true);
				break;
		}
	}

	return (
		<Show when={configured()} fallback={<ConnectionSetup store={store} />}>
			<div class="chrome-sides relative flex h-full flex-col">
				<TopBar
					store={store}
					onSync={() => void store.sync()}
					onSettings={() => void dispatch({ kind: "settings" })}
				/>

				{/*
          Below `md` exactly one of these is shown, and which one is
          `store.pane()` — the same three names focus already moves between, so
          there is no second notion of where you are to drift from it.

          Between that width and `sidebarMinWidth` the same signal shows two:
          the list and the thread, which is the pairing the client is built
          around, with the sidebar laid over the list only while it has focus.
          `relative` is what the drawer and its scrim are positioned against.
        */}
				<main
					class="relative grid min-h-0 flex-1"
					classList={{
						"md:grid-cols-[14rem_minmax(0,1.05fr)_minmax(0,1.45fr)]":
							!store.fullscreen() && store.layout() === "three",
						"md:grid-cols-[minmax(0,1.05fr)_minmax(0,1.45fr)]":
							!store.fullscreen() && store.layout() === "two",
						"md:grid-cols-[minmax(0,1fr)]": store.fullscreen(),
					}}
				>
					{/*
            Taking the sidebar out of the flow is what leaves the other two
            columns where they were, so opening it does not reflow the mail
            behind it. The scrim is how a pointer closes it again: clicking the
            list would do it too — the drawer is only up while the sidebar has
            focus — but a row would take the click on its way past.
          */}
					<Show when={store.layout() === "two" && store.pane() === "sidebar"}>
						<div
							class="absolute inset-0 z-10 bg-black/30"
							aria-hidden="true"
							onClick={() => store.setPane("list")}
						/>
					</Show>

					<div
						class="min-h-0 min-w-0"
						classList={{
							hidden: store.pane() !== "sidebar",
							"md:block":
								!store.fullscreen() && store.layout() === "three",
							"absolute inset-y-0 left-0 z-20 w-56 shadow-2xl":
								store.layout() === "two",
						}}
					>
						<Sidebar
							store={store}
							onCompose={() => openCompose(emptyDraft(), "compose")}
							onSettings={() => void dispatch({ kind: "settings" })}
							onSwitchAccount={() => setSwitching(true)}
						/>
					</div>

					<div
						class="min-h-0 min-w-0"
						classList={{
							hidden: store.pane() !== "list",
							"md:block": !store.fullscreen(),
						}}
					>
						<ThreadList
							store={store}
							onCompose={() => openCompose(emptyDraft(), "compose")}
						/>
					</div>

					<div
						class="min-h-0 min-w-0"
						classList={{ hidden: store.pane() !== "detail", "md:block": true }}
					>
						<section
							class="pane h-full"
							classList={{ "pane-focused": store.pane() === "detail" }}
							/* On capture, for the same reason as the other two panes. */
							oncapture:click={() => store.setPane("detail")}
						>
							<Switch>
								<Match when={store.right().kind === "settings"}>
									<SettingsPane store={store} onClose={closeRight} />
								</Match>
								<Match when={true}>
									{/*
                    The thread stays mounted while composing, so a reply can be
                    written with the conversation still on screen and still
                    navigable. On a phone it is only *mounted*: 45% of a 354px
                    pane left the body one line tall, which is not a composer,
                    and three visible lines of the thread were not worth it.
                  */}
									<div
										class="flex min-h-0 flex-1 flex-col"
										classList={{
											"max-md:hidden": composing() && store.pinnedOpen(),
										}}
									>
										<ReadingPane
											store={store}
											onBack={() => {
												store.setPane("list");
											}}
										/>
									</div>

									<Show when={composing()}>
										{(() => {
											const right = store.right();
											if (right.kind !== "compose") return null;

											return (
												<Show
													when={store.pinnedOpen()}
													fallback={
														<button
															type="button"
															class="flex shrink-0 items-center gap-2 border-t border-obligation bg-paper-2 px-4 py-1.5 text-xs text-obligation"
															onClick={() => store.setPinnedOpen(true)}
														>
															▴ {right.label} minimised — <kbd>C-b</kbd> to show
														</button>
													}
												>
													<div class="flex flex-col border-t-2 border-obligation max-md:min-h-0 max-md:flex-1 md:h-[45%] md:shrink-0">
														<ComposePane
															store={store}
															draft={right.draft}
															label={right.label}
															onClose={closeRight}
														/>
													</div>
												</Show>
											);
										})()}
									</Show>
								</Match>
							</Switch>
						</section>
					</div>
				</main>

				<StatusBar store={store} />

				{/*
          A phone has no keys, so the strip that names the vim mode on a desktop
          carries the actions themselves. `md:hidden` lives on the bar itself,
          so the desktop is untouched.
        */}
				<ActionBar
					store={store}
					onCompose={() => openCompose(emptyDraft(), "compose")}
					onReply={(all) => void dispatch({ kind: "reply", all })}
					onSaveQuery={() => void dispatch({ kind: "saveQuery" })}
				/>

				<Palette store={store} />

				{/*
          Over everything, because a refused device has no working pane behind
          it to act on — including the palette and the help sheet.
        */}
				{/*
          Over everything, and ahead of the token prompt: an address that
          answers nothing cannot refuse a token either, so asking for one first
          would be asking the reader to fix the second problem before the first.
        */}
				<Show when={store.askingServer()}>
					<ServerAlert
						store={store}
						onClose={() => store.setAskingServer(false)}
					/>
				</Show>

				<Show when={store.askingToken() && !store.askingServer()}>
					<AuthAlert store={store} onClose={() => store.setAskingToken(false)} />
				</Show>

				<Show when={store.askingDoctor()}>
					<DoctorAlert
						store={store}
						onClose={() => store.setAskingDoctor(false)}
					/>
				</Show>

				<Show when={showHelp()}>
					<Help
						bindings={keymap.describe(store.pane())}
						pane={store.pane()}
						onClose={() => setShowHelp(false)}
					/>
				</Show>

				<Show when={switching()}>
					<AccountSwitcher
						rows={accountRows()}
						current={store.currentAccount()}
						onPick={(id) => {
							setSwitching(false);
							store.selectAccount(id);
						}}
						onClose={() => setSwitching(false)}
					/>
				</Show>
			</div>
		</Show>
	);
}

function replyDraft(message: Message, all: boolean, original: string): Draft {
	const to = (message.reply_to.length ? message.reply_to : message.from).map(
		(a) => a.email,
	);
	const quoted = quoteBody(original);

	return {
		to,
		cc: all
			? message.cc.map((a) => a.email).filter((e) => !to.includes(e))
			: [],
		bcc: [],
		subject: prefixed(message.subject, "Re:"),
		body: `\n\n${replyAttribution(message.date, message.from[0]?.email ?? null)}\n${quoted}\n`,
		in_reply_to: message.id,
		references: [...message.references, message.id],
		attachments: [],
	};
}

function forwardDraft(message: Message, original: string): Draft {
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

function prefixed(subject: string, prefix: string): string {
	const trimmed = subject.trim();
	return trimmed.toLowerCase().startsWith(prefix.toLowerCase())
		? trimmed
		: `${prefix} ${trimmed}`;
}
