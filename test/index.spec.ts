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
	normalizeNetwork,
	rankBazaarResources,
	usdcAssetForNetwork,
	type BazaarResource,
} from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("AgenticBuyer worker", () => {
	it("returns a healthy v0.6 response", async () => {
		const request = new IncomingRequest("http://example.com/health");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "ok",
			service: "AgenticBuyer",
			version: "0.6.0",
		});
	});

	it("exposes improved discovery capabilities", async () => {
		const response = await SELF.fetch("https://example.com/");
		const body = (await response.json()) as {
			version: string;
			capabilities: Record<string, boolean>;
		};

		expect(body.version).toBe("0.6.0");
		expect(body.capabilities.usdcAssetResolution).toBe(true);
		expect(body.capabilities.inventoryFallback).toBe(true);
		expect(body.capabilities.downstreamExecution).toBe(false);
	});
});

describe("network and USDC resolution", () => {
	it("normalizes Base network identifiers", () => {
		expect(normalizeNetwork("base")).toBe("eip155:8453");
		expect(normalizeNetwork("base-sepolia")).toBe("eip155:84532");
	});

	it("resolves official Base USDC contract addresses", () => {
		expect(usdcAssetForNetwork("base")).toBe(
			"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
		);
		expect(usdcAssetForNetwork("base-sepolia")).toBe(
			"0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		);
	});
});

describe("AgenticBuyer Bazaar routing", () => {
	it("uses an asset address instead of the invalid usdc alias", () => {
		const url = new URL(
			buildBazaarSearchUrl({
				query: "crypto news",
				budgetUsd: 1,
				network: "base",
				limit: 10,
			}),
		);

		expect(url.searchParams.get("network")).toBe("eip155:8453");
		expect(url.searchParams.get("asset")).toBe(
			"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
		);
		expect(url.searchParams.get("asset")).not.toBe("usdc");
		expect(url.searchParams.get("maxUsdPrice")).toBe("1");
	});

	it("can build a filter-only inventory fallback", () => {
		const url = new URL(
			buildBazaarSearchUrl({
				query: "crypto news",
				network: "base",
				limit: 20,
				includeQuery: false,
			}),
		);

		expect(url.searchParams.has("query")).toBe(false);
		expect(url.searchParams.get("network")).toBe("eip155:8453");
		expect(url.searchParams.get("limit")).toBe("20");
	});

	it("ranks text relevance, quality, and price", () => {
		const resources: BazaarResource[] = [
			{
				resource: "https://example.com/weather",
				description: "Weather forecast",
				accepts: [
					{
						network: "eip155:8453",
						asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
						amount: "10000",
					},
				],
			},
			{
				resource: "https://example.com/news",
				description: "Crypto news and market intelligence",
				accepts: [
					{
						network: "eip155:8453",
						asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
						amount: "20000",
					},
				],
				quality: { l30DaysTotalCalls: 1000, l30DaysUniquePayers: 100 },
			},
		];

		const ranked = rankBazaarResources(resources, 1, "crypto news", "base");
		expect(ranked[0]?.resource).toBe("https://example.com/news");
		expect(ranked[0]?.estimatedUsdPrice).toBe(0.02);
		expect(ranked[0]?.textRelevance).toBeGreaterThan(0);
	});

	it("enforces the requested budget", () => {
		const resources: BazaarResource[] = [
			{
				resource: "https://example.com/cheap",
				description: "Crypto news",
				accepts: [
					{
						network: "base",
						asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
						amount: "20000",
					},
				],
			},
			{
				resource: "https://example.com/expensive",
				description: "Crypto news",
				accepts: [
					{
						network: "eip155:8453",
						asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
						amount: "120000",
					},
				],
			},
		];

		const decision = decideCandidates(resources, 0.05, "crypto news", "base");
		expect(decision.selected?.resource).toBe("https://example.com/cheap");
		expect(decision.overBudgetAlternatives[0]?.budgetGapUsd).toBe(0.07);
	});
});