import { describe, expect, it } from "vitest";
import { defaultSettings } from "./schema";
import { toToml } from "./toml";

/**
 * The settings file is written here and read in two languages.
 *
 * This generator is the only one there is, so what it produces is checked in as
 * a file snapshot and the server uses that copy for both things it needs:
 * `crates/ecr-store/src/packages.rs` parses it in `packages_fixture.rs`, and
 * `ecr account` seeds a machine that has no settings file from it — which is why
 * it is `crates/ecr-store/settings/default.toml` and not a test fixture. Writing
 * a second generator in Rust would mean two files claiming to be the default,
 * drifting apart quietly.
 *
 * A change here that the server cannot read therefore fails one of the two
 * suites, rather than failing on somebody's machine as managed mode switching
 * itself off.
 *
 * `toMatchFileSnapshot` rather than `readFileSync` on purpose: the unit tests
 * carry no `@types/node`, and adding it would mean recomputing `pnpmDeps.hash`
 * in `nix/ecr.nix` for a test helper. Update it with `pnpm test -u`.
 */
const FIXTURE = "../../../../crates/ecr-store/settings/default.toml";

describe("the generated settings file", () => {
	it("is what the server's fixture holds", async () => {
		await expect(toToml(defaultSettings())).toMatchFileSnapshot(FIXTURE);
	});

	it("carries a package section per tool, with an explicit management", () => {
		const generated = toToml(defaultSettings());

		for (const id of ["notmuch", "mbsync", "msmtp"]) {
			expect(generated).toContain(`[packages.${id}]`);
		}
		expect(generated).toContain('management = "self"');
	});
});
