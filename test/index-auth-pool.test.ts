import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import OpenAIAuthPlugin from "../index.js";

const poolPath = join(tmpdir(), "opencode-openai-codex-auth-oauth-persist-test.json");

function cleanup(): void {
	if (existsSync(poolPath)) {
		rmSync(poolPath, { force: true });
	}
}

function createJwt(accountId: string, email: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
			email,
		}),
	).toString("base64url");
	return `${header}.${payload}.signature`;
}

describe("OAuth account pool persistence", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		cleanup();
		delete process.env.OPENAI_CODEX_ACCOUNTS_PATH;
	});

	it("persists account in pool from manual OAuth callback", async () => {
		process.env.OPENAI_CODEX_ACCOUNTS_PATH = poolPath;
		const accessToken = createJwt("account-2", "acc2@example.com");

		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					access_token: accessToken,
					refresh_token: "refresh-2",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const plugin = await OpenAIAuthPlugin({ client: {} as any } as any);
		const method = plugin.auth?.methods.find((entry) => entry.label.includes("Manual URL Paste"));
		expect(method).toBeDefined();
		const flow = await method!.authorize();
		const result = await flow.callback("manual-code");
		expect(result.type).toBe("success");

		expect(existsSync(poolPath)).toBe(true);
		const pool = JSON.parse(readFileSync(poolPath, "utf8")) as {
			accounts?: Array<{ accountId?: string; email?: string }>;
		};
		expect(pool.accounts?.length).toBe(1);
		expect(pool.accounts?.[0]?.accountId).toBe("account-2");
		expect(pool.accounts?.[0]?.email).toBe("acc2@example.com");
	});

	it("retries transient 5xx responses with bounded attempts", async () => {
		vi.useFakeTimers();
		process.env.OPENAI_CODEX_ACCOUNTS_PATH = poolPath;
		const accessToken = createJwt("account-retry", "retry@example.com");
		const auth = {
			type: "oauth",
			access: accessToken,
			refresh: "refresh-retry",
			expires: Date.now() + 60_000,
		} as const;

		const getAuth = vi.fn().mockResolvedValue(auth);
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("upstream busy", { status: 503 }))
			.mockResolvedValueOnce(new Response("still busy", { status: 502 }))
			.mockResolvedValueOnce(new Response("still failing", { status: 503 }));

		const plugin = await OpenAIAuthPlugin({
			client: { auth: { set: vi.fn() } } as any,
		} as any);
		const loaded = await plugin.auth!.loader(getAuth, {
			options: { accountSelectionStrategy: "sticky" },
		});

		const responsePromise = loaded.fetch("https://api.openai.com/v1/responses", {
			method: "GET",
		});
		await vi.runAllTimersAsync();
		const response = await responsePromise;

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(response.status).toBe(503);
	});
});
