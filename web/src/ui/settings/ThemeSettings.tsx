import { For, Show } from "solid-js";
import type { AppStore } from "../../state/store";

/**
 * Picking one applies it immediately, on purpose: Tailwind v4 compiles every
 * utility to `var(--color-*)`, so writing the palette onto the document element
 * repaints the whole client. What is on screen is the theme rather than a
 * preview of it, and no component ever knows a theme exists.
 */
export function ThemeSettings(props: { store: AppStore }) {
	return (
		<div class="scroll-y flex-1 p-4">
			<p class="mb-4 max-w-2xl text-xs leading-relaxed text-ink-3">
				Picking one applies it now — the whole client is repainted from the
				file, so what you see is the theme rather than a preview of it. Each
				lives in <span class="mono text-ink-2">~/.config/ecr/themes/</span>;
				copy one and edit it to make your own, and it will appear here.
			</p>

			<For each={props.store.themeList() ?? []}>
				{(entry) => {
					const active = () =>
						props.store.settings().preferences.theme === entry.path;

					return (
						<button
							type="button"
							class="touch-target mb-2 flex w-full items-center gap-3 rounded border px-3 py-2 text-left"
							classList={{
								"border-obligation bg-obligation-bg": active(),
								"border-rule hover:bg-neutral-bg": !active(),
							}}
							aria-pressed={active()}
							onClick={() => {
								props.store.setTheme(entry.path);
								props.store.setStatus(`theme: ${entry.name}`);
							}}
						>
							<div class="min-w-0 flex-1">
								<div class="truncate-cell text-ink">{entry.name}</div>
								<div class="truncate-cell mono text-xs text-ink-3">
									{entry.path}
								</div>
							</div>
							<Show when={!entry.builtin}>
								<span class="label shrink-0 text-proved">yours</span>
							</Show>
							<Show when={active()}>
								<span class="shrink-0 text-obligation">●</span>
							</Show>
						</button>
					);
				}}
			</For>

			<Show when={(props.store.themeList() ?? []).length === 0}>
				<p class="text-xs text-ink-3">
					No themes yet — they are written when the server first answers.
				</p>
			</Show>
		</div>
	);
}
