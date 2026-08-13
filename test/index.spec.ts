import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, {
	buildBazaarSearchUrl,
	rankBazaarResources,
} from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("AgenticBuyer worker", () => {
	it("returns a healthy v0.4 response", async () => {
		const request = new IncomingRequest("http://example.com/health");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "ok",
			service: "AgenticBuyer",
			version: "0.4.0",
		});
	});

	it("exposes AgenticBuyer service metadata", async () => {
		const response = await SELF.fetch("https://example.com/");
		const body = (await response.json()) as {
			name: string;
			version: string;
			tools: { free: string[]; paid: string[] };
		};

		expect(body.name).toBe("AgenticBuyer");
		expect(body.version).toBe("0.4.0");
		expect(body.tools.free).toContain("buyer_ping");
		expect(body.tools.paid).toContain("buyer_quote");
	});
});

describe("AgenticBuyer Bazaar routing", () => {
	it("builds a budget-limited USDC Bazaar search", () => {
		const url = new URL(
			buildBazaarSearchUrl({
				query: "weather forecast",
				budgetUsd: 0.05,
				network: "base",
				limit: 50,
			}),
		);

		expect(url.searchParams.get("query")).toBe("weather forecast");
		expect(url.searchParams.get("network")).toBe("base");
		expect(url.searchParams.get("asset")).toBe("usdc");
		expect(url.searchParams.get("maxUsdPrice")).toBe("0.05");
		expect(url.searchParams.get("limit")).toBe("10");
	});

	it("scores active affordable providers above weaker candidates", () => {
		const ranked = rankBazaarResources(
			[
				{
					resource: "https://example.com/strong",
					accepts: [{ amount: "10000" }],
					quality: {
						l30DaysTotalCalls: 200,
						l30DaysUniquePayers: 50,
					},
				},
				{
					resource: "https://example.com/weak",
					accepts: [{ amount: "40000" }],
					quality: {
						l30DaysTotalCalls: 1,
						l30DaysUniquePayers: 1,
					},
				},
			],
			0.05,
		);

		expect(ranked[0]?.resource).toBe("https://example.com/strong");
		expect(ranked[0]?.estimatedUsdPrice).toBe(0.01);
		expect(ranked[0]?.agenticBuyerScore).toBeGreaterThan(
			ranked[1]?.agenticBuyerScore ?? 0,
		);
	});
});
