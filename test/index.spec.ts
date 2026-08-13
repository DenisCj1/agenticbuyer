import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, {
	buildBazaarSearchUrl,
	decideCandidates,
	rankBazaarResources,
	type BazaarResource,
} from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("AgenticBuyer worker", () => {
	it("returns a healthy v0.5 response", async () => {
		const request = new IncomingRequest("http://example.com/health");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "ok",
			service: "AgenticBuyer",
			version: "0.5.0",
		});
	});

	it("exposes the current routing capabilities", async () => {
		const response = await SELF.fetch("https://example.com/");
		const body = (await response.json()) as {
			name: string;
			version: string;
			capabilities: Record<string, boolean>;
		};

		expect(body.name).toBe("AgenticBuyer");
		expect(body.version).toBe("0.5.0");
		expect(body.capabilities.discovery).toBe(true);
		expect(body.capabilities.budgetEnforcement).toBe(true);
		expect(body.capabilities.overBudgetFallback).toBe(true);
		expect(body.capabilities.downstreamExecution).toBe(false);
	});
});

describe("AgenticBuyer Bazaar routing", () => {
	it("builds a strict budget-limited USDC search", () => {
		const url = new URL(
			buildBazaarSearchUrl({
				query: "weather forecast",
				budgetUsd: 0.05,
				network: "base",
				limit: 5,
			}),
		);

		expect(url.searchParams.get("query")).toBe("weather forecast");
		expect(url.searchParams.get("network")).toBe("base");
		expect(url.searchParams.get("asset")).toBe("usdc");
		expect(url.searchParams.get("maxUsdPrice")).toBe("0.05");
		expect(url.searchParams.get("limit")).toBe("5");
	});

	it("can build a market scan without a price ceiling", () => {
		const url = new URL(
			buildBazaarSearchUrl({
				query: "weather forecast",
				network: "base",
				limit: 10,
			}),
		);

		expect(url.searchParams.has("maxUsdPrice")).toBe(false);
		expect(url.searchParams.get("limit")).toBe("10");
	});

	it("ranks quality and price signals", () => {
		const resources: BazaarResource[] = [
			{
				resource: "https://example.com/expensive",
				accepts: [{ amount: "50000" }],
				quality: { l30DaysTotalCalls: 1, l30DaysUniquePayers: 1 },
			},
			{
				resource: "https://example.com/popular",
				accepts: [{ amount: "10000" }],
				quality: { l30DaysTotalCalls: 1000, l30DaysUniquePayers: 100 },
			},
		];

		const ranked = rankBazaarResources(resources, 0.05);
		expect(ranked[0]?.resource).toBe("https://example.com/popular");
		expect(ranked[0]?.estimatedUsdPrice).toBe(0.01);
	});

	it("selects an in-budget provider", () => {
		const resources: BazaarResource[] = [
			{
				resource: "https://example.com/one",
				accepts: [{ amount: "20000" }],
			},
			{
				resource: "https://example.com/two",
				accepts: [{ amount: "70000" }],
			},
		];

		const decision = decideCandidates(resources, 0.05);
		expect(decision.selected?.resource).toBe("https://example.com/one");
		expect(decision.overBudgetAlternatives[0]?.resource).toBe(
			"https://example.com/two",
		);
		expect(decision.overBudgetAlternatives[0]?.budgetGapUsd).toBe(0.02);
	});

	it("returns nearest over-budget options instead of a dead end", () => {
		const resources: BazaarResource[] = [
			{
				resource: "https://example.com/ten-cents",
				accepts: [{ amount: "100000" }],
			},
			{
				resource: "https://example.com/six-cents",
				accepts: [{ amount: "60000" }],
			},
		];

		const decision = decideCandidates(resources, 0.05);
		expect(decision.selected).toBeNull();
		expect(decision.overBudgetAlternatives[0]?.resource).toBe(
			"https://example.com/six-cents",
		);
		expect(decision.overBudgetAlternatives[0]?.budgetGapUsd).toBe(0.01);
	});
});